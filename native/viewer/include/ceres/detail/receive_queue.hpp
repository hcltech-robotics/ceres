#pragma once
#include <array>
#include <cstddef>
#include <deque>
#include <optional>
#include <utility>

namespace ceres::detail {
enum class ReceivePriority : size_t { Control, Pose, Video, Depth };

// The receiver owns synchronisation. Each lane has its own capacity, so media
// bursts cannot consume pose capacity or sit ahead of newly arrived hands.
template <class T> class ReceiveQueue {
  public:
    bool push(ReceivePriority priority, T value, size_t bytes) {
        auto& lane = lanes_[size_t(priority)];
        const auto limit = limits_[size_t(priority)];
        if (lane.items.size() >= limit.items || bytes > limit.bytes - lane.bytes)
            return false;
        lane.bytes += bytes;
        lane.items.push_back({std::move(value), bytes});
        return true;
    }

    std::optional<T> pop() {
        for (auto& lane : lanes_) {
            if (lane.items.empty())
                continue;
            auto value = std::move(lane.items.front());
            lane.items.pop_front();
            lane.bytes -= value.bytes;
            return std::move(value.value);
        }
        return std::nullopt;
    }

    bool empty() const {
        for (const auto& lane : lanes_)
            if (!lane.items.empty())
                return false;
        return true;
    }

    void clear() {
        for (auto& lane : lanes_) {
            lane.items.clear();
            lane.bytes = 0;
        }
    }

  private:
    struct Entry { T value; size_t bytes; };
    struct Lane { std::deque<Entry> items; size_t bytes = 0; };
    struct Limit { size_t items, bytes; };
    static constexpr std::array<Limit, 4> limits_{
        {{512, 512 * 1024}, {4096, 4 * 1024 * 1024},
         {2048, 4 * 1024 * 1024}, {256, 1024 * 1024}}};
    std::array<Lane, 4> lanes_;
};
} // namespace ceres::detail
