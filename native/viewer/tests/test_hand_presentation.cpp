#include "ceres/detail/hand_presentation.hpp"
#include <cmath>
#include <iostream>
#include <limits>
#include <stdexcept>

using ceres::PoseSample;
using ceres::detail::HandPresentation;
using ceres::detail::TrackingVisibility;
namespace {
void check(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}
bool close(float a, float b) {
    return std::abs(a - b) < 1e-5f;
}
PoseSample hand(uint32_t sequence, float position, uint32_t mask = (1u << 25) - 1) {
    PoseSample pose;
    pose.kind = 2;
    pose.valid = mask != 0;
    pose.epoch = 1;
    pose.space_epoch = 2;
    pose.sequence = sequence;
    pose.joint_mask = mask;
    pose.observed_us = pose.received_us = int64_t(sequence) * 10000;
    pose.target_us = pose.observed_us + 10000;
    for (int joint = 0; joint < 25; ++joint) {
        pose.values[joint * 8] = position + joint * .01f;
        pose.values[joint * 8 + 1] = 1.f;
        pose.values[joint * 8 + 6] = 1.f;
        pose.values[joint * 8 + 7] = .005f;
    }
    return pose;
}
void newest_hands_ignore_video_and_inspection_delay() {
    ceres::ReceiverSnapshot snapshot;
    snapshot.epoch = 1;
    snapshot.space_epoch = 2;
    snapshot.video_frames = 1;
    snapshot.poses[1] = hand(1, .1f);
    HandPresentation presentation;
    presentation.update(10000, &*snapshot.poses[1], true, 1, 2, true);
    // Video remains stalled and the headset is absent. A new hand is drawn at
    // its exact latest position even while the source clock is uncertain.
    snapshot.poses[1] = hand(2, .8f);
    const auto raw = *snapshot.poses[1];
    presentation.update(500000, &*snapshot.poses[1], false, 1, 2, true);
    check(close(presentation.pose().values[0], .8f) && presentation.pose().sequence == 2,
          "Latest valid hand waited for old video, headset tracking or clock freshness");
    check(snapshot.video_frames == 1 && !snapshot.poses[0], "Stalled video setup changed");
    presentation.update(510000, &*snapshot.poses[1], false, 1, 2, true);
    check(presentation.observed_mask() == raw.joint_mask,
          "Clock uncertainty flickered the recently received hand between viewer frames");
    check(presentation.joint_sequence(0) == raw.sequence &&
              presentation.joint_observed_us(0) == raw.observed_us,
          "Displayed wrist provenance does not identify its source observation");
    check(snapshot.poses[1]->values == raw.values && snapshot.poses[1]->joint_mask == raw.joint_mask &&
              snapshot.poses[1]->observed_us == raw.observed_us &&
              snapshot.poses[1]->target_us == raw.target_us && snapshot.poses[1]->valid == raw.valid,
          "Presentation changed raw source coordinates, validity or timestamps");
    check(ceres::detail::presentation_pose_offset_us(false, 500.f) == 0 &&
              ceres::detail::presentation_pose_offset_us(false, -100.f) == 0,
          "Saved replay delay delayed live hands");
    check(ceres::detail::presentation_pose_offset_us(true, 125.f) == 125000 &&
              ceres::detail::presentation_pose_offset_us(true, -125.f) == -125000,
          "Replay inspection delay changed");
}
void independent_joint_loss_and_immediate_reacquisition() {
    HandPresentation presentation;
    auto source = hand(1, .1f);
    presentation.update(0, &source, true, 1, 2, true);
    const auto retained_finger = presentation.pose().values[8];
    source = hand(2, .4f, 1u);
    presentation.update(10000, &source, true, 1, 2, false);
    check(close(presentation.pose().values[0], .4f) &&
              presentation.pose().values[8] == retained_finger &&
              presentation.pose().joint_mask == (1u << 25) - 1,
          "Partial tracking delayed the wrist or discarded a missing joint");
    check(!presentation.use_mesh(true), "Unsupported current palm kept a frozen mesh instead of current joints");
    presentation.update(TrackingVisibility::grace_us, &source, true, 1, 2, false);
    check(presentation.opacity(1) == 1 && presentation.opacity(0) == 1,
          "Missing joint flickered during its hold");
    presentation.update(TrackingVisibility::grace_us + TrackingVisibility::fade_us / 2,
                        &source, true, 1, 2, false);
    check(close(presentation.opacity(1), .5f) && presentation.opacity(0) == 1,
          "Missing joint fade was coupled to the observed wrist");
    source = hand(3, .9f);
    presentation.update(710000, &source, true, 1, 2, true);
    check(close(presentation.pose().values[8], .91f) && presentation.use_mesh(true),
          "Reacquired joint or mesh waited for interpolation");
    check(close(presentation.opacity(1), .5f), "Reacquisition did not preserve opacity continuity");
    presentation.update(710000 + TrackingVisibility::recovery_us, &source, true, 1, 2, true);
    check(presentation.opacity(1) == 1, "Joint opacity did not finish recovery");
    auto old = hand(2, -.5f);
    presentation.update(800000, &old, true, 1, 2, false);
    check(close(presentation.pose().values[0], .9f), "Reordered packet replaced a newer hand");
}
void whole_hand_loss_and_mesh_fallback() {
    HandPresentation presentation;
    auto source = hand(1, .2f);
    presentation.update(0, &source, true, 1, 2, true);
    source = hand(2, 0, 0);
    presentation.update(10000, &source, false, 1, 2, false);
    check(presentation.use_mesh(true) && presentation.opacity(0) == 1,
          "Whole-hand loss immediately removed its retained mesh");
    presentation.update(700000, &source, false, 1, 2, false);
    check(close(presentation.opacity(0), .5f) && close(presentation.opacity(24), .5f),
          "Whole-hand fade differs from per-joint fade");
    presentation.update(TrackingVisibility::hold_us, &source, false, 1, 2, false);
    check(!presentation.retained() && !presentation.use_mesh(true),
          "Hand geometry survived the bounded hold and fade");
    source = hand(3, 1.2f, 1u << 4);
    presentation.update(1300000, &source, true, 1, 2, false);
    check(presentation.retained() && presentation.pose().joint_mask == (1u << 4) &&
              close(presentation.pose().values[32], 1.24f) && presentation.opacity(4) > 0 &&
              !presentation.use_mesh(false),
          "Isolated reacquired fingertip did not provide immediate fallback geometry");
}
void contexts_and_independent_hands() {
    HandPresentation left, right;
    auto l = hand(0xfffffffeu, .1f), r = hand(1, -.1f);
    r.kind = 3;
    left.update(0, &l, true, 1, 2, true);
    right.update(0, &r, true, 1, 2, true);
    left.update(700000, nullptr, false, 1, 2, false);
    right.update(700000, &r, true, 1, 2, true);
    check(close(left.opacity(0), .5f) && right.opacity(0) == 1,
          "One hand's tracking loss faded the other hand");
    l = hand(1, .6f);
    left.update(710000, &l, true, 1, 2, true);
    check(close(left.pose().values[0], .6f), "Sequence rollover rejected a new joint");
    left.update(720000, &l, true, 1, 3, true);
    check(!left.retained(), "Retained joints crossed a reference-space change");
    l.space_epoch = 3;
    left.update(730000, &l, true, 1, 3, true);
    left.update(740000, &l, true, 2, 3, true);
    check(!left.retained(), "Retained joints crossed a connection epoch");
    l.epoch = 2;
    left.update(750000, &l, true, 2, 3, true);
    left.update(100, nullptr, false, 2, 3, false);
    check(!left.retained(), "Backward replay retained a future hand");
    left.update(200, &l, true, 2, 3, true);
    left.reset();
    check(!left.retained(), "Explicit reset retained a hand");
    l.values[0] = std::numeric_limits<float>::quiet_NaN();
    l.joint_mask = 1u;
    left.update(300, &l, true, 2, 3, true);
    check(!left.retained(), "Non-finite joint created presentation geometry");
}
} // namespace
int main() {
    try {
        newest_hands_ignore_video_and_inspection_delay();
        independent_joint_loss_and_immediate_reacquisition();
        whole_hand_loss_and_mesh_fallback();
        contexts_and_independent_hands();
        std::cout << "Latest hand positions, independent joint fading and mesh fallback passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
