#include "ceres/depth_kernel.hpp"
#include <cmath>

namespace ceres {
namespace {
__device__ float4 transform(const float* matrix, float4 point) {
    return make_float4(
        matrix[0] * point.x + matrix[4] * point.y + matrix[8] * point.z + matrix[12] * point.w,
        matrix[1] * point.x + matrix[5] * point.y + matrix[9] * point.z + matrix[13] * point.w,
        matrix[2] * point.x + matrix[6] * point.y + matrix[10] * point.z + matrix[14] * point.w,
        matrix[3] * point.x + matrix[7] * point.y + matrix[11] * point.z + matrix[15] * point.w);
}
__global__ void unproject(const uint16_t* depths, StereoPoint* output, DepthGpuConfig c) {
    const int i = int(blockIdx.x * blockDim.x + threadIdx.x);
    if (i >= c.width * c.height)
        return;
    output[i] = {};
    const float depth = float(depths[i]) * .001f;
    if (!depths[i] || depth < c.min_depth || depth > c.max_depth)
        return;
    const float u = (float(i % c.width) + .5f) / float(c.width);
    const float v = (float(i / c.width) + .5f) / float(c.height);
    auto view = transform(c.norm_view_from_norm_depth, make_float4(u, v, 0, 1));
    if (!isfinite(view.w) || fabsf(view.w) < 1e-7f)
        return;
    view.x /= view.w;
    view.y /= view.w;
    if (!isfinite(view.x) || !isfinite(view.y) || view.x < 0 || view.x > 1 || view.y < 0 ||
        view.y > 1)
        return;
    // Normalised WebXR view coordinates start at the top left. OpenGL NDC Y
    // points up. Use a finite point on the ray, including infinite-far projections.
    auto ray = transform(c.inverse_projection, make_float4(2 * view.x - 1, 1 - 2 * view.y, 0, 1));
    if (!isfinite(ray.w) || fabsf(ray.w) < 1e-7f)
        return;
    ray.x /= ray.w;
    ray.y /= ray.w;
    ray.z /= ray.w;
    if (!isfinite(ray.x) || !isfinite(ray.y) || !isfinite(ray.z) || ray.z >= -1e-7f)
        return;
    const float scale = depth / -ray.z;
    StereoPoint point{};
    point.x = ray.x * scale;
    point.y = ray.y * scale;
    point.z = -depth;
    if (!isfinite(point.x) || !isfinite(point.y))
        return;
    point.valid = 1;
    // Environment depth has no measured colour. The renderer colours geometry
    // from current view settings, independently of the acquisition range.
    point.a = 1;
    output[i] = point;
}
} // namespace
cudaError_t unproject_environment_depth(const uint16_t* millimetres, StereoPoint* points,
                                        const DepthGpuConfig& config, cudaStream_t stream) {
    if (!millimetres || !points || config.width <= 0 || config.height <= 0 || config.width > 256 ||
        config.height > 256 || !std::isfinite(config.min_depth) ||
        !std::isfinite(config.max_depth) || config.min_depth <= 0 ||
        config.max_depth <= config.min_depth)
        return cudaErrorInvalidValue;
    for (int i = 0; i < 16; ++i)
        if (!std::isfinite(config.inverse_projection[i]) ||
            !std::isfinite(config.norm_view_from_norm_depth[i]))
            return cudaErrorInvalidValue;
    unproject<<<(config.width * config.height + 255) / 256, 256, 0, stream>>>(millimetres, points,
                                                                              config);
    return cudaGetLastError();
}
} // namespace ceres
