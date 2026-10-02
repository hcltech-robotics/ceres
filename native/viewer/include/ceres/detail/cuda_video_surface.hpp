#pragma once
#include "ceres/video.hpp"
#include <cuda.h>
#include <stdexcept>
namespace ceres::detail {
struct CudaContextOwner;
VideoDevice cuda_video_device(int ordinal);
struct CudaVideoSurface final : VideoSurface {
    CUdeviceptr data = 0;
    size_t pitch = 0;
    CUcontext context = nullptr;
    std::shared_ptr<CudaContextOwner> context_owner;
    ~CudaVideoSurface() override;
};
inline CudaVideoSurface& cuda_surface(const GpuImage& image) {
    auto* surface = dynamic_cast<CudaVideoSurface*>(image.surface.get());
    if (!surface)
        throw std::invalid_argument("Expected a CUDA video surface");
    return *surface;
}
} // namespace ceres::detail
