#pragma once
#include "ceres/protocol.hpp"
#include <algorithm>
#include <array>
#include <cstdlib>
#include <utility>
#include <deque>
#include <limits>
#include <optional>
#include <tuple>

namespace ceres::detail {
// The source media clock is shared through RTCP sender reports. RTP counters and
// receiver-arrival anchors are deliberately not used to match the two cameras.
template <class Frame> class StereoPairQueue {
  public:
    struct Pair {
        Frame left, right;
        int64_t skew_us = 0;
    };
    void clear() {
        queues_ = {};
        last_ = {};
        context_.reset();
    }
    bool push(Frame frame, const SessionEvent& event) {
        const auto side = event.attributes.value("camera_side", std::string{});
        if (side != "left" && side != "right")
            return false;
        const auto stamp = event.attributes.find("sender_ntp_us");
        if (stamp == event.attributes.end() || !stamp->is_number_integer() ||
            stamp->get<double>() <= 0 || stamp->get<double>() > 9007199254740991.0)
            return false;
        const auto generation = event.attributes.value("replay_generation", uint64_t{0});
        const auto context = std::tuple{event.epoch, event.space_epoch, generation};
        if (context_ && *context_ != context)
            clear();
        context_ = context;
        const size_t index = side == "left" ? 0 : 1;
        if (last_[index] && !newer_sequence(event.sequence, *last_[index]))
            return false;
        const auto time = stamp->get<int64_t>();
        if (!queues_[index].empty() && time <= queues_[index].back().time_us)
            return false;
        last_[index] = event.sequence;
        queues_[index].push_back({std::move(frame), time});
        while (queues_[index].size() > capacity)
            queues_[index].pop_front();
        return true;
    }
    std::optional<Pair> take(int64_t max_skew_us) {
        max_skew_us = std::clamp<int64_t>(max_skew_us, 0, 30000);
        size_t left = 0, right = 0;
        int64_t best = std::numeric_limits<int64_t>::max();
        for (size_t l = 0; l < queues_[0].size(); ++l)
            for (size_t r = 0; r < queues_[1].size(); ++r) {
                const auto difference = std::abs(queues_[0][l].time_us - queues_[1][r].time_us);
                if (difference < best) {
                    best = difference;
                    left = l;
                    right = r;
                }
            }
        if (best > max_skew_us)
            return std::nullopt;
        Pair result{std::move(queues_[0][left].frame), std::move(queues_[1][right].frame),
                    queues_[1][right].time_us - queues_[0][left].time_us};
        queues_[0].erase(queues_[0].begin(), queues_[0].begin() + left + 1);
        queues_[1].erase(queues_[1].begin(), queues_[1].begin() + right + 1);
        return result;
    }
    size_t queued() const {
        return queues_[0].size() + queues_[1].size();
    }
    // Leave decoder surfaces available for conversion and reconstruction.
    static constexpr size_t capacity = 2;

  private:
    struct Entry {
        Frame frame;
        int64_t time_us;
    };
    std::array<std::deque<Entry>, 2> queues_;
    std::array<std::optional<uint32_t>, 2> last_;
    std::optional<std::tuple<uint32_t, uint32_t, uint64_t>> context_;
};
} // namespace ceres::detail
