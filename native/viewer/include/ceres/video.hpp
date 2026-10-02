#pragma once
#include "types.hpp"
#include <memory>
#include <string>
namespace ceres {
enum class GraphicsApi { opengl_cuda, metal };
struct VideoDevice {
    GraphicsApi api = GraphicsApi::opengl_cuda;
    int ordinal = 0;
};
struct VideoSurface {
    virtual ~VideoSurface() = default;
};
struct GpuImage {
    int width = 0, height = 0;
    bool full_range = false, bt709 = false;
    SessionEvent event;
    std::shared_ptr<VideoSurface> surface;
    uint64_t decode_revision = 0;
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
    std::string error, gpu, backend;
    bool needs_keyframe = false, failed = false;
};
class VideoDecoder {
  public:
    explicit VideoDecoder(VideoDevice device = {});
    ~VideoDecoder();
    VideoDecoder(const VideoDecoder&) = delete;
    VideoDecoder& operator=(const VideoDecoder&) = delete;
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
