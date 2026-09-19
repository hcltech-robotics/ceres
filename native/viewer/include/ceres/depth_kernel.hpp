#pragma once
#include "stereo_config.hpp"
#include <cuda_runtime_api.h>
#include <cstdint>

namespace ceres {
struct DepthGpuConfig {
    int width = 0, height = 0;
    float min_depth = .2f, max_depth = 5.f;
    float inverse_projection[16]{};
    float norm_view_from_norm_depth[16]{};
};
// WebXR depth is axial distance from the view plane, in metres. Input rows
// follow depth-buffer coordinates. The supplied transform accounts for image
// rotation, cropping and mirroring before projection into the WebXR view.
cudaError_t unproject_environment_depth(const uint16_t* millimetres, StereoPoint* points,
                                        const DepthGpuConfig& config, cudaStream_t stream);
} // namespace ceres
