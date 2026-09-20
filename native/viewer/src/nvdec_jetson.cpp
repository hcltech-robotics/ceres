#include "ceres/detail/video_backend.hpp"
#include <NvVideoDecoder.h>
#include <cudaEGL.h>
#include <nvbufsurface.h>
#include <cerrno>
#include <cstring>
#include <deque>
#include <fcntl.h>
#include <utility>

namespace ceres::detail {
namespace {
void jetson_check(int result, const char* operation) {
    if (result < 0)
        throw std::runtime_error(std::string("Jetson V4L2: ") + operation + ": " +
                                 std::strerror(errno));
}

struct Buffer {
    v4l2_buffer value{};
    v4l2_plane planes[MAX_PLANES]{};
    Buffer() {
        value.m.planes = planes;
        value.length = MAX_PLANES;
    }
};

// EGL represents block-linear planes as CUDA arrays and pitch-linear planes as
// device pointers. Neither representation belongs to the presentation pool.
class EglSurface {
    NvBufSurface* surface = nullptr;
    CUgraphicsResource resource = nullptr;
    bool mapped = false;

  public:
    CUeglFrame frame{};
    explicit EglSurface(int fd) {
        try {
            jetson_check(NvBufSurfaceFromFd(fd, reinterpret_cast<void**>(&surface)),
                         "Get decoded surface");
            if (!surface || surface->batchSize != 1 || !surface->surfaceList)
                throw std::runtime_error("Jetson V4L2 returned an invalid surface");
            jetson_check(NvBufSurfaceMapEglImage(surface, 0), "Map decoded EGL image");
            mapped = true;
            cuda_check(cuGraphicsEGLRegisterImage(
                           &resource,
                           static_cast<EGLImageKHR>(surface->surfaceList[0].mappedAddr.eglImage),
                           CU_GRAPHICS_MAP_RESOURCE_FLAGS_READ_ONLY),
                       "Import Jetson EGL image");
            cuda_check(cuGraphicsResourceGetMappedEglFrame(&frame, resource, 0, 0),
                       "Get Jetson CUDA planes");
        } catch (...) {
            release();
            throw;
        }
    }
    ~EglSurface() {
        release();
    }
    EglSurface(const EglSurface&) = delete;
    EglSurface& operator=(const EglSurface&) = delete;
    const NvBufSurfaceParams& parameters() const {
        return surface->surfaceList[0];
    }

  private:
    void release() {
        if (resource)
            cuGraphicsUnregisterResource(resource);
        if (mapped)
            NvBufSurfaceUnMapEglImage(surface, 0);
    }
};

class JetsonBackend final : public VideoBackend {
    // All V4L2 calls, including teardown, belong to the decoder worker. Both
    // planes are non-blocking so cancellation never waits for another packet.
    std::unique_ptr<NvVideoDecoder> decoder;
    PresentVideo present;
    CUstream stream;
    std::deque<unsigned> available;
    v4l2_rect crop{};
    bool capture_ready = false;
    bool full_range = false, bt709 = false;
    static constexpr unsigned input_bytes = 4 * 1024 * 1024;
    static constexpr unsigned input_buffers = 4;

  public:
    JetsonBackend(CUstream copy_stream, PresentVideo callback)
        : present(std::move(callback)), stream(copy_stream) {
        reset();
    }

    void reset() override {
        decoder.reset();
        capture_ready = false;
        available.clear();
        errno = 0;
        decoder.reset(NvVideoDecoder::createVideoDecoder("ceres-h264", O_NONBLOCK));
        if (!decoder)
            throw std::runtime_error(
                std::string("Jetson V4L2 decoder unavailable: ") +
                (errno ? std::strerror(errno) : "device initialisation failed") +
                ". Check /dev/nvhost-nvdec, device access and the matching JetPack multimedia "
                "packages.");
        jetson_check(decoder->subscribeEvent(V4L2_EVENT_RESOLUTION_CHANGE, 0, 0),
                     "Subscribe to resolution changes");
        jetson_check(decoder->setOutputPlaneFormat(V4L2_PIX_FMT_H264, input_bytes),
                     "Select H.264 input");
        jetson_check(decoder->setFrameInputMode(0), "Select complete access units");
        jetson_check(decoder->enableMetadataReporting(), "Enable decode error reporting");
        jetson_check(decoder->output_plane.setupPlane(V4L2_MEMORY_MMAP, input_buffers, true, false),
                     "Allocate compressed input buffers");
        jetson_check(decoder->output_plane.setStreamStatus(true), "Start compressed input");
        for (unsigned i = 0; i < decoder->output_plane.getNumBuffers(); ++i)
            available.push_back(i);
    }

