#pragma once
#include "ceres/types.hpp"
#include <filesystem>
#include <memory>
#include <span>

namespace ceres {
struct RecorderOptions {
    size_t queue_bytes = 64 * 1024 * 1024;
    size_t chunk_bytes = 4 * 1024 * 1024;
    int flush_interval_ms = 1000;
};
struct RecorderStatus {
    bool recording = false, paused = false, failed = false;
    uint64_t accepted_events = 0, written_events = 0, written_bytes = 0;
    int64_t duration_us = 0;
    int64_t active_duration_us = 0;
    size_t queued_bytes = 0;
    std::filesystem::path path;
    std::string error;
};
class Recorder {
  public:
    Recorder();
    ~Recorder();
    Recorder(const Recorder&) = delete;
    Recorder& operator=(const Recorder&) = delete;
    void start(const std::filesystem::path& path,
               const std::vector<SessionEvent>& initial_events = {}, RecorderOptions options = {});
    bool push(const SessionEvent& event);
    // Accept subsequent observations only in this receiver-time interval.
    // Control events and original observation timestamps remain unchanged.
    void set_capture_window(int64_t start_us, std::optional<int64_t> end_us = std::nullopt);
    // Paused observations are omitted. Current controls are retained for resume,
    // and each video stream must resume at a keyframe.
    void set_paused(bool paused);
    void stop();
    RecorderStatus status() const;
    bool add_episode(const std::string& name, const Json& attributes = Json::object());

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

struct RecoveryResult {
    std::filesystem::path path;
    uint64_t recovered_events = 0, discarded_bytes = 0;
    bool truncated = false;
};
RecoveryResult recover_session(const std::filesystem::path& input,
                               const std::filesystem::path& output);

// The envelope is also consumed by the independent dataset exporter.
std::vector<uint8_t> encode_session_event(const SessionEvent& event, int64_t origin_us);
SessionEvent decode_session_event(std::span<const uint8_t> bytes);

class ReplaySource final : public SessionSource {
  public:
    explicit ReplaySource(const std::filesystem::path& path);
    ~ReplaySource() override;
    void start() override;
    void stop() override;
    ReceiverSnapshot snapshot() const override;
    void set_event_sink(EventSink sink) override;
    void seek(int64_t session_relative_us);
    // Pause and seek to the adjacent recorded video timestamp. Direction is -1 or 1.
    int64_t step_frame(int direction);
    void set_playing(bool playing);
    void set_speed(double speed);
    void speed(double speed) {
        set_speed(speed);
    }
    double speed() const;
    bool playing() const;
    int64_t duration_us() const;
    int64_t position_us() const;
    const std::filesystem::path& path() const;
    std::vector<SessionEvent> episodes() const;
    // Read recorded task setup on the inspection worker, not the render loop.
    Json task_specification() const;
    // Inclusive sample-time interval. Call from the inspection worker, not the render loop.
    std::vector<SessionEvent> pose_history(int64_t start_us, int64_t end_us) const;

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace ceres
