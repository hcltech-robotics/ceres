#pragma once
#include "ceres/spatial_observation.hpp"
#include "ceres/types.hpp"
#include <array>

namespace ceres {
inline constexpr int64_t hand_mask_max_age_us = 50000;

struct HandMaskCapture {
    int64_t receiver_time_us = 0, observed_us = 0, target_us = 0;
    uint32_t epoch = 0, space_epoch = 0;
    // Depth has source-clock timestamps. Stereo pairs have receiver-clock
    // associations only and must explicitly disable this additional gate.
    bool require_sender_time = true;
};

// Accept only original, unsmoothed observations. Depth uses the nearest source
// target time and stereo uses receiver time. Equal distances choose the earlier
// time, including an invalid observation. A tracking-loss packet must not fall
// back to earlier valid geometry. All available clocks retain the 50 ms gate.
class HandMaskBuilder {
  public:
    explicit HandMaskBuilder(HandMaskCapture capture);
    void observe(const PoseSample& pose, int64_t receiver_time_us);
    HandMaskSet finish() const;

  private:
    HandMaskCapture capture_;
    std::array<PoseSample, 2> poses_{};
    std::array<int64_t, 2> times_{};
    std::array<bool, 2> selected_{};
};
} // namespace ceres
