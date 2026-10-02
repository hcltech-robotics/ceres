#include <metal_stdlib>
using namespace metal;

// 64-bit Morton keys are compared and moved, never used as atomic operands.
struct Record { ulong key; float value; uint ordinal; };
struct Sum { float hi, lo; uint count, reserved; };
struct SortPass { uint count, stride, width, reserved; };
struct ReducePass { uint count, stride; };

kernel void sort_records(device const Record* input [[buffer(0)]],
                         device Record* output [[buffer(1)]],
                         constant SortPass& pass [[buffer(2)]],
                         uint index [[thread_position_in_grid]]) {
    if (index >= pass.count) return;
    const Record a = input[index], b = input[index ^ pass.stride];
    const bool less = a.key < b.key || (a.key == b.key && a.ordinal < b.ordinal);
    const bool minimum = ((index & pass.width) == 0) == ((index & pass.stride) == 0);
    output[index] = less == minimum ? a : b;
}
kernel void initialise_sums(device const Record* records [[buffer(0)]],
                            device Sum* sums [[buffer(1)]],
                            constant uint& count [[buffer(2)]],
                            uint index [[thread_position_in_grid]]) {
    if (index >= count) return;
    const bool valid = records[index].key != ~ulong(0);
    sums[index] = {valid ? records[index].value : 0.0f, 0.0f, valid ? 1u : 0u, 0u};
}
// Inclusive segmented pairwise reduction. Dispatch boundaries order producers
// and consumers; no warp-width assumptions, global spinlocks, FP64 or 64-bit atomics.
// Compile without fast math so the compensation terms cannot be reassociated.
kernel void reduce_segments(device const Record* records [[buffer(0)]],
                            device const Sum* input [[buffer(1)]],
                            device Sum* output [[buffer(2)]],
                            constant ReducePass& pass [[buffer(3)]],
                            uint index [[thread_position_in_grid]]) {
    if (index >= pass.count) return;
    Sum a = input[index];
    if (index >= pass.stride && records[index].key == records[index - pass.stride].key) {
        const Sum b = input[index - pass.stride];
        const float sum = a.hi + b.hi;
        const float virtual_b = sum - a.hi;
        const float error = (a.hi - (sum - virtual_b)) + (b.hi - virtual_b);
        const float tail = (a.lo + b.lo) + error;
        const float hi = sum + tail;
        a = {hi, tail - (hi - sum), a.count + b.count, 0u};
    }
    output[index] = a;
}
