#include "ceres/detail/metal_image.hpp"
#include "ceres/types.hpp"
#include "image_cases.hpp"
#include <cstring>
#include <fstream>
#include <iostream>

namespace {
struct Pixel {
    unsigned char x, y, z, w;
};
void require(bool value, const char* message) {
    if (!value)
        throw std::runtime_error(message);
}
} // namespace

int main(int argc, char** argv) {
    if (argc != 3) {
        std::cerr << "Usage: test_image_metal SHADERS.metallib REPORT.json\n";
        return 2;
    }
    ceres::Json report{{"passed", false}, {"backend", "METAL"}};
    try {
        @autoreleasepool {
            id<MTLDevice> device = MTLCreateSystemDefaultDevice();
            require(device != nil, "Metal is unavailable");
            report["gpu"] = device.name.UTF8String;
            NSError* error = nil;
            id<MTLLibrary> library = [device newLibraryWithURL:[NSURL fileURLWithPath:@(argv[1])]
                                                         error:&error];
            if (!library)
                throw std::runtime_error(error ? error.localizedDescription.UTF8String
                                               : "Cannot load Metal image shaders");
            ceres::detail::MetalImageConversion converter(device, library);
            id<MTLCommandQueue> queue = [device newCommandQueue];
            require(queue != nil, "Cannot create Metal image command queue");
            auto texture = [&](MTLPixelFormat format, NSUInteger width, NSUInteger height,
                               bool output) {
                auto description = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format
                                                                                      width:width
                                                                                     height:height
                                                                                  mipmapped:NO];
                description.storageMode = output ? MTLStorageModePrivate : MTLStorageModeShared;
                description.usage = output ? MTLTextureUsageShaderWrite | MTLTextureUsageShaderRead
                                           : MTLTextureUsageShaderRead;
                id<MTLTexture> result = [device newTextureWithDescriptor:description];
                require(result != nil, "Cannot allocate Metal image fixture texture");
                return result;
            };
            constexpr NSUInteger width = 8, height = 8, row_bytes = 256;
            const auto luma = texture(MTLPixelFormatR8Unorm, width, height, false);
            const auto chroma = texture(MTLPixelFormatRG8Unorm, width / 2, height / 2, false);
            const auto output = texture(MTLPixelFormatRGBA8Unorm, width, height, true);
            id<MTLBuffer> readback = [device newBufferWithLength:row_bytes * height
                                                         options:MTLResourceStorageModeShared];
            require(readback != nil, "Cannot allocate Metal image fixture readback");
            size_t conversions = 0;
            ceres::test::image_cases<Pixel>(
                [&](const auto& nv12, auto& rgba, const ImageConversion& config) {
                    [luma replaceRegion:MTLRegionMake2D(0, 0, width, height)
                            mipmapLevel:0
                              withBytes:nv12.data()
                            bytesPerRow:width];
                    [chroma replaceRegion:MTLRegionMake2D(0, 0, width / 2, height / 2)
                              mipmapLevel:0
                                withBytes:nv12.data() + width * height
                              bytesPerRow:width];
                    id<MTLCommandBuffer> command = [queue commandBuffer];
                    converter.encode(command, luma, chroma, output, config);
                    id<MTLBlitCommandEncoder> blit = [command blitCommandEncoder];
                    require(blit != nil, "Cannot encode image fixture readback");
                    [blit copyFromTexture:output
                                     sourceSlice:0
                                     sourceLevel:0
                                    sourceOrigin:MTLOriginMake(0, 0, 0)
                                      sourceSize:MTLSizeMake(width, height, 1)
                                        toBuffer:readback
                               destinationOffset:0
                          destinationBytesPerRow:row_bytes
                        destinationBytesPerImage:row_bytes * height];
                    [blit endEncoding];
                    [command commit];
                    [command waitUntilCompleted];
                    if (command.status != MTLCommandBufferStatusCompleted)
                        throw std::runtime_error(command.error
                                                     ? command.error.localizedDescription.UTF8String
                                                     : "Metal image conversion failed");
                    for (size_t row = 0; row < height; ++row)
                        std::memcpy(rgba.data() + row * width,
                                    static_cast<const char*>(readback.contents) + row * row_bytes,
                                    width * sizeof(Pixel));
                    ++conversions;
                });
            report["conversions"] = conversions;
            report["shared_cuda_assertions"] = true;
            report["passed"] = true;
        }
    } catch (const std::exception& error) {
        report["error"] = error.what();
    }
    std::ofstream(argv[2]) << report.dump(2) << '\n';
    std::cout << report.dump(2) << '\n';
    return report["passed"].get<bool>() ? 0 : 1;
}
