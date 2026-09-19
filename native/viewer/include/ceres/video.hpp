#pragma once
#include "types.hpp"
#include <cuda.h>
#include <memory>
#include <string>
namespace ceres {
struct CudaContextOwner;
struct GpuImage {
    CUdeviceptr data = 0;
    size_t pitch = 0;
    int width = 0, height = 0;
    bool full_range = false, bt709 = false;
    SessionEvent event;
    CUcontext context = nullptr;
    std::shared_ptr<CudaContextOwner> context_owner;
    uint64_t decode_revision = 0;
    ~GpuImage();
};
struct VideoFrameLease {
    std::shared_ptr<GpuImage> image;
    explicit operator bool() const {
        return bool(image);
    }
};
struct DecoderStatus {
    uint64_t decoded = 0, dropped = 0;
    double decode_ms = 0;
    size_t queued = 0;
    std::string error, gpu;
    bool needs_keyframe = false, failed = false;
};
class NvDecoder {
  public:
    explicit NvDecoder(int device);
    ~NvDecoder();
    NvDecoder(const NvDecoder&) = delete;
    NvDecoder& operator=(const NvDecoder&) = delete;
    void submit(const SessionEvent& event);
    // Cancel blocked replay submission before seeking or stopping its source.
    void cancel_replay();
    // Call after the old source has stopped and before starting its replacement.
    void begin_source();
    VideoFrameLease latest();
    DecoderStatus status() const;

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace ceres
