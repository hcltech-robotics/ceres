#include "ceres/detail/video_backend.hpp"
#include "ceres/detail/cuda_video_backend.hpp"
#include "ceres/detail/cuda_video_surface.hpp"
#include <array>

namespace ceres::detail {
struct CudaContextOwner final : VideoDeviceOwner {
    CUdevice device{};
    CUcontext context = nullptr;
    explicit CudaContextOwner(int ordinal) {
        cuda_check(cuInit(0), "Initialise CUDA");
        cuda_check(cuDeviceGet(&device, ordinal), "Select CUDA device");
        cuda_check(cuDevicePrimaryCtxRetain(&context, device), "Retain CUDA context");
    }
    ~CudaContextOwner() override {
        if (context)
            cuDevicePrimaryCtxRelease(device);
    }
};
VideoDevice cuda_video_device(int ordinal) {
    return {GraphicsApi::opengl_cuda, ordinal, std::make_shared<CudaContextOwner>(ordinal)};
}
CudaVideoSurface::~CudaVideoSurface() {
    if (data && cuCtxPushCurrent(context) == CUDA_SUCCESS) {
        cuMemFree(data);
        CUcontext previous = nullptr;
        cuCtxPopCurrent(&previous);
    }
}
namespace {
class CudaDecoder final : public DecoderBackend {
    std::shared_ptr<CudaContextOwner> owner;
    CUstream stream = nullptr;
    std::unique_ptr<VideoBackend> backend;
    PresentDecoded present;
    std::array<std::shared_ptr<GpuImage>, 4> pool;
    int width = 0, height = 0;
    void display(int64_t serial, const DecodedSurface& source) {
        if (source.width != width || source.height != height) {
            width = source.width;
            height = source.height;
            pool = {};
        }
        std::shared_ptr<GpuImage> target;
        for (auto& slot : pool) {
            if (!slot) {
                auto surface = std::make_shared<CudaVideoSurface>();
                surface->context_owner = owner;
                surface->context = owner->context;
                cuda_check(
                    cuMemAllocPitch(&surface->data, &surface->pitch, width, height * 3 / 2, 16),
                    "Allocate NV12 presentation surface");
                slot = std::make_shared<GpuImage>();
                slot->surface = std::move(surface);
                slot->width = width;
                slot->height = height;
            }
            if (slot.use_count() == 1) {
                target = slot;
                break;
            }
        }
        if (!target) {
            present(serial, {});
            return;
        }
        auto& destination = cuda_surface(*target);
        for (int plane = 0; plane < 2; ++plane) {
            auto copy = source.planes[plane];
            copy.dstMemoryType = CU_MEMORYTYPE_DEVICE;
            copy.dstDevice = destination.data + (plane ? destination.pitch * height : 0);
            copy.dstPitch = destination.pitch;
            copy.WidthInBytes = width;
            copy.Height = plane ? height / 2 : height;
            cuda_check(cuMemcpy2DAsync(&copy, stream), "Copy decoded NV12 plane");
        }
        cuda_check(cuStreamSynchronize(stream), "Complete decoder surface transfer");
        target->full_range = source.full_range;
        target->bt709 = source.bt709;
        present(serial, std::move(target));
    }

  public:
    CudaDecoder(VideoDevice device, PresentDecoded callback) : present(std::move(callback)) {
        if (device.api != GraphicsApi::opengl_cuda)
            throw std::invalid_argument("CUDA decoding requires the NVIDIA graphics backend");
        owner = device.owner ? std::dynamic_pointer_cast<CudaContextOwner>(device.owner)
                             : std::make_shared<CudaContextOwner>(device.ordinal);
        if (!owner)
            throw std::invalid_argument("Video device owner is not a CUDA context");
        cuda_check(cuCtxSetCurrent(owner->context), "Activate decoder context");
        cuda_check(cuStreamCreate(&stream, CU_STREAM_NON_BLOCKING), "Create decoder stream");
        try {
            backend =
                make_video_backend(stream, [this](int64_t serial, const DecodedSurface& surface) {
                    display(serial, surface);
                });
        } catch (...) {
            cuStreamDestroy(stream);
            throw;
        }
    }
    ~CudaDecoder() override {
        backend.reset();
        pool = {};
        cuStreamDestroy(stream);
    }
    void reset() override {
        backend->reset();
        pool = {};
    }
    bool submit(std::span<const uint8_t> bytes, int64_t serial) override {
        return backend->submit(bytes, serial);
    }
    void poll() override {
        backend->poll();
    }
    const char* name() const override {
        return video_backend_name();
    }
    std::string device_name() const override {
        char name[128]{};
        cuda_check(cuDeviceGetName(name, sizeof(name), owner->device), "Read CUDA device name");
        return name;
    }
};
} // namespace
std::unique_ptr<DecoderBackend> make_decoder_backend(VideoDevice device, PresentDecoded present) {
    return std::make_unique<CudaDecoder>(device, std::move(present));
}
} // namespace ceres::detail
