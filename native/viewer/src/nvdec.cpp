#include "ceres/detail/video_queue.hpp"
#include "ceres/video.hpp"
#include <algorithm>
#include <dynlink_nvcuvid.h>
#include <map>
#include <mutex>
#include <stdexcept>
#include <thread>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace ceres {
namespace {
void check(CUresult result, const char* operation) {
    if (result == CUDA_SUCCESS)
        return;
    const char* description = nullptr;
    cuGetErrorString(result, &description);
    throw std::runtime_error(std::string(operation) + ": " +
                             (description ? description : "CUDA failure"));
}

struct DecodeApi {
#ifdef _WIN32
    HMODULE library = LoadLibraryA("nvcuvid.dll");
    void* symbol(const char* name) {
        return reinterpret_cast<void*>(GetProcAddress(library, name));
    }
    void release() {
        if (library)
            FreeLibrary(library);
        library = nullptr;
    }
#else
    void* library = dlopen("libnvcuvid.so.1", RTLD_NOW);
    void* symbol(const char* name) {
        return dlsym(library, name);
    }
    void release() {
        if (library)
            dlclose(library);
        library = nullptr;
    }
#endif
    tcuvidCreateVideoParser* create_parser = nullptr;
    tcuvidDestroyVideoParser* destroy_parser = nullptr;
    tcuvidParseVideoData* parse = nullptr;
    tcuvidCreateDecoder* create_decoder = nullptr;
    tcuvidDestroyDecoder* destroy_decoder = nullptr;
    tcuvidDecodePicture* decode = nullptr;
    tcuvidMapVideoFrame64* map = nullptr;
    tcuvidUnmapVideoFrame64* unmap = nullptr;
    DecodeApi() {
        try {
            if (!library)
                throw std::runtime_error("NVIDIA video decoder driver is unavailable");
#define LOAD(field, type, name)                                                                    \
    field = reinterpret_cast<type*>(symbol(name));                                                 \
    if (!field)                                                                                    \
    throw std::runtime_error(std::string("Missing NVIDIA API ") + name)
            LOAD(create_parser, tcuvidCreateVideoParser, "cuvidCreateVideoParser");
            LOAD(destroy_parser, tcuvidDestroyVideoParser, "cuvidDestroyVideoParser");
            LOAD(parse, tcuvidParseVideoData, "cuvidParseVideoData");
            LOAD(create_decoder, tcuvidCreateDecoder, "cuvidCreateDecoder");
            LOAD(destroy_decoder, tcuvidDestroyDecoder, "cuvidDestroyDecoder");
            LOAD(decode, tcuvidDecodePicture, "cuvidDecodePicture");
            LOAD(map, tcuvidMapVideoFrame64, "cuvidMapVideoFrame64");
            LOAD(unmap, tcuvidUnmapVideoFrame64, "cuvidUnmapVideoFrame64");
#undef LOAD
        } catch (...) {
            release();
            throw;
        }
    }
    ~DecodeApi() {
        release();
    }
};
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
    };
    DecodeApi api;
    std::shared_ptr<CudaContextOwner> context_owner;
    CUcontext context = nullptr;
    CUstream stream = nullptr;
    CUvideoparser parser = nullptr;
    CUvideodecoder decoder = nullptr;
    detail::VideoQueue queue;
    mutable std::mutex mutex;
    DecoderStatus stats;
    std::shared_ptr<GpuImage> latest_frame;
    std::array<std::shared_ptr<GpuImage>, 4> pool;
    std::map<int64_t, Pending> pending;
    std::thread worker;
    bool waiting_idr = true;
    int width = 0, height = 0;
    bool full_range = false, bt709 = false;
    int64_t packet_serial = 0;
    std::string callback_error;

    explicit Impl(int ordinal) : context_owner(std::make_shared<CudaContextOwner>(ordinal)) {
        context = context_owner->context;
        char name[128]{};
        cuDeviceGetName(name, 128, context_owner->device);
        stats.gpu = name;
        worker = std::thread([this] { run(); });
    }
    ~Impl() {
        queue.close();
        if (worker.joinable())
            worker.join();
        latest_frame.reset();
        pool = {};
    }

    void reset() {
        pending.clear();
        callback_error.clear();
        if (parser) {
            api.destroy_parser(parser);
            parser = nullptr;
        }
        if (decoder) {
            api.destroy_decoder(decoder);
            decoder = nullptr;
        }
        width = height = 0;
        pool = {};
        waiting_idr = true;
        CUVIDPARSERPARAMS parameters{};
        parameters.CodecType = cudaVideoCodec_H264;
        parameters.ulMaxNumDecodeSurfaces = 1;
        parameters.ulClockRate = 1000000;
        parameters.ulMaxDisplayDelay = 0;
        parameters.pUserData = this;
        parameters.pfnSequenceCallback = [](void* user, CUVIDEOFORMAT* format) -> int {
            auto* self = static_cast<Impl*>(user);
            try {
                return self->sequence(format);
            } catch (const std::exception& error) {
                self->callback_error = error.what();
                return 0;
            }
        };
        parameters.pfnDecodePicture = [](void* user, CUVIDPICPARAMS* picture) -> int {
            auto* self = static_cast<Impl*>(user);
            try {
                check(self->api.decode(self->decoder, picture), "Decode H.264 picture");
                return 1;
            } catch (const std::exception& error) {
                self->callback_error = error.what();
                return 0;
            }
        };
        parameters.pfnDisplayPicture = [](void* user, CUVIDPARSERDISPINFO* picture) -> int {
            auto* self = static_cast<Impl*>(user);
            try {
                self->display(picture);
                return 1;
            } catch (const std::exception& error) {
                self->callback_error = error.what();
                return 0;
            }
        };
        check(api.create_parser(&parser, &parameters), "Create H.264 parser");
    }

    int sequence(CUVIDEOFORMAT* format) {
        if (format->bit_depth_luma_minus8 || format->chroma_format != cudaVideoChromaFormat_420)
            throw std::runtime_error("Bridge video requires 8-bit H.264 4:2:0");
        const int w = format->display_area.right - format->display_area.left;
        const int h = format->display_area.bottom - format->display_area.top;
        if (w <= 0 || h <= 0 || w > 8192 || h > 8192 || (w & 1) || (h & 1) ||
            !format->coded_width || !format->coded_height || format->coded_width > 8192 ||
            format->coded_height > 8192 || format->display_area.left < 0 ||
            format->display_area.top < 0 ||
            unsigned(format->display_area.right) > format->coded_width ||
            unsigned(format->display_area.bottom) > format->coded_height ||
            format->min_num_decode_surfaces > 32)
            throw std::runtime_error("Invalid decoded video dimensions or surface count");
        if (decoder) {
            api.destroy_decoder(decoder);
            decoder = nullptr;
        }
        width = w;
        height = h;
        pool = {};
        full_range = format->video_signal_description.video_full_range_flag != 0;
        bt709 = format->video_signal_description.matrix_coefficients == 1;
        CUVIDDECODECREATEINFO creation{};
        creation.CodecType = format->codec;
        creation.ChromaFormat = format->chroma_format;
        creation.OutputFormat = cudaVideoSurfaceFormat_NV12;
        creation.ulWidth = format->coded_width;
        creation.ulHeight = format->coded_height;
        creation.ulNumDecodeSurfaces = std::max<unsigned>(format->min_num_decode_surfaces, 4);
        creation.ulNumOutputSurfaces = 2;
        creation.ulCreationFlags = cudaVideoCreate_PreferCUVID;
        creation.DeinterlaceMode = cudaVideoDeinterlaceMode_Weave;
        creation.ulTargetWidth = static_cast<unsigned>(width);
        creation.ulTargetHeight = static_cast<unsigned>(height);
        creation.display_area.left = static_cast<short>(format->display_area.left);
        creation.display_area.top = static_cast<short>(format->display_area.top);
        creation.display_area.right = static_cast<short>(format->display_area.right);
        creation.display_area.bottom = static_cast<short>(format->display_area.bottom);
        check(api.create_decoder(&decoder, &creation), "Create NVDEC decoder");
        return static_cast<int>(creation.ulNumDecodeSurfaces);
    }

    void display(CUVIDPARSERDISPINFO* picture) {
        const auto found = pending.find(picture->timestamp);
        if (found == pending.end())
            return;
        auto frame = std::move(found->second);
        pending.erase(found);
        if (!queue.current(frame.revision) || frame.event.attributes.value("replay_preroll", false))
            return;
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
        CUVIDPROCPARAMS parameters{};
        parameters.progressive_frame = picture->progressive_frame;
        parameters.top_field_first = picture->top_field_first;
        parameters.unpaired_field = picture->repeat_first_field < 0;
        // Order NVDEC post-processing before the copy on our non-blocking stream.
        parameters.output_stream = stream;
        unsigned long long mapped = 0;
        unsigned int pitch = 0;
        check(api.map(decoder, picture->picture_index, &mapped, &pitch, &parameters),
              "Map NVDEC surface");
        try {
            CUDA_MEMCPY2D copy{};
            copy.srcMemoryType = CU_MEMORYTYPE_DEVICE;
            copy.srcDevice = static_cast<CUdeviceptr>(mapped);
            copy.srcPitch = pitch;
            copy.dstMemoryType = CU_MEMORYTYPE_DEVICE;
            copy.dstDevice = target->data;
            copy.dstPitch = target->pitch;
            copy.WidthInBytes = width;
            copy.Height = height * 3 / 2;
            check(cuMemcpy2DAsync(&copy, stream), "Copy decoded surface");
            check(cuStreamSynchronize(stream), "Complete decoder surface transfer");
        } catch (...) {
            // Mapping may have queued post-processing even if the copy failed.
            cuStreamSynchronize(stream);
            api.unmap(decoder, mapped);
            throw;
        }
        check(api.unmap(decoder, mapped), "Release NVDEC surface");
        if (!queue.current(frame.revision))
            return;
        target->event = std::move(frame.event);
        target->decode_revision = frame.revision;
        target->full_range = full_range;
        target->bt709 = bt709;
        std::lock_guard lock(mutex);
        latest_frame = std::move(target);
        ++stats.decoded;
    }

    void run() {
        try {
            check(cuCtxSetCurrent(context), "Activate decoder context");
            check(cuStreamCreate(&stream, CU_STREAM_NON_BLOCKING), "Create decoder stream");
            reset();
            while (auto item = queue.pop()) {
                auto& event = item->event;
                if (!queue.current(item->revision))
                    continue;
                if (event.kind == EventKind::Epoch) {
                    reset();
                    std::lock_guard lock(mutex);
                    latest_frame.reset();
                    continue;
                }
                if (waiting_idr && !event.keyframe)
                    continue;
                waiting_idr = false;
                const int64_t begin = monotonic_us();
                // NVDEC timestamps identify submitted AUs. Source timestamps can
                // coincide after replay scaling, so preserve them in metadata.
                const auto serial = ++packet_serial;
                Pending metadata;
                metadata.revision = item->revision;
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
                while (pending.size() > 64)
                    pending.erase(pending.begin());
                CUVIDSOURCEDATAPACKET packet{};
                packet.flags = CUVID_PKT_TIMESTAMP | CUVID_PKT_ENDOFPICTURE;
                packet.payload = event.payload.data();
                packet.payload_size = static_cast<unsigned long>(event.payload.size());
                packet.timestamp = serial;
                const auto result = api.parse(parser, &packet);
                if (result != CUDA_SUCCESS) {
                    const auto error = callback_error.empty()
                                           ? "H.264 decoder requested a new keyframe"
                                           : callback_error;
                    queue.reset_after_error(item->revision);
                    std::lock_guard lock(mutex);
                    stats.error = error;
                } else if (queue.current(item->revision)) {
                    if (event.keyframe)
                        queue.accepted_keyframe(item->revision);
                    std::lock_guard lock(mutex);
                    stats.decode_ms = (monotonic_us() - begin) / 1000.0;
                    stats.error.clear();
                }
            }
        } catch (const std::exception& error) {
            {
                std::lock_guard lock(mutex);
                stats.error = error.what();
                stats.failed = true;
            }
            // A replay producer must also wake when the consumer has failed.
            queue.close();
        }
        if (parser)
            api.destroy_parser(parser);
        if (decoder)
            api.destroy_decoder(decoder);
        if (stream)
            cuStreamDestroy(stream);
        parser = nullptr;
        decoder = nullptr;
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
