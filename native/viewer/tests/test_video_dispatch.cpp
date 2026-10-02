#include "ceres/detail/video_backend.hpp"
#include <atomic>
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <thread>
namespace {
std::atomic<unsigned> reset_count{0};
void require(bool value, const char* message) {
    if (!value)
        throw std::runtime_error(message);
}
struct Surface final : ceres::VideoSurface {
    uint8_t value = 0;
};
class Backend final : public ceres::detail::DecoderBackend {
    ceres::detail::PresentDecoded present;
    int64_t serial = 0, ready_at = 0;
    uint8_t value = 0;
    bool backpressure = true;

  public:
    explicit Backend(ceres::detail::PresentDecoded callback) : present(std::move(callback)) {}
    const char* name() const override {
        return "CPU test backend";
    }
    std::string device_name() const override {
        return "CPU";
    }
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
        auto surface = std::make_shared<Surface>();
        surface->value = value;
        auto image = std::make_shared<ceres::GpuImage>();
        image->surface = surface;
        image->width = 32;
        image->height = 16;
        image->full_range = image->bt709 = true;
        present(serial, std::move(image));
        serial = 0;
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
ceres::VideoFrameLease wait(ceres::VideoDecoder& decoder, uint32_t sequence) {
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
    const auto& surface = dynamic_cast<const Surface&>(*frame.image->surface);
    require(surface.value == value, "Mutated retained frame");
    require(frame.image->event.epoch == 0 && frame.image->event.sequence != 0,
            "Lost event identity");
}
} // namespace
namespace ceres::detail {
std::unique_ptr<DecoderBackend> make_decoder_backend(VideoDevice, PresentDecoded present) {
    return std::make_unique<Backend>(std::move(present));
}
} // namespace ceres::detail

int main() {
    try {
        auto decoder = std::make_unique<ceres::VideoDecoder>(ceres::VideoDevice{});
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
        std::cout << "Portable decoder cancellation, recovery and ownership checks passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
