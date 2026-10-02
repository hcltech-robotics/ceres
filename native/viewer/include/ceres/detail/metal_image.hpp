#pragma once
#include "ceres/image_conversion.hpp"
#import <Metal/Metal.h>

namespace ceres::detail {
// Encodes conversion without waiting or reading pixels back to the CPU. The
// caller retains input frame leases and textures until command completion.
class MetalImageConversion {
    id<MTLDevice> device_;
    id<MTLComputePipelineState> pipeline_;

  public:
    MetalImageConversion(id<MTLDevice> device, id<MTLLibrary> library);
    void encode(id<MTLCommandBuffer> command, id<MTLTexture> luma, id<MTLTexture> chroma,
                id<MTLTexture> output, const ImageConversion& config) const;
};
} // namespace ceres::detail
