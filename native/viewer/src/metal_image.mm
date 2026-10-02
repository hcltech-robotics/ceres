#include "ceres/detail/metal_image.hpp"
#include <algorithm>
#include <stdexcept>

namespace ceres::detail {
static_assert(sizeof(ImageConversion) == 64);
MetalImageConversion::MetalImageConversion(id<MTLDevice> device, id<MTLLibrary> library)
    : device_(device) {
    if (!device || !library || library.device != device)
        throw std::invalid_argument("Image conversion requires a library for its Metal device");
    const auto function = [library newFunctionWithName:@"convert_nv12"];
    if (!function)
        throw std::runtime_error("Metal image conversion shader is missing");
    NSError* error = nil;
    pipeline_ = [device newComputePipelineStateWithFunction:function error:&error];
    if (!pipeline_)
        throw std::runtime_error(error ? error.localizedDescription.UTF8String
                                       : "Cannot create Metal image conversion pipeline");
}
void MetalImageConversion::encode(id<MTLCommandBuffer> command, id<MTLTexture> luma,
                                  id<MTLTexture> chroma, id<MTLTexture> output,
                                  const ImageConversion& c) const {
    if (!command || !luma || !chroma || !output || command.device != device_ ||
        luma.device != device_ || chroma.device != device_ || output.device != device_)
        throw std::invalid_argument("Image conversion resources must share one Metal device");
    if (c.width <= 0 || c.height <= 0 || (c.width & 1) || (c.height & 1) ||
        luma.width != NSUInteger(c.width) || luma.height != NSUInteger(c.height) ||
        chroma.width != NSUInteger(c.width / 2) || chroma.height != NSUInteger(c.height / 2) ||
        output.width != NSUInteger(c.width) || output.height != NSUInteger(c.height) ||
        luma.textureType != MTLTextureType2D || chroma.textureType != MTLTextureType2D ||
        output.textureType != MTLTextureType2D || luma.pixelFormat != MTLPixelFormatR8Unorm ||
        chroma.pixelFormat != MTLPixelFormatRG8Unorm ||
        output.pixelFormat != MTLPixelFormatRGBA8Unorm ||
        !(output.usage & MTLTextureUsageShaderWrite))
        throw std::invalid_argument("Image conversion requires matching NV12 and RGBA8 textures");
    id<MTLComputeCommandEncoder> encoder = [command computeCommandEncoder];
    if (!encoder)
        throw std::runtime_error("Cannot encode Metal image conversion");
    [encoder setComputePipelineState:pipeline_];
    [encoder setTexture:luma atIndex:0];
    [encoder setTexture:chroma atIndex:1];
    [encoder setTexture:output atIndex:2];
    [encoder setBytes:&c length:sizeof(c) atIndex:0];
    const auto width = std::min<NSUInteger>(16, pipeline_.maxTotalThreadsPerThreadgroup);
    const auto height = std::min<NSUInteger>(16, pipeline_.maxTotalThreadsPerThreadgroup / width);
    [encoder dispatchThreads:MTLSizeMake(c.width, c.height, 1)
        threadsPerThreadgroup:MTLSizeMake(width, height, 1)];
    [encoder endEncoding];
}
} // namespace ceres::detail
