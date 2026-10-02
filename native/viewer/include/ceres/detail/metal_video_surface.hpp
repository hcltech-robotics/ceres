#pragma once
#include "ceres/video.hpp"
#include <CoreVideo/CoreVideo.h>
#import <Metal/Metal.h>
#include <array>
#include <mutex>
#include <stdexcept>
namespace ceres::detail {
// Shared by rendering and both camera decoders. Keep Objective-C out of video.hpp.
struct MetalVideoDevice final : VideoDeviceOwner {
    id<MTLDevice> device;
    CVMetalTextureCacheRef cache = nullptr;
    std::mutex mutex;
    MetalVideoDevice();
    ~MetalVideoDevice() override;
};
struct MetalVideoSurface final : VideoSurface {
    std::shared_ptr<MetalVideoDevice> owner;
    CVPixelBufferRef pixels = nullptr;
    std::array<CVMetalTextureRef, 2> planes{};
    MetalVideoSurface(std::shared_ptr<MetalVideoDevice> device, CVPixelBufferRef value);
    ~MetalVideoSurface() override;
    id<MTLTexture> texture(size_t plane) const {
        return CVMetalTextureGetTexture(planes.at(plane));
    }
};
inline const MetalVideoSurface& metal_surface(const GpuImage& image) {
    auto* surface = dynamic_cast<MetalVideoSurface*>(image.surface.get());
    if (!surface)
        throw std::invalid_argument("Expected a VideoToolbox pixel buffer");
    return *surface;
}
} // namespace ceres::detail