    bool submit(std::span<const uint8_t> bytes, int64_t serial) override {
        if (bytes.empty() || bytes.size() > input_bytes)
            throw std::runtime_error(
                "Jetson H.264 access unit must contain between 1 byte and 4 MiB");
        if (available.empty())
            return false;
        const auto index = available.front();
        auto* output = decoder->output_plane.getNthBuffer(index);
        if (!output || !output->planes[0].data || bytes.size() > output->planes[0].length)
            throw std::runtime_error("Jetson compressed input buffer is too small");
        std::memcpy(output->planes[0].data, bytes.data(), bytes.size());
        Buffer buffer;
        buffer.value.index = index;
        buffer.planes[0].bytesused = static_cast<unsigned>(bytes.size());
        // The opaque serial is echoed on CAPTURE. Source time and camera identity
        // remain in the common decoder's metadata, including coincident times.
        buffer.value.flags = V4L2_BUF_FLAG_TIMESTAMP_COPY;
        buffer.value.timestamp.tv_sec = serial / 1000000;
        buffer.value.timestamp.tv_usec = serial % 1000000;
        jetson_check(decoder->output_plane.qBuffer(buffer.value, nullptr),
                     "Queue H.264 access unit");
        available.pop_front();
        return true;
    }

    void poll() override {
        if (decoder->isInError())
            throw std::runtime_error("Jetson V4L2 decoder requested a new keyframe");
        // Drain the old resolution before replacing its capture buffers.
        drain_capture();
        for (;;) {
            v4l2_event event{};
            const auto result = decoder->dqEvent(event, 0);
            if (result < 0 && errno == EAGAIN)
                break;
            jetson_check(result, "Read decoder event");
            if (event.type == V4L2_EVENT_RESOLUTION_CHANGE)
                configure_capture();
        }
        while (decoder->output_plane.getNumQueuedBuffers()) {
            Buffer buffer;
            const auto result = decoder->output_plane.dqBuffer(buffer.value, nullptr, nullptr, 0);
            if (result < 0 && errno == EAGAIN)
                break;
            jetson_check(result, "Release compressed input buffer");
            if (buffer.value.flags & V4L2_BUF_FLAG_ERROR)
                throw std::runtime_error("Jetson rejected a damaged H.264 access unit");
            available.push_back(buffer.value.index);
        }
        drain_capture();
    }

  private:
    void configure_capture() {
        v4l2_format format{};
        v4l2_crop selection{};
        jetson_check(decoder->capture_plane.getFormat(format), "Read decoded format");
        jetson_check(decoder->capture_plane.getCrop(selection), "Read decoded crop");
        crop = selection.c;
        const auto& pixels = format.fmt.pix_mp;
        if (pixels.pixelformat != V4L2_PIX_FMT_NV12M)
            throw std::runtime_error("Bridge video requires 8-bit H.264 4:2:0 NV12");
        if (pixels.colorspace == V4L2_COLORSPACE_BT2020)
            throw std::runtime_error("Bridge video requires BT.601 or BT.709 colour");
        full_range = pixels.quantization == V4L2_QUANTIZATION_FULL_RANGE;
        bt709 = pixels.colorspace == V4L2_COLORSPACE_REC709;
        if (!crop.width || !crop.height || crop.left < 0 || crop.top < 0 || pixels.width > 8192 ||
            pixels.height > 8192 || unsigned(crop.left) > pixels.width ||
            unsigned(crop.top) > pixels.height || crop.width > pixels.width - unsigned(crop.left) ||
            crop.height > pixels.height - unsigned(crop.top) ||
            ((crop.width | crop.height | unsigned(crop.left) | unsigned(crop.top)) & 1))
            throw std::runtime_error("Jetson returned an invalid NV12 crop");
        decoder->capture_plane.deinitPlane();
        capture_ready = false;
        jetson_check(
            decoder->setCapturePlaneFormat(pixels.pixelformat, pixels.width, pixels.height),
            "Set decoded format");
        int32_t minimum = 0;
        jetson_check(decoder->getMinimumCapturePlaneBuffers(minimum), "Read capture buffer count");
        if (minimum <= 0 || minimum > 32)
            throw std::runtime_error("Jetson returned an invalid capture buffer count");
        jetson_check(decoder->capture_plane.setupPlane(V4L2_MEMORY_MMAP, minimum + 2, false, false),
                     "Allocate decoded surfaces");
        jetson_check(decoder->capture_plane.setStreamStatus(true), "Start decoded output");
        for (unsigned i = 0; i < decoder->capture_plane.getNumBuffers(); ++i) {
            Buffer buffer;
            buffer.value.index = i;
            jetson_check(decoder->capture_plane.qBuffer(buffer.value, nullptr),
                         "Queue decoded surface");
        }
        capture_ready = true;
    }

