#pragma once
#include "ceres/types.hpp"
#include <algorithm>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <optional>

namespace ceres::detail {

// Replay producers wait for capacity. Live producers discard a broken prediction
// chain and request an IDR rather than growing latency without a bound.
class VideoQueue {
  public:
    struct Item {
        SessionEvent event;
        uint64_t revision = 0;
    };
    enum class Result { Accepted, Ignored, Cancelled, Closed, TooLarge };
    struct State {
        size_t queued = 0;
        uint64_t dropped = 0, revision = 0;
        bool needs_keyframe = true;
    };

    explicit VideoQueue(size_t frames = 12, size_t bytes = 64 * 1024 * 1024)
        : max_frames_(std::max<size_t>(frames, 2)), max_bytes_(bytes) {}

    Result push(const SessionEvent& event) {
        if (event.kind != EventKind::Video && event.kind != EventKind::Epoch)
            return Result::Ignored;
        std::unique_lock lock(mutex_);
        if (closed_)
            return Result::Closed;
        const auto generation = replay_generation(event);
        if (generation && ((cancelled_through_ && *generation <= *cancelled_through_) ||
                           (generation_ && *generation < *generation_)))
            return Result::Cancelled;
        if (!accepting_ && !generation)
            return Result::Cancelled;
        if (generation && (!generation_ || *generation > *generation_)) {
            generation_ = generation;
            accepting_ = true;
            reset_locked("generation");
        }
        if (event.kind == EventKind::Epoch) {
            const auto requested = event.attributes.find("reset_decoder");
            const bool reset =
                requested != event.attributes.end() && requested->is_boolean()
                    ? requested->get<bool>()
                    : event.attributes.value("reason", std::string{}) != "reference-space";
            if (!reset)
                return Result::Ignored;
            reset_locked("epoch");
            queue_.back().event = event;
            queue_.back().event.payload.clear();
            ready_.notify_all();
            return Result::Accepted;
        }
        if (event.payload.size() > max_bytes_) {
            ++dropped_;
            reset_locked("oversized-frame");
            ready_.notify_all();
            return Result::TooLarge;
        }
        const auto revision = revision_;
        const auto has_room = [&] {
            return queue_.size() < max_frames_ && event.payload.size() <= max_bytes_ - bytes_;
        };
        if (generation) {
            ready_.wait(lock, [&] { return closed_ || revision != revision_ || has_room(); });
            if (closed_)
                return Result::Closed;
            if (revision != revision_)
                return Result::Cancelled;
        } else if (!has_room()) {
            for (const auto& item : queue_)
                if (item.event.kind == EventKind::Video)
                    ++dropped_;
            reset_locked("queue-overflow");
            if (!event.keyframe) {
                ++dropped_;
                ready_.notify_all();
                return Result::Ignored;
            }
        }
        bytes_ += event.payload.size();
        queue_.push_back({event, revision_});
        ready_.notify_all();
        return Result::Accepted;
    }

    std::optional<Item> pop() {
        std::unique_lock lock(mutex_);
        ready_.wait(lock, [&] { return closed_ || !queue_.empty(); });
        if (closed_)
            return std::nullopt;
        auto item = std::move(queue_.front());
        queue_.pop_front();
        bytes_ -= item.event.payload.size();
        ready_.notify_all();
        return item;
    }

    // Call before a ReplaySource seek or stop so its blocked callback can finish.
    void cancel_replay() {
        std::lock_guard lock(mutex_);
        if (generation_)
            cancelled_through_ = generation_;
        accepting_ = false;
        reset_locked("cancel");
        ready_.notify_all();
    }

    // The old source must have stopped before a new source is admitted.
    void begin_source() {
        std::lock_guard lock(mutex_);
        generation_.reset();
        cancelled_through_.reset();
        accepting_ = true;
        reset_locked("source");
        ready_.notify_all();
    }

    void reset_after_error(uint64_t revision) {
        std::lock_guard lock(mutex_);
        if (revision == revision_)
            reset_locked("decode-error");
        ready_.notify_all();
    }

    void accepted_keyframe(uint64_t revision) {
        std::lock_guard lock(mutex_);
        if (revision == revision_)
            needs_keyframe_ = false;
    }

    void close() {
        std::lock_guard lock(mutex_);
        closed_ = true;
        queue_.clear();
        bytes_ = 0;
        ++revision_;
        ready_.notify_all();
    }

    bool current(uint64_t revision) const {
        std::lock_guard lock(mutex_);
        return !closed_ && revision == revision_;
    }

    State state() const {
        std::lock_guard lock(mutex_);
        return {queue_.size(), dropped_, revision_, needs_keyframe_};
    }

  private:
    static std::optional<uint64_t> replay_generation(const SessionEvent& event) {
        const auto value = event.attributes.find("replay_generation");
        if (value == event.attributes.end() || !value->is_number_unsigned()) {
            if (value == event.attributes.end() || !value->is_number_integer() ||
                value->get<int64_t>() < 0)
                return std::nullopt;
        }
        return value->get<uint64_t>();
    }

    void reset_locked(const char* reason) {
        queue_.clear();
        bytes_ = 0;
        ++revision_;
        needs_keyframe_ = true;
        SessionEvent reset;
        reset.kind = EventKind::Epoch;
        reset.attributes = {{"reset_decoder", true}, {"reason", reason}};
        queue_.push_back({std::move(reset), revision_});
    }

    const size_t max_frames_, max_bytes_;
    mutable std::mutex mutex_;
    std::condition_variable ready_;
    std::deque<Item> queue_;
    size_t bytes_ = 0;
    uint64_t revision_ = 0, dropped_ = 0;
    std::optional<uint64_t> generation_, cancelled_through_;
    bool accepting_ = true, closed_ = false, needs_keyframe_ = true;
};
} // namespace ceres::detail
