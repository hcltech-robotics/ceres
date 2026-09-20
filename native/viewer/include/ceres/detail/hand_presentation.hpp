#pragma once
#include "ceres/detail/tracking_visibility.hpp"
#include "ceres/types.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <optional>
#include <utility>

namespace ceres::detail {

// A live hand never waits for video or a saved inspection delay. Replay alone
// selects historical observations, without changing their recorded timestamps.
inline int64_t presentation_pose_offset_us(bool replay, float offset_ms) {
    return replay && std::isfinite(offset_ms)
               ? int64_t(std::clamp(offset_ms, -500.f, 500.f) * 1000.f)
               : 0;
}

// Presentation geometry only. Each available joint takes its newest source
// coordinates immediately. Missing joints retain their own coordinates and
// opacity clock, independently of the other joints, the headset and the video.
class HandPresentation {
  public:
    void reset() {
        *this = {};
    }

    void update(int64_t now_us, const PoseSample* source, bool fresh,
                uint32_t epoch, uint32_t space_epoch, bool source_mesh_supported) {
        const auto context = std::pair{epoch, space_epoch};
        if ((context_ && *context_ != context) || (tick_ && now_us < *tick_) || now_us < 0)
            reset();
        if (now_us < 0)
            return;
        context_ = context;
        tick_ = now_us;
        const bool matching = source && source->kind >= 2 && source->kind <= 3 &&
                              source->epoch == epoch && source->space_epoch == space_epoch;
        const bool newer = matching &&
                           (!sequence_ || int32_t(source->sequence - *sequence_) > 0);
        const bool current = matching && (!sequence_ || source->sequence == *sequence_ || newer);
        if (newer) {
            sequence_ = source->sequence;
            packet_tick_ = now_us;
            source_valid_ = source->valid;
            source_mask_ = source->joint_mask;
            // Retained coordinates below are deliberately separate from these
            // source fields. Nothing in this class enters recording or export.
            const auto coordinates = displayed_.values;
            displayed_ = *source;
            displayed_.values = coordinates;
            if (source->valid && source->joint_mask)
                mesh_supported_ = source_mesh_supported;
        }
        observed_mask_ = 0;
        displayed_.epoch = epoch;
        displayed_.space_epoch = space_epoch;
        displayed_.joint_mask = 0;
        for (size_t joint = 0; joint < joints_.size(); ++joint) {
            const auto bit = uint32_t{1} << joint;
            const bool available = current && source->valid && (source->joint_mask & bit) &&
                                   finite_joint(*source, joint);
            if (available && newer) {
                std::copy_n(source->values.begin() + joint * 8, 8,
                            displayed_.values.begin() + joint * 8);
                joint_sequence_[joint] = source->sequence;
                joint_observed_us_[joint] = source->observed_us;
            }
            // Clock uncertainty must not leave an older position on screen
            // when a newer source-valid joint has arrived. Repeated snapshots
            // can only prolong the hold while the source remains fresh.
            const bool observed = available &&
                                  (fresh || (packet_tick_ && now_us - *packet_tick_ <= 50000));
            if (observed)
                observed_mask_ |= bit;
            joints_[joint].update(now_us, observed, epoch, space_epoch);
            if (joints_[joint].retained())
                displayed_.joint_mask |= bit;
        }
        displayed_.valid = displayed_.joint_mask != 0;
    }

    const PoseSample& pose() const {
        return displayed_;
    }
    bool retained() const {
        return displayed_.joint_mask != 0;
    }
    uint32_t observed_mask() const {
        return observed_mask_;
    }
    bool source_valid() const {
        return source_valid_;
    }
    uint32_t source_mask() const {
        return source_mask_;
    }
    uint32_t joint_sequence(size_t joint) const {
        return joint_sequence_.at(joint);
    }
    int64_t joint_observed_us(size_t joint) const {
        return joint_observed_us_.at(joint);
    }
    float opacity(size_t joint) const {
        return joint < joints_.size() ? joints_[joint].alpha() : 0.f;
    }
    bool use_mesh(bool retained_palm_supported) const {
        return retained() && mesh_supported_ && retained_palm_supported;
    }

  private:
    static bool finite_joint(const PoseSample& source, size_t joint) {
        const auto first = source.values.begin() + joint * 8;
        return std::all_of(first, first + 8, [](float value) { return std::isfinite(value); });
    }
    PoseSample displayed_;
    std::array<TrackingVisibility, 25> joints_;
    std::array<uint32_t, 25> joint_sequence_{};
    std::array<int64_t, 25> joint_observed_us_{};
    std::optional<std::pair<uint32_t, uint32_t>> context_;
    std::optional<int64_t> tick_, packet_tick_;
    std::optional<uint32_t> sequence_;
    uint32_t observed_mask_ = 0, source_mask_ = 0;
    bool mesh_supported_ = false, source_valid_ = false;
};
} // namespace ceres::detail
