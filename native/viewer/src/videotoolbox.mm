#include "ceres/detail/video_backend.hpp"
#include "ceres/detail/h264_sample.hpp"
#include "ceres/detail/metal_video_surface.hpp"
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <VideoToolbox/VideoToolbox.h>
#include <algorithm>
#include <array>
#include <deque>
#include <mutex>
#include <utility>

namespace ceres::detail {
namespace {
void check(OSStatus status, const char* operation) {
    if (status != noErr)
        throw std::runtime_error(std::string(operation) + " (VideoToolbox status " +
                                 std::to_string(status) + ")");
}
template <class T> struct CFHandle {
    T value = nullptr;
    ~CFHandle() {
        if (value)
            CFRelease(value);
    }
    CFHandle() = default;
    CFHandle(const CFHandle&) = delete;
    CFHandle& operator=(const CFHandle&) = delete;
};
class VideoToolboxDecoder final : public DecoderBackend {
    struct Output {
        int64_t serial;
        OSStatus status;
        CVPixelBufferRef pixels;
    };
    PresentDecoded present;
    VTDecompressionSessionRef session = nullptr;
    CMVideoFormatDescriptionRef format = nullptr;
    std::vector<uint8_t> sps, pps;
    std::mutex mutex;
    std::deque<Output> outputs;
    size_t inflight = 0;
    OSStatus callback_error = noErr;
    std::array<std::weak_ptr<GpuImage>, 4> leases;
    std::shared_ptr<MetalVideoDevice> metal;
    std::string gpu;

    static void output(void* opaque, void* frame, OSStatus status, VTDecodeInfoFlags,
                       CVImageBufferRef image, CMTime, CMTime) noexcept {
        auto& self = *static_cast<VideoToolboxDecoder*>(opaque);
        std::lock_guard lock(self.mutex);
        try {
            self.outputs.push_back({int64_t(reinterpret_cast<intptr_t>(frame)), status, image});
            if (image)
                CVPixelBufferRetain(image);
        } catch (...) {
            self.callback_error = kCVReturnAllocationFailed;
        }
    }
    void destroy_session() {
        if (session) {
            VTDecompressionSessionWaitForAsynchronousFrames(session);
            VTDecompressionSessionInvalidate(session);
            CFRelease(session);
            session = nullptr;
        }
        if (format)
            CFRelease(std::exchange(format, nullptr));
    }
    void create_session() {
        destroy_session();
        const uint8_t* parameters[]{sps.data(), pps.data()};
        const size_t sizes[]{sps.size(), pps.size()};
        check(CMVideoFormatDescriptionCreateFromH264ParameterSets(kCFAllocatorDefault, 2,
                                                                  parameters, sizes, 4, &format),
              "Read H.264 parameter sets");
        const auto dimensions = CMVideoFormatDescriptionGetDimensions(format);
        if (dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width > 8192 ||
            dimensions.height > 8192 || (dimensions.width & 1) || (dimensions.height & 1))
            throw std::runtime_error("Invalid decoded video dimensions");
        const auto full =
            CMFormatDescriptionGetExtension(format, kCMFormatDescriptionExtension_FullRangeVideo);
        const bool full_range = full && CFEqual(full, kCFBooleanTrue);
        NSDictionary* decoder = @{
            (__bridge NSString*)
            kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder : @YES
        };
        NSDictionary* attributes = @{
            (__bridge NSString*)kCVPixelBufferPixelFormatTypeKey :
                @(full_range ? kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
                             : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange),
            (__bridge NSString*)kCVPixelBufferMetalCompatibilityKey : @YES,
            (__bridge NSString*)kCVPixelBufferIOSurfacePropertiesKey : @{}
        };
        VTDecompressionOutputCallbackRecord callback{output, this};
        check(VTDecompressionSessionCreate(
                  kCFAllocatorDefault, format, (__bridge CFDictionaryRef)decoder,
                  (__bridge CFDictionaryRef)attributes, &callback, &session),
              "Create hardware H.264 decoder");
        CFHandle<CFTypeRef> hardware;
        check(VTSessionCopyProperty(
                  session, kVTDecompressionPropertyKey_UsingHardwareAcceleratedVideoDecoder,
                  kCFAllocatorDefault, &hardware.value),
              "Check hardware decoder");
        if (!hardware.value || !CFEqual(hardware.value, kCFBooleanTrue))
            throw std::runtime_error("Hardware H.264 decoding is unavailable");
        VTSessionSetProperty(session, kVTDecompressionPropertyKey_RealTime, kCFBooleanTrue);
    }

