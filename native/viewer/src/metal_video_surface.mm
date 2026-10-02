#include "ceres/detail/metal_video_surface.hpp"

namespace ceres::detail {
MetalVideoDevice::MetalVideoDevice() : device(MTLCreateSystemDefaultDevice()) {
    if (!device)
        throw std::runtime_error("No Metal device is available");
    if (CVMetalTextureCacheCreate(kCFAllocatorDefault, nullptr, device, nullptr, &cache) !=
        kCVReturnSuccess)
        throw std::runtime_error("Cannot create the Metal video texture cache");
}
MetalVideoDevice::~MetalVideoDevice() {
    if (cache)
        CFRelease(cache);
}
MetalVideoSurface::MetalVideoSurface(std::shared_ptr<MetalVideoDevice> device,
                                     CVPixelBufferRef value)
    : owner(std::move(device)), pixels(CVPixelBufferRetain(value)) {
    // A CVMetalTexture must outlive all GPU consumers, as must its pixel buffer.
    // The frame lease owns both planes and the cache/device that created them.
    try {
        const auto format = CVPixelBufferGetPixelFormatType(pixels);
        if ((format != kCVPixelFormatType_420YpCbCr8BiPlanarFullRange &&
             format != kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange) ||
            CVPixelBufferGetPlaneCount(pixels) != 2)
            throw std::runtime_error("Decoder did not produce NV12 video");
        std::lock_guard lock(owner->mutex);
        for (size_t plane = 0; plane != planes.size(); ++plane) {
            const auto status = CVMetalTextureCacheCreateTextureFromImage(
                kCFAllocatorDefault, owner->cache, pixels, nullptr,
                plane ? MTLPixelFormatRG8Unorm : MTLPixelFormatR8Unorm,
                CVPixelBufferGetWidthOfPlane(pixels, plane),
                CVPixelBufferGetHeightOfPlane(pixels, plane), plane, &planes[plane]);
            if (status != kCVReturnSuccess || !planes[plane] || !texture(plane))
                throw std::runtime_error("Cannot expose decoded NV12 to Metal (CoreVideo status " +
                                         std::to_string(status) + ")");
        }
    } catch (...) {
        for (auto plane : planes)
            if (plane)
                CFRelease(plane);
        CVPixelBufferRelease(pixels);
        throw;
    }
}
MetalVideoSurface::~MetalVideoSurface() {
    for (auto plane : planes)
        if (plane)
            CFRelease(plane);
    CVPixelBufferRelease(pixels);
}
} // namespace ceres::detail
