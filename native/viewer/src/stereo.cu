#include "ceres/stereo_kernel.hpp"
#include <algorithm>
#include <cmath>
#include <cuda_runtime.h>
#include <stdexcept>

namespace ceres {
namespace {
constexpr unsigned invalid_census = 0xffffffffu;
constexpr int invalid_cost = 100000;

__device__ float3 rotate(const float* m, float3 v) {
    return make_float3(m[0] * v.x + m[1] * v.y + m[2] * v.z, m[3] * v.x + m[4] * v.y + m[5] * v.z,
                       m[6] * v.x + m[7] * v.y + m[8] * v.z);
}
__device__ float clamp_colour(float value) {
    return fminf(1.0f, fmaxf(0.0f, value / 255.0f));
}
__device__ float sample(const StereoNv12& input, float x, float y) {
    const int ix = int(x), iy = int(y), jx = min(ix + 1, input.width - 1),
              jy = min(iy + 1, input.height - 1);
    const float dx = x - ix, dy = y - iy;
    return (1 - dy) * ((1 - dx) * input.data[iy * input.pitch + ix] +
                       dx * input.data[iy * input.pitch + jx]) +
           dy * ((1 - dx) * input.data[jy * input.pitch + ix] +
                 dx * input.data[jy * input.pitch + jx]);
}
__device__ bool remap(const StereoGpuCamera& camera, float3 ray, float& x, float& y) {
    ray = rotate(camera.ray_to_camera, ray);
    if (ray.z >= -1e-8f)
        return false;
    const float nx = -ray.x / ray.z, ny = ray.y / ray.z, r2 = nx * nx + ny * ny;
    const auto* d = camera.distortion;
    const float k = 1 + d[0] * r2 + d[1] * r2 * r2 + d[4] * r2 * r2 * r2;
    x = camera.fx * (nx * k + 2 * d[2] * nx * ny + d[3] * (r2 + 2 * nx * nx)) + camera.cx;
    y = camera.fy * (ny * k + d[2] * (r2 + 2 * ny * ny) + 2 * d[3] * nx * ny) + camera.cy;
    if (camera.flip_x)
        x = camera.width - 1 - x;
    if (camera.flip_y)
        y = camera.height - 1 - y;
    return isfinite(x) && isfinite(y) && x >= 0 && y >= 0 && x <= camera.width - 1 &&
           y <= camera.height - 1;
}
__global__ void rectify(StereoNv12 left, StereoNv12 right, StereoGpuConfig c, float* left_y,
                        float* right_y, unsigned char* left_valid, unsigned char* right_valid,
                        float4* colours) {
    const int x = int(blockIdx.x * blockDim.x + threadIdx.x),
              y = int(blockIdx.y * blockDim.y + threadIdx.y);
    if (x >= c.width || y >= c.height)
        return;
    const int index = y * c.width + x;
    const float3 ray = make_float3((x - c.cx) / c.fx, -(y - c.cy) / c.fy, -1);
    float sx = 0, sy = 0;
    const bool lv = remap(c.left, ray, sx, sy);
    left_valid[index] = lv;
    left_y[index] = lv ? sample(left, sx, sy) : 0;
    colours[index] = make_float4(0, 0, 0, 0);
    if (lv) {
        const int ux = min(int(sx) / 2, (left.width - 1) / 2) * 2,
                  uy = min(int(sy) / 2, (left.height - 1) / 2);
        const auto* uv = left.data + left.pitch * left.height + uy * left.pitch + ux;
        const float u = float(uv[0]) - 128, v = float(uv[1]) - 128, yy = left_y[index];
        const float l = left.full_range ? yy : 1.16438356f * (yy - 16);
        const float rv = left.full_range ? (left.bt709 ? 1.5748f : 1.402f)
                                         : (left.bt709 ? 1.792741f : 1.596027f);
        const float gu = left.full_range ? (left.bt709 ? 0.187324f : 0.344136f)
                                         : (left.bt709 ? 0.213249f : 0.391762f);
        const float gv = left.full_range ? (left.bt709 ? 0.468124f : 0.714136f)
                                         : (left.bt709 ? 0.532909f : 0.812968f);
        const float bu = left.full_range ? (left.bt709 ? 1.8556f : 1.772f)
                                         : (left.bt709 ? 2.112402f : 2.017232f);
        colours[index] = make_float4(clamp_colour(l + rv * v), clamp_colour(l - gu * u - gv * v),
                                     clamp_colour(l + bu * u), 1);
    }
    const bool rv = remap(c.right, ray, sx, sy);
    right_valid[index] = rv;
    right_y[index] = rv ? sample(right, sx, sy) : 0;
}

__global__ void census(const float* luma, const unsigned char* valid, unsigned* output, int width,
                       int height, float texture_range) {
    const int x = int(blockIdx.x * blockDim.x + threadIdx.x),
              y = int(blockIdx.y * blockDim.y + threadIdx.y);
    if (x >= width || y >= height)
        return;
    const int index = y * width + x;
    output[index] = invalid_census;
    if (x < 2 || y < 2 || x + 2 >= width || y + 2 >= height)
        return;
    const float centre = luma[index];
    float low = centre, high = centre;
    unsigned bits = 0;
    for (int dy = -2; dy <= 2; ++dy) {
        for (int dx = -2; dx <= 2; ++dx) {
            const int at = (y + dy) * width + x + dx;
            if (!valid[at])
                return;
            const float value = luma[at];
            low = fminf(low, value);
            high = fmaxf(high, value);
            if (dx || dy)
                bits = (bits << 1) | unsigned(value < centre);
        }
    }
    if (high - low >= texture_range)
        output[index] = bits;
}

__device__ int matching_cost(const unsigned* a, const unsigned* b, int x, int bx, int y,
                             int width) {
    int cost = 0;
    for (int dy = -1; dy <= 1; ++dy) {
        for (int dx = -1; dx <= 1; ++dx) {
            const unsigned av = a[(y + dy) * width + x + dx], bv = b[(y + dy) * width + bx + dx];
            if (av == invalid_census || bv == invalid_census)
                return invalid_cost;
            cost += __popc(av ^ bv);
        }
    }
    return cost;
}

__global__ void match(const unsigned* a, const unsigned* b, float* output, StereoGpuConfig c,
                      int direction) {
    const int x = int(blockIdx.x * blockDim.x + threadIdx.x),
              y = int(blockIdx.y * blockDim.y + threadIdx.y);
    if (x >= c.width || y >= c.height)
        return;
    output[y * c.width + x] = 0;
    if (x < 3 || y < 3 || x + 3 >= c.width || y + 3 >= c.height ||
        a[y * c.width + x] == invalid_census)
        return;
    const int start = max(1, int(floorf(c.fx * c.baseline_metres / c.max_depth))),
              stop = min(c.max_disparity, int(ceilf(c.fx * c.baseline_metres / c.min_depth)));
    int costs[4] = {invalid_cost, invalid_cost, invalid_cost, invalid_cost};
    int disparities[4] = {-1000, -1000, -1000, -1000};
    int best = -1, best_cost = invalid_cost, before = invalid_cost, after = invalid_cost,
        previous = invalid_cost;
    for (int d = start; d <= stop; ++d) {
        const int bx = x + direction * d;
        const int cost =
            bx >= 3 && bx + 3 < c.width ? matching_cost(a, b, x, bx, y, c.width) : invalid_cost;
        if (cost < best_cost) {
            best = d;
            best_cost = cost;
            before = previous;
            after = invalid_cost;
        } else if (d == best + 1) {
            after = cost;
        }
        previous = cost;
        int insert = 4;
        for (int i = 0; i < 4; ++i) {
            if (cost < costs[i]) {
                insert = i;
                break;
            }
        }
        if (insert < 4) {
            for (int i = 3; i > insert; --i) {
                costs[i] = costs[i - 1];
                disparities[i] = disparities[i - 1];
            }
            costs[insert] = cost;
            disparities[insert] = d;
        }
    }
    if (best < 0)
        return;
    int second = invalid_cost;
    for (int i = 0; i < 4; ++i)
        if (abs(disparities[i] - best) > 1)
            second = min(second, costs[i]);
    if (second == invalid_cost || second - best_cost <= fmaxf(3.0f, best_cost * c.uniqueness))
        return;
    float d = float(best);
    if (before != invalid_cost && after != invalid_cost) {
        const float denominator = float(before + after - 2 * best_cost);
        if (denominator > 0)
            d += fminf(0.5f, fmaxf(-0.5f, 0.5f * (before - after) / denominator));
    }
    output[y * c.width + x] = d;
}

__global__ void points(const float* left, const float* right, const float4* colour,
                       StereoGpuConfig c, StereoPoint* output) {
    const int x = int(blockIdx.x * blockDim.x + threadIdx.x),
              y = int(blockIdx.y * blockDim.y + threadIdx.y);
    if (x >= c.width || y >= c.height)
        return;
    const int index = y * c.width + x;
    StereoPoint point{};
    const float d = left[index];
    const int rx = int(roundf(x - d));
    if (d > 0 && rx >= 0 && rx < c.width && right[y * c.width + rx] > 0 &&
        fabsf(d - right[y * c.width + rx]) <= c.consistency) {
        const float depth = c.fx * c.baseline_metres / d;
        if (isfinite(depth) && depth >= c.min_depth && depth <= c.max_depth) {
            const float3 p =
                rotate(c.rect_to_head,
                       make_float3((x - c.cx) * depth / c.fx, -(y - c.cy) * depth / c.fy, -depth));
            point.x = p.x + c.left_origin[0];
            point.y = p.y + c.left_origin[1];
            point.z = p.z + c.left_origin[2];
            point.valid = 1;
            point.r = colour[index].x;
            point.g = colour[index].y;
            point.b = colour[index].z;
            point.a = 1;
        }
    }
    output[index] = point;
}
void check(cudaError_t result) {
    if (result != cudaSuccess)
        throw std::runtime_error(cudaGetErrorString(result));
}
bool valid_input(const StereoNv12& input, const StereoGpuCamera& camera) {
    return input.data && input.width == camera.width && input.height == camera.height &&
           input.width >= 32 && input.height >= 32 && !(input.width % 2) && !(input.height % 2) &&
           input.pitch >= size_t(input.width);
}
bool valid_camera(const StereoGpuCamera& c) {
    if (!std::isfinite(c.fx) || !std::isfinite(c.fy) || c.fx <= 0 || c.fy <= 0 ||
        !std::isfinite(c.cx) || !std::isfinite(c.cy))
        return false;
    for (float value : c.distortion)
        if (!std::isfinite(value))
            return false;
    for (float value : c.ray_to_camera)
        if (!std::isfinite(value))
            return false;
    return true;
}
} // namespace

struct StereoGpuWorkspace::Impl {
    int width, height;
    float *left_y = nullptr, *right_y = nullptr, *left_d = nullptr, *right_d = nullptr;
    unsigned *left_census = nullptr, *right_census = nullptr;
    unsigned char *left_valid = nullptr, *right_valid = nullptr;
    float4* colours = nullptr;
    Impl(int w, int h) : width(w), height(h) {}
    ~Impl() {
        cudaFree(left_y);
        cudaFree(right_y);
        cudaFree(left_d);
        cudaFree(right_d);
        cudaFree(left_census);
        cudaFree(right_census);
        cudaFree(left_valid);
        cudaFree(right_valid);
        cudaFree(colours);
    }
};
StereoGpuWorkspace::StereoGpuWorkspace(int width, int height) {
    if (width < 32 || height < 32 || width > stereo_max_width || height > stereo_max_height)
        throw std::runtime_error("Stereo workspace exceeds its bounded dimensions");
    impl_ = std::make_unique<Impl>(width, height);
    const size_t pixels = size_t(width) * height;
    check(cudaMalloc(&impl_->left_y, pixels * sizeof(float)));
    check(cudaMalloc(&impl_->right_y, pixels * sizeof(float)));
    check(cudaMalloc(&impl_->left_d, pixels * sizeof(float)));
    check(cudaMalloc(&impl_->right_d, pixels * sizeof(float)));
    check(cudaMalloc(&impl_->left_census, pixels * sizeof(unsigned)));
    check(cudaMalloc(&impl_->right_census, pixels * sizeof(unsigned)));
    check(cudaMalloc(&impl_->left_valid, pixels));
    check(cudaMalloc(&impl_->right_valid, pixels));
    check(cudaMalloc(&impl_->colours, pixels * sizeof(float4)));
}
StereoGpuWorkspace::~StereoGpuWorkspace() = default;
size_t StereoGpuWorkspace::scratch_bytes() const {
    return size_t(impl_->width) * impl_->height *
           (4 * sizeof(float) + 2 * sizeof(unsigned) + 2 * sizeof(unsigned char) + sizeof(float4));
}
cudaError_t StereoGpuWorkspace::enqueue(const StereoNv12& left, const StereoNv12& right,
                                        const StereoGpuConfig& c, StereoPoint* output,
                                        cudaStream_t stream) {
    if (!output || c.width != impl_->width || c.height != impl_->height || !stream ||
        !valid_input(left, c.left) || !valid_input(right, c.right) || !valid_camera(c.left) ||
        !valid_camera(c.right) || !std::isfinite(c.fx) || !std::isfinite(c.fy) || c.fx <= 0 ||
        c.fy <= 0 || !std::isfinite(c.cx) || !std::isfinite(c.cy) ||
        !std::isfinite(c.baseline_metres) || c.baseline_metres < 0.01f ||
        c.baseline_metres > 0.4f || !std::isfinite(c.min_depth) || !std::isfinite(c.max_depth) ||
        c.min_depth <= 0 || c.max_depth <= c.min_depth || c.max_disparity < 4 ||
        c.max_disparity > stereo_max_disparity || !std::isfinite(c.uniqueness) ||
        c.uniqueness < 0 || !std::isfinite(c.consistency) || c.consistency < 0 ||
        !std::isfinite(c.texture_range) || c.texture_range <= 0)
        return cudaErrorInvalidValue;
    for (float value : c.rect_to_head)
        if (!std::isfinite(value))
            return cudaErrorInvalidValue;
    for (float value : c.left_origin)
        if (!std::isfinite(value))
            return cudaErrorInvalidValue;
    const dim3 block(16, 16), grid((c.width + 15) / 16, (c.height + 15) / 16);
    rectify<<<grid, block, 0, stream>>>(left, right, c, impl_->left_y, impl_->right_y,
                                        impl_->left_valid, impl_->right_valid, impl_->colours);
    auto result = cudaGetLastError();
    if (result != cudaSuccess)
        return result;
    census<<<grid, block, 0, stream>>>(impl_->left_y, impl_->left_valid, impl_->left_census,
                                       c.width, c.height, c.texture_range);
    result = cudaGetLastError();
    if (result != cudaSuccess)
        return result;
    census<<<grid, block, 0, stream>>>(impl_->right_y, impl_->right_valid, impl_->right_census,
                                       c.width, c.height, c.texture_range);
    result = cudaGetLastError();
    if (result != cudaSuccess)
        return result;
    match<<<grid, block, 0, stream>>>(impl_->left_census, impl_->right_census, impl_->left_d, c,
                                      -1);
    result = cudaGetLastError();
    if (result != cudaSuccess)
        return result;
    match<<<grid, block, 0, stream>>>(impl_->right_census, impl_->left_census, impl_->right_d, c,
                                      1);
    result = cudaGetLastError();
    if (result != cudaSuccess)
        return result;
    points<<<grid, block, 0, stream>>>(impl_->left_d, impl_->right_d, impl_->colours, c, output);
    return cudaGetLastError();
}
} // namespace ceres
