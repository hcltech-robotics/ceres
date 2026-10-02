#pragma once
#include "ceres/video.hpp"
#include <CoreVideo/CoreVideo.h>
#include <stdexcept>
namespace ceres::detail {
struct MetalVideoSurface final : VideoSurface {
    CVPixelBufferRef pixels = nullptr;
    explicit MetalVideoSurface(CVPixelBufferRef value) : pixels(CVPixelBufferRetain(value)) {}
    ~MetalVideoSurface() override {
        CVPixelBufferRelease(pixels);
    }
};
inline CVPixelBufferRef metal_pixels(const GpuImage& image) {
    auto* surface = dynamic_cast<MetalVideoSurface*>(image.surface.get());
    if (!surface)
        throw std::invalid_argument("Expected a VideoToolbox pixel buffer");
    return surface->pixels;
}
} // namespace ceres::detail
