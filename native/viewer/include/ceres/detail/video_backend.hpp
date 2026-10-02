#pragma once
#include "ceres/video.hpp"
#include <functional>
#include <span>

namespace ceres::detail {
// Delivered on the decoder worker from submit()/poll(), never a hardware callback thread.
// The owned surface stays valid until the final frame lease is released. A null image
// consumes a serial but reports that the bounded presentation pool was exhausted.
using PresentDecoded = std::function<void(int64_t, std::shared_ptr<GpuImage>)>;
class DecoderBackend {
  public:
    virtual ~DecoderBackend() = default;
    virtual void reset() = 0;
    virtual bool submit(std::span<const uint8_t> bytes, int64_t serial) = 0;
    virtual void poll() = 0;
    virtual std::string device_name() const = 0;
    virtual const char* name() const = 0;
};
std::unique_ptr<DecoderBackend> make_decoder_backend(VideoDevice device, PresentDecoded present);
} // namespace ceres::detail
