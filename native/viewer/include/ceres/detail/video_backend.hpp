#pragma once
#include <cuda.h>
#include <cstdint>
#include <functional>
#include <memory>
#include <span>
#include <stdexcept>
#include <string>

namespace ceres::detail {
inline void cuda_check(CUresult result, const char* operation) {
    if (result == CUDA_SUCCESS)
        return;
    const char* description = nullptr;
    cuGetErrorString(result, &description);
    throw std::runtime_error(std::string(operation) + ": " +
                             (description ? description : "CUDA failure"));
}

// Source planes remain valid only during the callback. The consumer finishes
// copying both planes before the backend unmaps or requeues the source buffer.
struct DecodedSurface {
    int width = 0, height = 0;
    bool full_range = false, bt709 = false;
    CUDA_MEMCPY2D planes[2]{};
};
using PresentVideo = std::function<void(int64_t, const DecodedSurface&)>;

class VideoBackend {
  public:
    virtual ~VideoBackend() = default;
    virtual void reset() = 0;
    // False means the bounded hardware input pool is full. Retry after poll().
    virtual bool submit(std::span<const uint8_t> bytes, int64_t serial) = 0;
    // Never wait for more input or a future hardware frame.
    virtual void poll() = 0;
};

std::unique_ptr<VideoBackend> make_video_backend(CUstream stream, PresentVideo present);
const char* video_backend_name();
} // namespace ceres::detail
