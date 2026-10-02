#import <Metal/Metal.h>
#include "ceres/types.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <stdexcept>
#include <vector>

struct Record {
    uint64_t key;
    float value;
    uint32_t ordinal;
};
struct Sum {
    float hi, lo;
    uint32_t count, reserved;
};
static_assert(sizeof(Record) == 16 && sizeof(Sum) == 16);
void require(bool value, const char* message) {
    if (!value)
        throw std::runtime_error(message);
}
int main(int argc, char** argv) {
    if (argc != 3) {
        std::cerr << "Usage: test_metal_reduction SHADERS.metallib REPORT.json\n";
        return 2;
    }
    ceres::Json report{{"passed", false}};
    try {
        @autoreleasepool {
            id<MTLDevice> device = MTLCreateSystemDefaultDevice();
            require(device != nil, "Metal is unavailable; run this probe on an Apple Silicon Mac");
            report["gpu"] = device.name.UTF8String;
            report["unified_memory"] = bool(device.hasUnifiedMemory);
            NSError* error = nil;
            id<MTLLibrary> library = [device newLibraryWithURL:[NSURL fileURLWithPath:@(argv[1])]
                                                         error:&error];
            if (!library)
                throw std::runtime_error(error ? error.localizedDescription.UTF8String
                                               : "Cannot load Metal probe shaders");
            auto pipeline = [&](NSString* name) {
                NSError* failure = nil;
                id<MTLComputePipelineState> result =
                    [device newComputePipelineStateWithFunction:[library newFunctionWithName:name]
                                                          error:&failure];
                if (!result)
                    throw std::runtime_error(failure ? failure.localizedDescription.UTF8String
                                                     : "Cannot create Metal pipeline");
                return result;
            };
            const auto sorting = pipeline(@"sort_records"),
                       initialise = pipeline(@"initialise_sums"),
                       reduce = pipeline(@"reduce_segments");
            id<MTLCommandQueue> queue = [device newCommandQueue];
            require(queue != nil, "Cannot create Metal command queue");
            constexpr uint32_t count = 262144;
            std::vector<Record> records(count);
            std::map<uint64_t, std::pair<double, uint32_t>> expected;
            for (uint32_t i = 0; i < count - 17; ++i) {
                const uint64_t key = (uint64_t((i * 2654435761u) % 4093) << 32) | 0x80000001u;
                const float value = i % 4 == 0   ? 10000000.f
                                    : i % 4 == 1 ? 1.f
                                    : i % 4 == 2 ? -10000000.f
                                                 : .125f;
                records[i] = {key, value, i};
                expected[key].first += double(value);
                ++expected[key].second;
            }
            for (uint32_t i = count - 17; i < count; ++i)
                records[i] = {UINT64_MAX, 0.f, i};
            id<MTLBuffer> upload = [device newBufferWithBytes:records.data()
                                                       length:records.size() * sizeof(Record)
                                                      options:MTLResourceStorageModeShared];
            id<MTLBuffer> a = [device newBufferWithLength:count * sizeof(Record)
                                                  options:MTLResourceStorageModePrivate];
            id<MTLBuffer> b = [device newBufferWithLength:a.length
                                                  options:MTLResourceStorageModePrivate];
            id<MTLBuffer> sums_a = [device newBufferWithLength:count * sizeof(Sum)
                                                       options:MTLResourceStorageModePrivate];
            id<MTLBuffer> sums_b = [device newBufferWithLength:sums_a.length
                                                       options:MTLResourceStorageModePrivate];
            id<MTLBuffer> readback = [device newBufferWithLength:a.length + sums_a.length
                                                         options:MTLResourceStorageModeShared];
            require(upload && a && b && sums_a && sums_b && readback, "Metal allocation failed");
            auto dispatch = [&](id<MTLComputeCommandEncoder> encoder,
                                id<MTLComputePipelineState> state) {
                [encoder setComputePipelineState:state];
                [encoder dispatchThreads:MTLSizeMake(count, 1, 1)
                    threadsPerThreadgroup:MTLSizeMake(std::min<NSUInteger>(
                                                          256, state.maxTotalThreadsPerThreadgroup),
                                                      1, 1)];
                [encoder endEncoding];
            };
            id<MTLCommandBuffer> command = [queue commandBuffer];
            require(command != nil, "Cannot create Metal command buffer");
            id<MTLBlitCommandEncoder> blit = [command blitCommandEncoder];
            [blit copyFromBuffer:upload
                     sourceOffset:0
                         toBuffer:a
                destinationOffset:0
                             size:a.length];
            [blit endEncoding];
            for (uint32_t width = 2; width <= count; width <<= 1) {
                for (uint32_t stride = width >> 1; stride; stride >>= 1) {
                    id<MTLComputeCommandEncoder> encoder = [command computeCommandEncoder];
                    const uint32_t parameters[]{count, stride, width, 0};
                    [encoder setBuffer:a offset:0 atIndex:0];
                    [encoder setBuffer:b offset:0 atIndex:1];
                    [encoder setBytes:parameters length:sizeof(parameters) atIndex:2];
                    dispatch(encoder, sorting);
                    std::swap(a, b);
                }
            }
            id<MTLComputeCommandEncoder> encoder = [command computeCommandEncoder];
            [encoder setBuffer:a offset:0 atIndex:0];
            [encoder setBuffer:sums_a offset:0 atIndex:1];
            [encoder setBytes:&count length:sizeof(count) atIndex:2];
            dispatch(encoder, initialise);
            for (uint32_t stride = 1; stride < count; stride <<= 1) {
                encoder = [command computeCommandEncoder];
                const uint32_t parameters[]{count, stride};
                [encoder setBuffer:a offset:0 atIndex:0];
                [encoder setBuffer:sums_a offset:0 atIndex:1];
                [encoder setBuffer:sums_b offset:0 atIndex:2];
                [encoder setBytes:parameters length:sizeof(parameters) atIndex:3];
                dispatch(encoder, reduce);
                std::swap(sums_a, sums_b);
            }
            blit = [command blitCommandEncoder];
            [blit copyFromBuffer:a
                     sourceOffset:0
                         toBuffer:readback
                destinationOffset:0
                             size:a.length];
            [blit copyFromBuffer:sums_a
                     sourceOffset:0
                         toBuffer:readback
                destinationOffset:a.length
                             size:sums_a.length];
            [blit endEncoding];
            [command commit];
            [command waitUntilCompleted];
            if (command.status != MTLCommandBufferStatusCompleted)
                throw std::runtime_error(command.error.localizedDescription.UTF8String);
            const auto* sorted = static_cast<const Record*>(readback.contents);
            const auto* sums = reinterpret_cast<const Sum*>(
                static_cast<const char*>(readback.contents) + a.length);
            uint32_t groups = 0;
            for (uint32_t i = 0; i < count; ++i) {
                if (i)
                    require(sorted[i - 1].key <= sorted[i].key, "Morton keys are not sorted");
                if (sorted[i].key == UINT64_MAX) {
                    require(sums[i].count == 0, "Padding created evidence");
                    continue;
                }
                require(sorted[i].ordinal < records.size() &&
                            sorted[i].key == records[sorted[i].ordinal].key &&
                            sorted[i].value == records[sorted[i].ordinal].value,
                        "Sorting changed an observation's identity or value");
                if (i && sorted[i - 1].key == sorted[i].key)
                    require(sorted[i - 1].ordinal < sorted[i].ordinal,
                            "Sorting duplicated or reordered an observation");
                if (i + 1 < count && sorted[i].key == sorted[i + 1].key)
                    continue;
                const auto reference = expected.at(sorted[i].key);
                require(sums[i].count == reference.second, "Reduction changed evidence counts");
                require(std::abs((double(sums[i].hi) + sums[i].lo) - reference.first) <= .000001,
                        "Compensated GPU reduction differs from FP64 reference");
                ++groups;
            }
            require(groups == expected.size(), "Reduction lost a spatial key");
            report["records"] = count;
            report["groups"] = groups;
            report["gpu_ms"] = (command.GPUEndTime - command.GPUStartTime) * 1000.;
            report["device_working_bytes"] = a.length + b.length + sums_a.length + sums_b.length;
            report["working_bytes"] = a.length + b.length + sums_a.length + sums_b.length +
                                      upload.length + readback.length;
            report["passed"] = true;
        }
    } catch (const std::exception& error) {
        report["error"] = error.what();
    }
    std::ofstream(argv[2]) << report.dump(2) << '\n';
    std::cout << report.dump(2) << '\n';
    return report["passed"].get<bool>() ? 0 : 1;
}
