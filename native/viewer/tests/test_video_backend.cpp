#include "ceres/detail/video_backend.hpp"
#include "ceres/video.hpp"
#include <atomic>
#include <chrono>
#include <cstring>
#include <iostream>
#include <thread>

// Exercise asynchronous hardware delivery and both CUDA source layouts without
// requiring a particular video driver. Real codec accuracy is tested by nvdec.
namespace {
std::atomic<unsigned> reset_count{0};
constexpr int width = 32, height = 16, coded_width = 48, coded_height = 24;
void require(bool value, const char* message) {
    if (!value)
        throw std::runtime_error(message);
}
std::vector<uint8_t> expected(uint8_t value) {
    std::vector<uint8_t> result(width * height * 3 / 2);
    std::fill(result.begin(), result.begin() + width * height, value);
    std::fill(result.begin() + width * height, result.end(), uint8_t(value + 1));
    return result;
}
class AsyncBackend final : public ceres::detail::VideoBackend {
    ceres::detail::PresentVideo present;
    int64_t serial = 0, ready_at = 0;
    uint8_t value = 0;
    bool backpressure = true;

  public:
    explicit AsyncBackend(ceres::detail::PresentVideo callback) : present(std::move(callback)) {}
    void reset() override {
        serial = 0;
        backpressure = true;
        ++reset_count;
    }
    bool submit(std::span<const uint8_t> bytes, int64_t submitted) override {
        if (backpressure) {
            backpressure = false;
            return false;
        }
        if (serial)
            return false;
        serial = submitted;
        value = bytes[0];
        ready_at = ceres::monotonic_us() + (value == 99 ? 1000000 : 10000);
        return true;
    }
    void poll() override {
        if (!serial || ceres::monotonic_us() < ready_at)
            return;
        if (value == 250)
            throw std::runtime_error("Test decoder prediction loss");
        ceres::detail::DecodedSurface surface;
        surface.width = width;
        surface.height = height;
        surface.full_range = true;
        surface.bt709 = true;
        CUdeviceptr pointers[2]{};
        CUarray arrays[2]{};
        auto release = [&] {
            for (int plane = 0; plane < 2; ++plane) {
                if (pointers[plane])
                    cuMemFree(pointers[plane]);
                if (arrays[plane])
                    cuArrayDestroy(arrays[plane]);
            }
        };
        try {
            for (int plane = 0; plane < 2; ++plane) {
                const size_t pitch = coded_width + plane * 16;
                const size_t rows = coded_height / (plane ? 2 : 1);
                std::vector<uint8_t> bytes(pitch * rows, 0);
                for (int row = 0; row < height / (plane ? 2 : 1); ++row)
                    std::memset(bytes.data() + (row + (plane ? 2 : 4)) * pitch + 8, value + plane,
                                width);
                CUDA_MEMCPY2D upload{};
                upload.srcMemoryType = CU_MEMORYTYPE_HOST;
                upload.srcHost = bytes.data();
                upload.srcPitch = pitch;
                upload.WidthInBytes = coded_width;
                upload.Height = rows;
                auto& source = surface.planes[plane];
                source.srcXInBytes = 8;
                source.srcY = plane ? 2 : 4;
                if (value & 1) {
                    CUDA_ARRAY_DESCRIPTOR descriptor{};
                    descriptor.Width = coded_width / (plane ? 2 : 1);
                    descriptor.Height = rows;
                    descriptor.Format = CU_AD_FORMAT_UNSIGNED_INT8;
                    descriptor.NumChannels = plane ? 2 : 1;
                    ceres::detail::cuda_check(cuArrayCreate(&arrays[plane], &descriptor),
                                              "Create test plane");
                    upload.dstMemoryType = source.srcMemoryType = CU_MEMORYTYPE_ARRAY;
                    upload.dstArray = source.srcArray = arrays[plane];
                } else {
                    ceres::detail::cuda_check(cuMemAlloc(&pointers[plane], pitch * rows),
                                              "Allocate test plane");
                    upload.dstMemoryType = source.srcMemoryType = CU_MEMORYTYPE_DEVICE;
                    upload.dstDevice = source.srcDevice = pointers[plane];
                    upload.dstPitch = source.srcPitch = pitch;
                }
                ceres::detail::cuda_check(cuMemcpy2D(&upload), "Upload test plane");
            }
            present(serial, surface);
            serial = 0;
        } catch (...) {
            release();
            throw;
        }
        release();
    }
};
ceres::SessionEvent event(uint32_t sequence, uint8_t value) {
    ceres::SessionEvent result;
    result.kind = ceres::EventKind::Video;
    result.sequence = sequence;
    result.keyframe = true;
    result.payload = {value};
    return result;
}
ceres::VideoFrameLease wait(ceres::NvDecoder& decoder, uint32_t sequence) {
    const auto deadline = ceres::monotonic_us() + 2000000;
    while (ceres::monotonic_us() < deadline) {
        require(!decoder.status().failed, "Asynchronous decoder failed");
        auto frame = decoder.latest();
        if (frame && frame.image->event.sequence == sequence)
            return frame;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    throw std::runtime_error("Asynchronous decoder did not publish a frame");
}
void check_pixels(const ceres::VideoFrameLease& frame, uint8_t value) {
    require(frame.image->full_range && frame.image->bt709, "Lost colour metadata");
    std::vector<uint8_t> bytes(width * height * 3 / 2);
    ceres::detail::cuda_check(cuCtxPushCurrent(frame.image->context), "Activate test context");
    CUDA_MEMCPY2D copy{};
    copy.srcMemoryType = CU_MEMORYTYPE_DEVICE;
    copy.srcDevice = frame.image->data;
    copy.srcPitch = frame.image->pitch;
    copy.dstMemoryType = CU_MEMORYTYPE_HOST;
    copy.dstHost = bytes.data();
    copy.dstPitch = width;
    copy.WidthInBytes = width;
    copy.Height = height * 3 / 2;
    const auto result = cuMemcpy2D(&copy);
    CUcontext previous = nullptr;
    cuCtxPopCurrent(&previous);
    ceres::detail::cuda_check(result, "Read copied planes");
    require(bytes == expected(value), "Cropped NV12 planes differ");
}
} // namespace
namespace ceres::detail {
std::unique_ptr<VideoBackend> make_video_backend(CUstream, PresentVideo present) {
    return std::make_unique<AsyncBackend>(std::move(present));
}
const char* video_backend_name() {
    return "Asynchronous test source";
}
} // namespace ceres::detail

int main() {
    try {
        auto decoder = std::make_unique<ceres::NvDecoder>(0);
        decoder->submit(event(1, 40));
        auto retained = wait(*decoder, 1);
        check_pixels(retained, 40);
        decoder->submit(event(2, 41));
        check_pixels(wait(*decoder, 2), 41);
        check_pixels(retained, 40);
        decoder->submit(event(3, 99));
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        decoder->cancel_replay();
        require(!decoder->latest(), "Cancelled hardware frame remains visible");
        decoder->begin_source();
        decoder->submit(event(4, 42));
        check_pixels(wait(*decoder, 4), 42);
        require(reset_count > 0 && decoder->status().decoded == 3,
                "Published a cancelled hardware frame");
        decoder->submit(event(5, 250));
        const auto recovery_deadline = ceres::monotonic_us() + 2000000;
        while (decoder->status().error.empty() && ceres::monotonic_us() < recovery_deadline)
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        require(decoder->status().needs_keyframe && !decoder->status().error.empty(),
                "Asynchronous decoder error did not request a keyframe");
        decoder->submit(event(6, 43));
        check_pixels(wait(*decoder, 6), 43);
        require(decoder->status().error.empty(), "Keyframe recovery retained the decoder error");
        decoder->submit(event(7, 99));
        const auto delay_deadline = ceres::monotonic_us() + 500000;
        while (!decoder->status().needs_keyframe && ceres::monotonic_us() < delay_deadline)
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        require(decoder->status().needs_keyframe && !decoder->latest(),
                "A stalled live hardware frame escaped the video age budget");
        decoder->submit(event(8, 44));
        check_pixels(wait(*decoder, 8), 44);
        require(decoder->status().decoded == 5, "The stalled live frame was displayed");
        decoder->submit(event(9, 99));
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        const auto before = ceres::monotonic_us();
        decoder.reset();
        require(ceres::monotonic_us() - before < 500000, "Shutdown waited for hardware delivery");
        check_pixels(retained, 40);
        std::cout << "Asynchronous decoder and CUDA plane checks passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
