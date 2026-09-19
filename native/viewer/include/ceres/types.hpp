#pragma once
#include <array>
#include <chrono>
#include <cstdint>
#include <functional>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

namespace ceres {
using Json = nlohmann::json;
inline int64_t monotonic_us() {
    return std::chrono::duration_cast<std::chrono::microseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}
struct PoseSample {
    uint8_t kind = 0;
    bool valid = false;
    uint32_t epoch = 0, space_epoch = 0, sequence = 0, joint_mask = 0;
    int64_t observed_us = 0, target_us = 0, received_us = 0;
    std::array<float, 200> values{};
};
struct ClockMapping {
    double offset_us = 0, uncertainty_us = 0, rate = 1;
    bool valid = false;
};
struct CameraDescription {
    int width = 640, height = 480, requested_width = 640;
    double fps = 30;
    std::string side = "unknown", mid, stream = "passthrough";
    bool primary = true;
};
struct StreamDescription {
    int width = 640, height = 480;
    double fps = 30;
    std::string side = "unknown";
    Json raw = Json::object();
    // Metadata order identifies the primary camera. A legacy description has
    // one entry whose MID is supplied by SDP negotiation.
    std::vector<CameraDescription> cameras;
};
struct ReceiverSnapshot {
    std::string connection = "Disconnected", error, code, pairing_url;
    uint32_t epoch = 0, space_epoch = 0;
    int64_t now_us = 0;
    std::array<std::optional<PoseSample>, 3> poses;
    ClockMapping clock;
    StreamDescription camera;
    uint64_t received = 0, rejected = 0, video_frames = 0, video_bytes = 0;
    uint64_t depth_frames = 0, depth_bytes = 0, depth_rejected = 0;
    std::string depth_status = "unsupported", depth_usage;
    bool connected = false;
};
enum class EventKind { Pose, Video, Metadata, Clock, Epoch, Calibration, Episode, Asset, Depth };
struct SessionEvent {
    EventKind kind = EventKind::Metadata;
    int64_t receive_us = 0, time_us = 0;
    uint32_t epoch = 0, space_epoch = 0, sequence = 0, rtp_timestamp = 0;
    bool keyframe = false;
    std::string stream;
    std::vector<uint8_t> payload;
    Json attributes = Json::object();
};
using EventSink = std::function<void(const SessionEvent&)>;
class SessionSource {
  public:
    virtual ~SessionSource() = default;
    virtual void start() = 0;
    virtual void stop() = 0;
    virtual ReceiverSnapshot snapshot() const = 0;
    virtual void set_event_sink(EventSink sink) = 0;
};
inline constexpr std::array<int, 25> joint_parents{-1, 0,  1, 2,  3,  0,  5,  6, 7,  8,  0,  10, 11,
                                                   12, 13, 0, 15, 16, 17, 18, 0, 20, 21, 22, 23};
} // namespace ceres
