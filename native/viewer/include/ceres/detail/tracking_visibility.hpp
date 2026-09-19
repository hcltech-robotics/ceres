#pragma once
#include <algorithm>
#include <cstdint>
#include <optional>
#include <utility>

namespace ceres::detail {
// Presentation only. Source validity and the receiver's freshness policy are unchanged.
class TrackingVisibility {
  public:
    enum class LossPolicy { Fade, Hold };
    static constexpr int64_t grace_us = 120000;
    static constexpr int64_t hold_us = 1000000;
    static constexpr int64_t recovery_us = 80000;

    void reset() {
        *this = {};
    }

    float update(int64_t now_us, bool tracked, uint32_t epoch, uint32_t space_epoch,
                 LossPolicy loss_policy = LossPolicy::Fade) {
        const auto context = std::pair{epoch, space_epoch};
        if ((context_ && *context_ != context) || (tick_ && now_us < *tick_) || now_us < 0)
            reset();
        if (now_us < 0)
            return 0;
        context_ = context;
        tick_ = now_us;
        if (tracked) {
            if (!last_valid_) {
                alpha_ = 1.f;
                recovering_ = false;
            } else if (!was_tracked_) {
                recovery_start_ = now_us;
                recovery_from_ = alpha_;
                recovering_ = true;
            }
            if (recovering_) {
                const float progress = smooth(double(now_us - recovery_start_) / recovery_us);
                alpha_ = recovery_from_ + (1.f - recovery_from_) * progress;
                recovering_ = now_us - recovery_start_ < recovery_us;
            }
            last_valid_ = now_us;
            retained_ = true;
        } else if (last_valid_) {
            if (was_tracked_) {
                loss_alpha_ = alpha_;
                recovering_ = false;
            }
            if (loss_policy == LossPolicy::Hold) {
                retained_ = true;
                alpha_ = loss_alpha_;
            } else {
                const auto age = now_us - *last_valid_;
                retained_ = age < hold_us;
                alpha_ = loss_alpha_ *
                         (1.f - smooth(double(age - grace_us) / (hold_us - grace_us)));
            }
        } else {
            alpha_ = 0;
            retained_ = false;
        }
        was_tracked_ = tracked;
        return alpha_;
    }
    float alpha() const {
        return alpha_;
    }
    bool retained() const {
        return retained_;
    }

  private:
    static float smooth(double value) {
        const auto t = float(std::clamp(value, 0.0, 1.0));
        return t * t * (3.f - 2.f * t);
    }
    std::optional<std::pair<uint32_t, uint32_t>> context_;
    std::optional<int64_t> tick_, last_valid_;
    int64_t recovery_start_ = 0;
    float alpha_ = 0, loss_alpha_ = 1, recovery_from_ = 0;
    bool was_tracked_ = false, recovering_ = false, retained_ = false;
};
} // namespace ceres::detail
