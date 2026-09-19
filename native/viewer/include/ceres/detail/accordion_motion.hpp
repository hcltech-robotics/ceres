#pragma once
#include <algorithm>
#include <array>
#include <cmath>

namespace ceres::detail {
// Selection is owned by the caller. Only one body is displayed during a switch.
class AccordionMotion {
  public:
    template <size_t N>
    void update(int requested, const std::array<float, N>& natural_heights, float max_height,
                float dt, bool animate = true) {
        requested = requested >= 0 && requested < static_cast<int>(N) ? requested : -1;
        max_height = std::isfinite(max_height) ? std::max(0.f, max_height) : 0.f;
        const auto body_height = [&](int section) {
            if (section < 0)
                return 0.f;
            const float natural = natural_heights[section];
            return std::isfinite(natural) && natural > 0.f ? std::min(natural, max_height)
                                                           : max_height;
        };
        if (!animate) {
            displayed_ = requested;
            settle(body_height(requested));
            return;
        }

        // Available space is a hard bound, including during a window resize.
        if (height_ > max_height)
            settle(max_height);
        float remaining = std::isfinite(dt) ? std::clamp(dt, 0.f, .05f) : 0.f;
        for (int phase = 0; phase < 3; ++phase) {
            if (displayed_ < 0) {
                displayed_ = requested;
                if (displayed_ < 0) {
                    settle(0.f);
                    return;
                }
            }
            const bool closing = displayed_ != requested;
            const float target = closing ? 0.f : body_height(displayed_);
            if (target != target_) {
                start_ = height_;
                target_ = target;
                elapsed_ = 0.f;
                duration_ = target_ > start_ ? .16f : .12f;
                moving_ = target_ != start_;
            }
            if (moving_) {
                const float consumed = std::min(remaining, duration_ - elapsed_);
                elapsed_ += consumed;
                remaining -= consumed;
                if (elapsed_ >= duration_ - .000001f) {
                    settle(target_);
                } else {
                    const float inverse = 1.f - elapsed_ / duration_;
                    const float eased = 1.f - inverse * inverse * inverse;
                    height_ = std::clamp(start_ + (target_ - start_) * eased, 0.f, max_height);
                }
            }
            if (closing && !moving_) {
                displayed_ = -1;
                settle(0.f);
                // Apply unused time to the newly selected body so refresh rate
                // does not add a frame of delay between closing and opening.
                continue;
            }
            return;
        }
    }
    int displayed() const {
        return displayed_;
    }
    float height() const {
        return height_;
    }
    bool moving() const {
        return moving_;
    }

  private:
    void settle(float height) {
        height_ = start_ = target_ = height;
        elapsed_ = duration_ = 0.f;
        moving_ = false;
    }
    int displayed_ = -1;
    float height_ = 0.f, start_ = 0.f, target_ = 0.f;
    float elapsed_ = 0.f, duration_ = 0.f;
    bool moving_ = false;
};
} // namespace ceres::detail
