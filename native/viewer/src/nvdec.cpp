#include "ceres/detail/video_backend.hpp"
#include "ceres/detail/video_queue.hpp"
#include "ceres/video.hpp"
#include <map>
#include <mutex>
#include <thread>

namespace ceres {
namespace {
void check(CUresult result, const char* operation) {
    detail::cuda_check(result, operation);
}
} // namespace
// A presentation lease can outlive the decoder that allocated it.
struct CudaContextOwner {
    CUdevice device{};
    CUcontext context = nullptr;
    explicit CudaContextOwner(int ordinal) {
        check(cuInit(0), "Initialise CUDA");
        check(cuDeviceGet(&device, ordinal), "Select CUDA device");
        check(cuDevicePrimaryCtxRetain(&context, device), "Retain CUDA context");
    }
    ~CudaContextOwner() {
        if (context)
            cuDevicePrimaryCtxRelease(device);
    }
};

GpuImage::~GpuImage() {
    if (data && cuCtxPushCurrent(context) == CUDA_SUCCESS) {
        cuMemFree(data);
        CUcontext previous = nullptr;
        cuCtxPopCurrent(&previous);
    }
}

struct NvDecoder::Impl {
    struct Pending {
        SessionEvent event;
        uint64_t revision = 0;
        int64_t begin = 0;
    };
    std::shared_ptr<CudaContextOwner> context_owner;
    CUcontext context = nullptr;
    CUstream stream = nullptr;
    detail::VideoQueue queue;
    mutable std::mutex mutex;
    DecoderStatus stats;
    std::shared_ptr<GpuImage> latest_frame;
    std::array<std::shared_ptr<GpuImage>, 4> pool;
    std::map<int64_t, Pending> pending;
    std::thread worker;
    int width = 0, height = 0;
    int64_t packet_serial = 0;

    explicit Impl(int ordinal) : context_owner(std::make_shared<CudaContextOwner>(ordinal)) {
        context = context_owner->context;
        char name[128]{};
        cuDeviceGetName(name, 128, context_owner->device);
        stats.gpu = name;
        stats.backend = detail::video_backend_name();
        worker = std::thread([this] { run(); });
    }
    ~Impl() {
        queue.close();
        if (worker.joinable())
            worker.join();
        latest_frame.reset();
        pool = {};
    }
    void display(int64_t serial, const detail::DecodedSurface& surface) {
        const auto found = pending.find(serial);
        if (found == pending.end())
            return;
        auto frame = std::move(found->second);
        pending.erase(found);
        if (!queue.current(frame.revision) || frame.event.attributes.value("replay_preroll", false))
            return;
        if (surface.width != width || surface.height != height) {
            width = surface.width;
            height = surface.height;
            pool = {};
        }
        std::shared_ptr<GpuImage> target;
        for (auto& slot : pool) {
            if (!slot) {
                slot = std::make_shared<GpuImage>();
                slot->context_owner = context_owner;
                slot->context = context;
                slot->width = width;
                slot->height = height;
                check(cuMemAllocPitch(&slot->data, &slot->pitch, width, height * 3 / 2, 16),
                      "Allocate NV12 presentation surface");
            }
            if (slot.use_count() == 1) {
                target = slot;
                break;
            }
        }
        if (!target) {
            std::lock_guard lock(mutex);
            ++stats.dropped;
            return;
        }
        for (int plane = 0; plane < 2; ++plane) {
            auto copy = surface.planes[plane];
            copy.dstMemoryType = CU_MEMORYTYPE_DEVICE;
            copy.dstDevice = target->data + (plane ? target->pitch * height : 0);
            copy.dstPitch = target->pitch;
            copy.WidthInBytes = width;
            copy.Height = plane ? height / 2 : height;
            check(cuMemcpy2DAsync(&copy, stream), "Copy decoded NV12 plane");
        }
        check(cuStreamSynchronize(stream), "Complete decoder surface transfer");
        if (!queue.current(frame.revision))
            return;
        target->event = std::move(frame.event);
        target->decode_revision = frame.revision;
        target->full_range = surface.full_range;
        target->bt709 = surface.bt709;
        std::lock_guard lock(mutex);
        latest_frame = std::move(target);
        ++stats.decoded;
        stats.decode_ms = (monotonic_us() - frame.begin) / 1000.0;
    }

    void run() {
        std::unique_ptr<detail::VideoBackend> backend;
        try {
            check(cuCtxSetCurrent(context), "Activate decoder context");
            check(cuStreamCreate(&stream, CU_STREAM_NON_BLOCKING), "Create decoder stream");
            backend = detail::make_video_backend(
                stream, [this](int64_t serial, const detail::DecodedSurface& surface) {
                    display(serial, surface);
                });
            uint64_t revision = queue.state().revision;
            bool waiting_idr = true;
            std::optional<detail::VideoQueue::Item> input;
            int64_t serial = 0;
            while (!queue.state().closed) {
                if (!queue.current(revision)) {
                    backend->reset();
                    pending.clear();
                    input.reset();
                    serial = 0;
                    pool = {};
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
            }
            queue.close();
        }
        backend.reset();
        if (stream)
            cuStreamDestroy(stream);
        stream = nullptr;
    }
};

NvDecoder::NvDecoder(int device) : impl_(std::make_unique<Impl>(device)) {}
NvDecoder::~NvDecoder() = default;
void NvDecoder::submit(const SessionEvent& event) {
    if (impl_->queue.push(event) == detail::VideoQueue::Result::TooLarge) {
        std::lock_guard lock(impl_->mutex);
        impl_->stats.error = "Compressed video frame exceeds the decoder queue capacity";
    }
}
void NvDecoder::cancel_replay() {
    impl_->queue.cancel_replay();
    std::lock_guard lock(impl_->mutex);
    impl_->latest_frame.reset();
}
void NvDecoder::begin_source() {
    impl_->queue.begin_source();
    std::lock_guard lock(impl_->mutex);
    impl_->latest_frame.reset();
    if (!impl_->stats.failed)
        impl_->stats.error.clear();
}
VideoFrameLease NvDecoder::latest() {
    std::lock_guard lock(impl_->mutex);
    if (!impl_->latest_frame || !impl_->queue.current(impl_->latest_frame->decode_revision))
        return {};
    return {impl_->latest_frame};
}
DecoderStatus NvDecoder::status() const {
    const auto queue = impl_->queue.state();
    std::lock_guard lock(impl_->mutex);
    auto status = impl_->stats;
    status.queued = queue.queued;
    status.dropped += queue.dropped;
    status.needs_keyframe = queue.needs_keyframe;
    return status;
}
} // namespace ceres