  public:
    VideoToolboxDecoder(VideoDevice device, PresentDecoded callback)
        : present(std::move(callback)) {
        if (device.api != GraphicsApi::metal)
            throw std::invalid_argument("VideoToolbox requires the Metal graphics backend");
        @autoreleasepool {
            metal = device.owner ? std::dynamic_pointer_cast<MetalVideoDevice>(device.owner)
                                 : std::make_shared<MetalVideoDevice>();
            if (!metal)
                throw std::invalid_argument("Video device owner is not a Metal device");
            gpu = metal->device.name.UTF8String;
        }
    }
    ~VideoToolboxDecoder() override {
        reset();
    }
    const char* name() const override {
        return "VideoToolbox";
    }
    std::string device_name() const override {
        return gpu;
    }
    void reset() override {
        destroy_session();
        std::lock_guard lock(mutex);
        for (auto& output : outputs)
            if (output.pixels)
                CVPixelBufferRelease(output.pixels);
        outputs.clear();
        inflight = 0;
        callback_error = noErr;
        sps.clear();
        pps.clear();
        // Outstanding consumers own their pixel buffers independently of the session.
        leases = {};
    }
    bool submit(std::span<const uint8_t> bytes, int64_t serial) override {
        @autoreleasepool {
            if (inflight >= 4)
                return false;
            auto sample = h264_sample(bytes);
            const bool changed = (!sample.sps.empty() && sample.sps != sps) ||
                                 (!sample.pps.empty() && sample.pps != pps);
            if (changed && inflight)
                return false;
            if (!sample.sps.empty())
                sps = std::move(sample.sps);
            if (!sample.pps.empty())
                pps = std::move(sample.pps);
            if (!session || changed) {
                if (!sample.idr || sps.empty() || pps.empty())
                    throw std::runtime_error("H.264 decoder requires an IDR with SPS and PPS");
                create_session();
            }
            CFHandle<CMBlockBufferRef> block;
            check(CMBlockBufferCreateWithMemoryBlock(
                      kCFAllocatorDefault, nullptr, sample.bytes.size(), kCFAllocatorDefault,
                      nullptr, 0, sample.bytes.size(), 0, &block.value),
                  "Allocate H.264 sample");
            check(CMBlockBufferReplaceDataBytes(sample.bytes.data(), block.value, 0,
                                                sample.bytes.size()),
                  "Copy H.264 access unit");
            CFHandle<CMSampleBufferRef> buffer;
            const size_t size = sample.bytes.size();
            // This serial identifies a pending event; source timestamps stay in VideoDecoder.
            const CMSampleTimingInfo timing{kCMTimeInvalid, CMTimeMake(serial, 1000000),
                                            kCMTimeInvalid};
            check(CMSampleBufferCreateReady(kCFAllocatorDefault, block.value, format, 1, 1, &timing,
                                            1, &size, &buffer.value),
                  "Create H.264 sample buffer");
            VTDecodeInfoFlags flags = 0;
            const auto status = VTDecompressionSessionDecodeFrame(
                session, buffer.value, kVTDecodeFrame_EnableAsynchronousDecompression,
                reinterpret_cast<void*>(intptr_t(serial)), &flags);
            check(status, "Decode H.264 frame");
            ++inflight;
            return true;
        }
    }
    void poll() override {
        @autoreleasepool {
            std::deque<Output> ready;
            {
                std::lock_guard lock(mutex);
                check(callback_error, "Deliver decoded H.264 frame");
                ready.swap(outputs);
            }
            // Release all callback buffers even when one frame reports an error.
            struct Release {
                std::deque<Output>& values;
                ~Release() {
                    for (auto& value : values)
                        if (value.pixels)
                            CVPixelBufferRelease(value.pixels);
                }
            } release{ready};
            for (const auto& output : ready) {
                if (inflight)
                    --inflight;
                check(output.status, "Complete H.264 decode");
                if (!output.pixels) {
                    present(output.serial, {});
                    continue;
                }
                auto slot = std::find_if(leases.begin(), leases.end(),
                                         [](const auto& lease) { return lease.expired(); });
                if (slot == leases.end()) {
                    present(output.serial, {});
                    continue;
                }
                auto image = std::make_shared<GpuImage>();
                image->surface = std::make_shared<MetalVideoSurface>(metal, output.pixels);
                image->width = int(CVPixelBufferGetWidth(output.pixels));
                image->height = int(CVPixelBufferGetHeight(output.pixels));
                const auto pixel_format = CVPixelBufferGetPixelFormatType(output.pixels);
                if (pixel_format != kCVPixelFormatType_420YpCbCr8BiPlanarFullRange &&
                    pixel_format != kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
                    throw std::runtime_error("Decoder did not produce NV12 video");
                image->full_range = pixel_format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange;
                const auto matrix =
                    CVBufferGetAttachment(output.pixels, kCVImageBufferYCbCrMatrixKey, nullptr);
                image->bt709 = matrix && CFEqual(matrix, kCVImageBufferYCbCrMatrix_ITU_R_709_2);
                *slot = image;
                present(output.serial, std::move(image));
            }
        }
    }
};
} // namespace
std::unique_ptr<DecoderBackend> make_decoder_backend(VideoDevice device, PresentDecoded present) {
    return std::make_unique<VideoToolboxDecoder>(device, std::move(present));
}
} // namespace ceres::detail