    void drain_capture() {
        if (!capture_ready)
            return;
        // A finite drain keeps source changes responsive under continuous input.
        for (unsigned i = 0; i < decoder->capture_plane.getNumBuffers(); ++i) {
            Buffer buffer;
            NvBuffer* decoded = nullptr;
            const auto result = decoder->capture_plane.dqBuffer(buffer.value, &decoded, nullptr, 0);
            if (result < 0 && errno == EAGAIN)
                break;
            jetson_check(result, "Dequeue decoded surface");
            if ((buffer.value.flags & V4L2_BUF_FLAG_ERROR) || !decoded)
                throw std::runtime_error("Jetson returned a damaged decoded frame");
            if (buffer.planes[0].bytesused) {
                v4l2_ctrl_videodec_outputbuf_metadata metadata{};
                jetson_check(decoder->getMetadata(buffer.value.index, metadata),
                             "Read frame metadata");
                if (metadata.bValidFrameStatus && metadata.FrameDecStats.DecodeError)
                    throw std::runtime_error("Jetson detected H.264 prediction loss");
                copy_surface(decoded->planes[0].fd,
                             int64_t(buffer.value.timestamp.tv_sec) * 1000000 +
                                 buffer.value.timestamp.tv_usec,
                             metadata.ucMatrixCoefficients);
            }
            // copy_surface completes CUDA work and releases EGL before requeue.
            jetson_check(decoder->capture_plane.qBuffer(buffer.value, nullptr),
                         "Return decoded surface");
        }
    }

    void copy_surface(int fd, int64_t serial, uint8_t matrix) {
        EglSurface imported(fd);
        const auto& frame = imported.frame;
        const auto& parameters = imported.parameters();
        DecodedSurface surface;
        surface.width = static_cast<int>(crop.width);
        surface.height = static_cast<int>(crop.height);
        // Capture allocation colour defaults need not contain the stream's VUI.
        // Use decoder format/metadata for presentation, not the memory layout.
        surface.full_range = full_range;
        surface.bt709 = matrix == 1 || ((matrix == 0 || matrix == 2) && bt709);
        switch (parameters.colorFormat) {
        case NVBUF_COLOR_FORMAT_NV12:
        case NVBUF_COLOR_FORMAT_NV12_ER:
        case NVBUF_COLOR_FORMAT_NV12_709:
        case NVBUF_COLOR_FORMAT_NV12_709_ER:
            break;
        default:
            throw std::runtime_error("Jetson returned an unsupported NV12 colour space");
        }
        if (frame.planeCount != 2 || parameters.planeParams.num_planes != 2 ||
            frame.cuFormat != CU_AD_FORMAT_UNSIGNED_INT8)
            throw std::runtime_error("Jetson returned an unsupported CUDA plane format");
        for (int plane = 0; plane < 2; ++plane) {
            auto& copy = surface.planes[plane];
            copy.srcXInBytes = static_cast<size_t>(crop.left);
            copy.srcY = static_cast<size_t>(crop.top) / (plane ? 2 : 1);
            if (frame.frameType == CU_EGL_FRAME_TYPE_ARRAY) {
                copy.srcMemoryType = CU_MEMORYTYPE_ARRAY;
                copy.srcArray = frame.frame.pArray[plane];
            } else if (frame.frameType == CU_EGL_FRAME_TYPE_PITCH) {
                copy.srcMemoryType = CU_MEMORYTYPE_DEVICE;
                copy.srcDevice = reinterpret_cast<CUdeviceptr>(frame.frame.pPitch[plane]);
                copy.srcPitch = parameters.planeParams.pitch[plane];
            } else {
                throw std::runtime_error("Jetson returned an unknown CUDA plane layout");
            }
        }
        try {
            present(serial, surface);
            cuda_check(cuStreamSynchronize(stream), "Complete Jetson surface transfer");
        } catch (...) {
            cuStreamSynchronize(stream);
            throw;
        }
    }
};
} // namespace

std::unique_ptr<VideoBackend> make_video_backend(CUstream stream, PresentVideo present) {
    return std::make_unique<JetsonBackend>(stream, std::move(present));
}
const char* video_backend_name() {
    return "Jetson V4L2";
}
} // namespace ceres::detail
