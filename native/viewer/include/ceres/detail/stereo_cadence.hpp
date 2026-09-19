#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>

namespace ceres::detail {
// A window owns only scheduling state. The caller releases its queued frame
// leases whenever acquisition stops or a new window replaces the previous one.
class StereoCadence {
  public:
    struct Window {
        bool acquire = false;
        bool opened = false;
    };
    Window update(int64_t now_us, float hz, bool enabled = true) {
        if (!enabled) {
            reset();
            return {};
        }
        now_us = std::max<int64_t>(0, now_us);
        if (!std::isfinite(hz))
            hz = 2.f;
        const auto period = int64_t(std::llround(1000000. / std::clamp(hz, .2f, 5.f)));
        if (initialised_ && now_us < last_us_)
            reset();
        last_us_ = now_us;
        if (!initialised_) {
            initialised_ = true;
            period_us_ = period;
            open(now_us);
            return {true, true};
        }
        if (period != period_us_) {
            period_us_ = period;
            next_us_ = add(start_us_, period_us_);
        }
        if (acquiring_ && now_us - start_us_ >= window_us)
            acquiring_ = false;
        if (!acquiring_ && now_us >= next_us_) {
            // Anchor to this update, rather than replaying missed intervals.
            open(now_us);
            return {true, true};
        }
        return {acquiring_, false};
    }
    void finish() {
        acquiring_ = false;
    }
    void reset() {
        initialised_ = acquiring_ = false;
        last_us_ = start_us_ = next_us_ = period_us_ = 0;
    }
    static constexpr int64_t window_us = 120000;

  private:
    static int64_t add(int64_t time, int64_t duration) {
        return time > std::numeric_limits<int64_t>::max() - duration
                   ? std::numeric_limits<int64_t>::max()
                   : time + duration;
    }
    void open(int64_t now_us) {
        start_us_ = now_us;
        next_us_ = add(now_us, period_us_);
        acquiring_ = true;
    }
    bool initialised_ = false, acquiring_ = false;
    int64_t last_us_ = 0, start_us_ = 0, next_us_ = 0, period_us_ = 0;
};
} // namespace ceres::detail
