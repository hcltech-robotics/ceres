#pragma once
#include "stereo_config.hpp"
#include <cuda_runtime_api.h>
#include <memory>

namespace ceres {
struct StereoNv12 {
    const unsigned char* data = nullptr;
    size_t pitch = 0;
    int width = 0, height = 0;
    bool full_range = false, bt709 = false;
};

// Create/destroy with the owning CUDA context current and no outstanding work.
// One workspace may serve one ordered stream. Input leases and the mapped output
// buffer must remain owned until that stream's completion event has signalled.
class StereoGpuWorkspace {
  public:
    StereoGpuWorkspace(int width, int height);
    ~StereoGpuWorkspace();
    StereoGpuWorkspace(const StereoGpuWorkspace&) = delete;
    StereoGpuWorkspace& operator=(const StereoGpuWorkspace&) = delete;
    cudaError_t enqueue(const StereoNv12& left, const StereoNv12& right,
                        const StereoGpuConfig& config, StereoPoint* output, cudaStream_t stream);
    size_t scratch_bytes() const;

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace ceres
