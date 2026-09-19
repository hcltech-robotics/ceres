#pragma once
#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <numeric>

namespace ceres::detail {
// Feed a button's result and its current item state. Keyboard activation may be
// reported on key-down, so it is retained until the corresponding release.
class HoldPress {
  public:
    enum class Action { None, Primary, Stop };
    struct Input {
        double now = 0.;
        bool pressed = false;
        bool active = false;
        bool hovered = false;
        bool enabled = true;
        bool stop_available = false;
        bool cancel = false;
    };
    static constexpr double hold_seconds = .8;

    Action update(const Input& input) {
        if (!input.enabled || input.cancel || !std::isfinite(input.now)) {
            cancel();
            if (!input.active)
                state_ = State::Idle;
            return Action::None;
        }
        if (state_ == State::Cancelled || state_ == State::Stopped) {
            if (!input.active) {
                state_ = State::Idle;
                progress_ = 0.f;
                activated_ = false;
            }
            return Action::None;
        }
        if (state_ == State::Idle) {
            if (!input.active)
                return input.pressed ? Action::Primary : Action::None;
            if (!input.hovered) {
                cancel();
                return Action::None;
            }
            state_ = State::Holding;
            began_ = input.now;
            can_stop_ = input.stop_available;
            activated_ = false;
        }
        if (!input.hovered || input.now < began_ || (can_stop_ && !input.stop_available)) {
            cancel();
            if (!input.active)
                state_ = State::Idle;
            return Action::None;
        }
        activated_ = activated_ || input.pressed;
        progress_ = can_stop_
                        ? static_cast<float>(std::clamp((input.now - began_) / hold_seconds, 0., 1.))
                        : 0.f;
        if (can_stop_ && input.now - began_ >= hold_seconds &&
            (input.active || activated_)) {
            state_ = input.active ? State::Stopped : State::Idle;
            if (!input.active) {
                progress_ = 0.f;
                activated_ = false;
            }
            return Action::Stop;
        }
        if (!input.active) {
            state_ = State::Idle;
            progress_ = 0.f;
            const auto action = activated_ ? Action::Primary : Action::None;
            activated_ = false;
            return action;
        }
        return Action::None;
    }
    float progress() const {
        return progress_;
    }
    bool holding() const {
        return state_ == State::Holding;
    }
    // A source change consumes the pending release of any previous gesture.
    void reset() {
        cancel();
    }

  private:
    enum class State { Idle, Holding, Cancelled, Stopped };
    void cancel() {
        state_ = State::Cancelled;
        progress_ = 0.f;
        can_stop_ = false;
        activated_ = false;
    }
    State state_ = State::Idle;
    double began_ = 0.;
    float progress_ = 0.f;
    bool can_stop_ = false;
    bool activated_ = false;
};

// Entries are actual observations, including zero. Elapsed intervals are never backfilled.
template <std::size_t Capacity = 60> class RateHistory {
    static_assert(Capacity > 0);

  public:
    bool sample(double now, float rate, double interval = 1.) {
        if (!std::isfinite(now) || !std::isfinite(rate) || rate < 0.f ||
            !std::isfinite(interval) || interval <= 0.)
            return false;
        if (has_time_ && now < last_time_)
            reset();
        if (has_time_ && now - last_time_ < interval)
            return false;
        values_[next_] = rate;
        next_ = (next_ + 1) % Capacity;
        count_ = std::min(count_ + 1, Capacity);
        last_time_ = now;
        has_time_ = true;
        return true;
    }
    std::size_t size() const {
        return count_;
    }
    float sample(std::size_t index) const {
        assert(index < count_);
        return values_[(next_ + Capacity - count_ + index) % Capacity];
    }
    float maximum() const {
        float result = 0.f;
        for (std::size_t index = 0; index < count_; ++index)
            result = std::max(result, sample(index));
        return result;
    }
    void reset() {
        count_ = next_ = 0;
        last_time_ = 0.;
        has_time_ = false;
    }

  private:
    std::array<float, Capacity> values_{};
    std::size_t count_ = 0, next_ = 0;
    double last_time_ = 0.;
    bool has_time_ = false;
};

// Clock, record, elapsed, replay, cycle/task/rep, next, pass, fail, remaining and three rates.
inline std::array<float, 12> recording_bar_widths(float width, float scale = 1.f) {
    std::array<float, 12> result{};
    if (!std::isfinite(width) || width <= 0.f)
        return result;
    scale = std::isfinite(scale) && scale > 0.f ? std::clamp(scale, .25f, 8.f) : 1.f;
    constexpr std::array<float, 12> minimum{80.f, 40.f, 96.f, 40.f, 98.f, 40.f, 36.f, 36.f, 60.f, 48.f, 48.f, 48.f};
    constexpr std::array<float, 12> desired{112.f, 48.f, 152.f, 56.f, 148.f, 56.f, 48.f, 48.f, 96.f, 92.f, 92.f, 92.f};
    constexpr std::array<float, 12> extra{1.f, 0.f, 1.5f, 0.f, 1.5f, 0.f, 0.f, 0.f, .5f, 1.f, 1.f, 1.f};
    const double minimum_sum = std::accumulate(minimum.begin(), minimum.end(), 0.) * scale;
    const double desired_sum = std::accumulate(desired.begin(), desired.end(), 0.) * scale;
    const double extra_sum = std::accumulate(extra.begin(), extra.end(), 0.);
    float assigned = 0.f;
    for (std::size_t index = 0; index + 1 < result.size(); ++index) {
        double cell = 0.;
        if (width < minimum_sum) {
            cell = width * (minimum[index] * scale / minimum_sum);
        } else if (width < desired_sum) {
            const double blend = (width - minimum_sum) / (desired_sum - minimum_sum);
            cell = scale * (minimum[index] + blend * (desired[index] - minimum[index]));
        } else {
            cell = desired[index] * scale + (width - desired_sum) * extra[index] / extra_sum;
        }
        result[index] = std::clamp(static_cast<float>(cell), 0.f, width - assigned);
        assigned += result[index];
    }
    result.back() = width - assigned;
    return result;
}
} // namespace ceres::detail
