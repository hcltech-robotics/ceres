#include "ceres/detail/video_backend.hpp"
#include "ceres/detail/video_queue.hpp"
#include "ceres/video.hpp"
#include <algorithm>
#include <condition_variable>
#include <map>
#include <mutex>
#include <thread>

namespace ceres {
struct VideoDecoder::Impl {
    struct Pending {
        SessionEvent event;
        uint64_t revision = 0;
        int64_t begin = 0;
        int64_t queued_us = 0;
    };
    detail::VideoQueue queue;
    mutable std::mutex mutex;
    std::condition_variable ready;
    bool initialised = false;
    DecoderStatus stats;
    std::shared_ptr<GpuImage> latest_frame;
    std::map<int64_t, Pending> pending;
    std::thread worker;
    int64_t packet_serial = 0;

    VideoDevice device;
    explicit Impl(VideoDevice selected) : device(selected) {
        worker = std::thread([this] { run(); });
        // Preserve the old constructor contract: device initialisation finishes
        // before live frames can enter the age-bounded queue.
        std::unique_lock lock(mutex);
        ready.wait(lock, [this] { return initialised; });
    }
    ~Impl() {
        queue.close();
        if (worker.joinable())
            worker.join();
        latest_frame.reset();
    }
    void display(int64_t serial, std::shared_ptr<GpuImage> target) {
        const auto found = pending.find(serial);
        if (found == pending.end())
            return;
        auto frame = std::move(found->second);
        pending.erase(found);
        if (!queue.current(frame.revision) || frame.event.attributes.value("replay_preroll", false))
            return;
        if (detail::VideoQueue::expired(frame.event, frame.queued_us, monotonic_us())) {
            queue.reset_after_delay(frame.revision);
            return;
        }
        if (!target) {
            std::lock_guard lock(mutex);
            ++stats.dropped;
            return;
        }
        if (!queue.current(frame.revision))
            return;
        target->event = std::move(frame.event);
        target->decode_revision = frame.revision;
        std::lock_guard lock(mutex);
        latest_frame = std::move(target);
        ++stats.decoded;
        stats.decode_ms = (monotonic_us() - frame.begin) / 1000.0;
    }

    void run() {
        std::unique_ptr<detail::DecoderBackend> backend;
        try {
            backend = detail::make_decoder_backend(
                device, [this](int64_t serial, std::shared_ptr<GpuImage> image) {
                    display(serial, std::move(image));
                });
            {
                std::lock_guard lock(mutex);
                stats.gpu = backend->device_name();
                stats.backend = backend->name();
                initialised = true;
            }
            ready.notify_one();
            uint64_t revision = queue.state().revision;
            bool waiting_idr = true;
            std::optional<detail::VideoQueue::Item> input;
            int64_t serial = 0;
            while (!queue.state().closed) {
                const auto now_us = monotonic_us();
                queue.expire_live(now_us);
                if (std::any_of(pending.begin(), pending.end(), [now_us](const auto& value) {
                        return detail::VideoQueue::expired(value.second.event,
                                                           value.second.queued_us, now_us);
                    }))
                    queue.reset_after_delay(revision);
                if (!queue.current(revision)) {
                    backend->reset();
                    pending.clear();
                    input.reset();
                    serial = 0;
                    waiting_idr = true;
                    revision = queue.state().revision;
                    std::lock_guard lock(mutex);
                    latest_frame.reset();
                }
                try {
                    backend->poll();
                    if (!input)
                        input = queue.pop_for(std::chrono::milliseconds(2));
                    if (!input)
                        continue;
                    if (!queue.current(input->revision)) {
                        input.reset();
                        serial = 0;
                        continue;
                    }
                    if (detail::VideoQueue::expired(*input, monotonic_us())) {
                        queue.reset_after_delay(input->revision);
                        continue;
                    }
                    auto& event = input->event;
                    if (event.kind == EventKind::Epoch || (waiting_idr && !event.keyframe)) {
                        input.reset();
                        continue;
                    }
                    if (!serial) {
                        if (pending.size() >= 64)
                            throw std::runtime_error("Video decoder stopped returning frames");
                        serial = ++packet_serial;
                        Pending metadata;
                        metadata.revision = input->revision;
                        metadata.begin = monotonic_us();
                        metadata.queued_us = input->queued_us;
                        metadata.event.kind = event.kind;
                        metadata.event.receive_us = event.receive_us;
                        metadata.event.time_us = event.time_us;
                        metadata.event.epoch = event.epoch;
                        metadata.event.space_epoch = event.space_epoch;
                        metadata.event.sequence = event.sequence;
                        metadata.event.rtp_timestamp = event.rtp_timestamp;
                        metadata.event.keyframe = event.keyframe;
                        metadata.event.stream = event.stream;
                        metadata.event.attributes = event.attributes;
                        pending.emplace(serial, std::move(metadata));
                    }
                    if (!backend->submit(event.payload, serial)) {
                        if (monotonic_us() - pending.at(serial).begin > 3000000)
                            throw std::runtime_error("Video decoder input timed out");
                        std::this_thread::sleep_for(std::chrono::milliseconds(2));
                        continue;
                    }
                    waiting_idr = false;
                    if (event.keyframe)
                        queue.accepted_keyframe(input->revision);
                    input.reset();
                    serial = 0;
                    std::lock_guard lock(mutex);
                    stats.error.clear();
                } catch (const std::exception& error) {
                    queue.reset_after_error(revision);
                    std::lock_guard lock(mutex);
                    stats.error = error.what();
                }
            }
        } catch (const std::exception& error) {
            {
                std::lock_guard lock(mutex);
                stats.error = error.what();
                stats.failed = true;
                initialised = true;
            }
            ready.notify_one();
            queue.close();
        }
        backend.reset();
    }
};

VideoDecoder::VideoDecoder(VideoDevice device) : impl_(std::make_unique<Impl>(device)) {}
VideoDecoder::~VideoDecoder() = default;
void VideoDecoder::submit(const SessionEvent& event) {
    if (impl_->queue.push(event) == detail::VideoQueue::Result::TooLarge) {
        std::lock_guard lock(impl_->mutex);
        impl_->stats.error = "Compressed video frame exceeds the decoder queue capacity";
    }
}
void VideoDecoder::cancel_replay() {
    impl_->queue.cancel_replay();
    std::lock_guard lock(impl_->mutex);
    impl_->latest_frame.reset();
}
void VideoDecoder::begin_source() {
    impl_->queue.begin_source();
    std::lock_guard lock(impl_->mutex);
    impl_->latest_frame.reset();
    if (!impl_->stats.failed)
        impl_->stats.error.clear();
}
VideoFrameLease VideoDecoder::latest() {
    std::lock_guard lock(impl_->mutex);
    if (!impl_->latest_frame || !impl_->queue.current(impl_->latest_frame->decode_revision))
        return {};
    return {impl_->latest_frame};
}
DecoderStatus VideoDecoder::status() const {
    const auto queue = impl_->queue.state();
    std::lock_guard lock(impl_->mutex);
    auto status = impl_->stats;
    status.queued = queue.queued;
    status.dropped += queue.dropped;
    status.needs_keyframe = queue.needs_keyframe;
    return status;
}
} // namespace ceres
