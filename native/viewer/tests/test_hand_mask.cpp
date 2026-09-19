#include "ceres/hand_mask.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <type_traits>

namespace {
using namespace ceres;

void check(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}

HandMaskCapture capture() {
    return {1000000, 2000000, 2010000, 7, 3, true};
}

PoseSample hand(unsigned kind = 2, float offset = 0) {
    PoseSample result;
    result.kind = static_cast<uint8_t>(kind);
    result.valid = true;
    result.epoch = 7;
    result.space_epoch = 3;
    result.observed_us = 2000000;
    result.target_us = 2010000;
    result.joint_mask = (1u << 25) - 1;
    constexpr std::array<std::array<float, 2>, 25> positions{{
        {0, 0}, {-.025f, .018f}, {-.050f, .030f}, {-.070f, .050f}, {-.085f, .065f},
        {-.020f, .040f}, {-.033f, .080f}, {-.034f, .120f}, {-.035f, .147f}, {-.035f, .170f},
        {0, .043f}, {0, .088f}, {0, .135f}, {0, .164f}, {0, .190f},
        {.019f, .040f}, {.025f, .080f}, {.028f, .123f}, {.030f, .151f}, {.032f, .176f},
        {.035f, .033f}, {.049f, .065f}, {.057f, .098f}, {.061f, .123f}, {.064f, .147f}}};
    for (unsigned joint = 0; joint < positions.size(); ++joint) {
        auto* values = result.values.data() + joint * 8;
        values[0] = positions[joint][0] + offset;
        values[1] = positions[joint][1];
        values[2] = -.5f;
        values[6] = 1;
        values[7] = .006f;
    }
    return result;
}

HandMaskSet mask(const PoseSample& pose, int64_t time = 1000000) {
    HandMaskBuilder builder(capture());
    builder.observe(pose, time);
    return builder.finish();
}

bool empty(const HandMaskSet& mask) {
    return mask.capsule_count == 0 && mask.palm_count == 0;
}

void anatomical_volumes() {
    const auto sample = hand();
    auto result = mask(sample);
    check(result.capsule_count == 25 && result.palm_count == 1,
          "A complete hand needs connected bones and a filled palm");
    for (unsigned joint = 0; joint < 25; ++joint) {
        const auto* value = sample.values.data() + joint * 8;
        check(hand_mask_contains(result, value[0], value[1], value[2]),
              "A tracked joint escaped its hand volume");
    }
    check(hand_mask_contains(result, -.035f, .158f, -.5f),
          "A finger segment was represented only by endpoint spheres");
    check(!hand_mask_contains(result, .25f, .08f, -.5f) &&
              !hand_mask_contains(result, 0, .04f, -.4f),
          "A hand mask removed unrelated surrounding geometry");
    auto skeleton = result;
    skeleton.palm_count = 0;
    bool palm_fills_gap = false;
    for (int y = 1; y < 40; ++y)
        for (int x = -20; x < 20; ++x)
            if (hand_mask_contains(result, x * .002f, y * .002f, -.5f) &&
                !hand_mask_contains(skeleton, x * .002f, y * .002f, -.5f))
                palm_fills_gap = true;
    check(palm_fills_gap, "Palm interior still has gaps between bone capsules");

    HandMaskBuilder both(capture());
    both.observe(sample, 1000000);
    both.observe(hand(3, .3f), 1000000);
    result = both.finish();
    check(result.capsule_count == 50 && result.palm_count == 2 &&
              hand_mask_contains(result, .3f, .04f, -.5f) &&
              !hand_mask_contains(result, .15f, .04f, -.5f),
          "Left and right hands were joined or exceeded their fixed mask budget");
}

void camera_ray_occlusion() {
    const auto result = mask(hand());
    const float camera[]{0, .04f, 0};
    const float background[]{0, .04f, -2};
    const float foreground[]{0, .04f, -.2f};
    const float clear_background[]{.8f, .04f, -2};
    check(hand_mask_occludes(result, camera, background),
          "A visible hand failed to protect the static background behind it");
    check(!hand_mask_occludes(result, camera, foreground),
          "A hand behind a voxel shielded the foreground from new evidence");
    check(!hand_mask_occludes(result, camera, clear_background),
          "A ray passing beside the hand was treated as occluded");
    auto palm_only = result;
    palm_only.capsule_count = 0;
    check(hand_mask_occludes(palm_only, camera, background) &&
              !hand_mask_occludes(palm_only, camera, foreground),
          "The filled palm did not clip the finite camera ray correctly");

    HandMaskSet capsule;
    capsule.capsule_count = 1;
    capsule.capsules[0] = {{-.05f, 0, -.5f}, {.05f, 0, -.5f}, .01f};
    const float origin[]{0, 0, 0}, end[]{0, 0, -1};
    const float parallel_from[]{-.1f, .005f, -.5f}, parallel_to[]{.1f, .005f, -.5f};
    const float outside_from[]{-.1f, .02f, -.5f}, outside_to[]{.1f, .02f, -.5f};
    check(hand_mask_occludes(capsule, origin, end) &&
              hand_mask_occludes(capsule, parallel_from, parallel_to) &&
              !hand_mask_occludes(capsule, outside_from, outside_to),
          "Capsule intersections failed for crossing or parallel rays");
    const float point[]{0, 0, -.5f};
    check(hand_mask_occludes(capsule, point, point), "A degenerate ray inside a capsule was lost");
    const float nan = std::numeric_limits<float>::quiet_NaN();
    const float invalid[]{nan, 0, 0};
    check(!hand_mask_occludes(capsule, invalid, end) &&
              !hand_mask_contains(capsule, nan, 0, -.5f),
          "Nonfinite geometry generated a hand exclusion");
}

void transformed_tracking_space() {
    auto sample = hand();
    for (unsigned joint = 0; joint < 25; ++joint) {
        float* values = sample.values.data() + joint * 8;
        const float x = values[0], y = values[1], z = values[2];
        values[0] = z + 1;
        values[1] = x - .2f;
        values[2] = y + 2;
    }
    const auto result = mask(sample);
    const float camera[]{1, -.2f, 2.04f}, background[]{-1, -.2f, 2.04f};
    const float foreground[]{.8f, -.2f, 2.04f};
    check(result.palm_count == 1 && hand_mask_contains(result, .5f, -.2f, 2.04f) &&
              !hand_mask_contains(result, .6f, -.2f, 2.04f) &&
              hand_mask_occludes(result, camera, background) &&
              !hand_mask_occludes(result, camera, foreground),
          "Rotating and translating the tracking world changed hand exclusion geometry");
}

void temporal_association() {
    auto sample = hand();
    check(!empty(mask(sample, 950000)) && !empty(mask(sample, 1050000)) &&
              empty(mask(sample, 949999)) && empty(mask(sample, 1050001)),
          "Receiver-time freshness did not preserve the 50 ms boundary");
    for (const bool observed : {false, true}) {
        sample = hand();
        (observed ? sample.observed_us : sample.target_us) += 50001;
        check(empty(mask(sample)), "Mismatched source time contributed hand geometry");
    }
    sample = hand();
    ++sample.epoch;
    check(empty(mask(sample)), "A prior connection contributed a hand mask");
    sample = hand();
    ++sample.space_epoch;
    check(empty(mask(sample)), "A prior reference space contributed a hand mask");
    sample = hand();
    sample.kind = 1;
    check(empty(mask(sample)), "A head pose was interpreted as a hand");

    HandMaskBuilder closest(capture());
    closest.observe(hand(2, .3f), 1030000);
    closest.observe(hand(), 980000);
    auto result = closest.finish();
    check(hand_mask_contains(result, 0, .04f, -.5f) &&
              !hand_mask_contains(result, .3f, .04f, -.5f),
          "Nearest hand selection depended on packet arrival order");
    for (bool earlier_first : {false, true}) {
        HandMaskBuilder tied(capture());
        tied.observe(hand(2, earlier_first ? 0 : .3f), earlier_first ? 980000 : 1020000);
        tied.observe(hand(2, earlier_first ? .3f : 0), earlier_first ? 1020000 : 980000);
        check(hand_mask_contains(tied.finish(), 0, .04f, -.5f),
              "Equal-time distances did not resolve towards the earlier observation");
    }
    HandMaskBuilder lost(capture());
    lost.observe(hand(), 990000);
    auto invalid = hand();
    invalid.valid = false;
    invalid.joint_mask = 0;
    lost.observe(invalid, 1000000);
    check(empty(lost.finish()), "Tracking loss reused a previously valid hand mask");

    auto stereo_capture = capture();
    stereo_capture.require_sender_time = false;
    stereo_capture.observed_us = stereo_capture.target_us = 0;
    HandMaskBuilder stereo(stereo_capture);
    stereo.observe(hand(), 1000000);
    check(!empty(stereo.finish()), "Stereo receiver-time associations were rejected");
    check(empty(mask(hand(), std::numeric_limits<int64_t>::min())),
          "A malformed receiver time overflowed the freshness check");
}

void predicted_capture_association() {
    auto depth = capture();
    depth.receiver_time_us = 1030000;
    depth.target_us = depth.observed_us + 30000;
    auto capture_hand = hand();
    capture_hand.target_us = depth.target_us;
    auto later_hand = hand(2, .3f);
    later_hand.observed_us += 30000;
    later_hand.target_us = depth.target_us + 30000;
    for (const bool capture_first : {false, true}) {
        HandMaskBuilder builder(depth);
        builder.observe(capture_first ? capture_hand : later_hand,
                        capture_first ? 1000000 : 1030000);
        builder.observe(capture_first ? later_hand : capture_hand,
                        capture_first ? 1030000 : 1000000);
        const auto result = builder.finish();
        check(hand_mask_contains(result, 0, .04f, -.5f) &&
                  !hand_mask_contains(result, .3f, .04f, -.5f),
              "XR prediction lead selected a later hand instead of the matching capture target");
    }

    auto earlier = capture_hand;
    earlier.target_us -= 10000;
    auto later = later_hand;
    later.target_us = depth.target_us + 10000;
    HandMaskBuilder tie(depth);
    tie.observe(later, 1030000);
    tie.observe(earlier, 1020000);
    check(hand_mask_contains(tie.finish(), 0, .04f, -.5f),
          "Equal source-target distances did not select the earlier capture target");

    auto lost = capture_hand;
    lost.valid = false;
    lost.joint_mask = 0;
    HandMaskBuilder invalid(depth);
    invalid.observe(later_hand, 1030000);
    invalid.observe(lost, 1000000);
    check(empty(invalid.finish()),
          "Invalid tracking at the exact capture target fell back to a later valid hand");
}

void missing_and_malformed_joints() {
    auto sample = hand();
    sample.joint_mask = 1u << 9;
    auto result = mask(sample);
    check(result.capsule_count == 1 && result.palm_count == 0 &&
              hand_mask_contains(result, -.035f, .17f, -.5f) &&
              !hand_mask_contains(result, -.035f, .13f, -.5f),
          "An isolated fingertip extrapolated a missing finger or palm");
    sample = hand();
    sample.joint_mask &= ~(1u << 6);
    result = mask(sample);
    check(result.capsule_count == 24 && result.palm_count == 0,
          "A palm was filled without its required tracked anchors");
    sample = hand();
    sample.joint_mask = (1u << 3) | (1u << 4);
    sample.values[3 * 8] = -1;
    result = mask(sample);
    check(result.capsule_count == 2 && !hand_mask_contains(result, -.5f, .05f, -.5f),
          "An implausible bone erased a large region between disconnected joints");
    for (const float invalid : {-.01f, 10.f, std::numeric_limits<float>::quiet_NaN()}) {
        sample = hand();
        sample.joint_mask = 1u;
        sample.values[7] = invalid;
        check(empty(mask(sample)), "An invalid radius contributed a hand volume");
    }
    sample = hand();
    for (unsigned joint = 0; joint < 25; ++joint)
        sample.values[joint * 8] = sample.values[joint * 8 + 1] = 0;
    result = mask(sample);
    check(result.palm_count == 0 && !hand_mask_contains(result, .1f, .1f, -.5f),
          "Collapsed palm anchors generated an unbounded palm volume");
}

void malformed_mask_geometry() {
    const float camera[]{0, 0, 0}, background[]{0, 0, -2};
    check(valid_hand_mask({}), "An empty mask was rejected");
    check(valid_hand_mask(mask(hand())), "An anatomical hand mask was rejected");
    HandMaskSet invalid;
    invalid.palm_count = 1;
    auto rejected = [&](const HandMaskSet& value) {
        return !valid_hand_mask(value) && !hand_mask_contains(value, 0, 0, -1) &&
               !hand_mask_occludes(value, camera, background);
    };
    check(rejected(invalid), "Zero palm axes masked arbitrary geometry");
    invalid = mask(hand());
    invalid.capsule_count = 0;
    invalid.palms[0].axes[0] = std::numeric_limits<float>::quiet_NaN();
    check(rejected(invalid), "A nonfinite palm axis masked arbitrary camera rays");
    invalid = mask(hand());
    invalid.capsule_count = 0;
    std::copy_n(invalid.palms[0].axes, 3, invalid.palms[0].axes + 3);
    check(rejected(invalid), "Nonorthogonal palm axes were accepted");
    invalid = {};
    invalid.capsule_count = 1;
    invalid.capsules[0] = {{0, 0, -.5f}, {0, 0, -.6f},
                           std::numeric_limits<float>::infinity()};
    check(rejected(invalid), "An infinite capsule radius masked the whole map");
    invalid.capsules[0].radius = .01f;
    invalid.capsules[0].from[0] = std::numeric_limits<float>::quiet_NaN();
    check(rejected(invalid), "A nonfinite capsule endpoint generated an exclusion");
    invalid = {};
    invalid.capsule_count = hand_mask_max_capsules + 1;
    check(!valid_hand_mask(invalid), "An oversized mask count was accepted");
}
} // namespace

int main() {
    try {
        static_assert(std::is_trivially_copyable_v<HandMaskSet>);
        static_assert(std::is_trivially_copyable_v<ProjectiveDepthObservation>);
        anatomical_volumes();
        camera_ray_occlusion();
        transformed_tracking_space();
        temporal_association();
        predicted_capture_association();
        missing_and_malformed_joints();
        malformed_mask_geometry();
        std::cout << "Hand volume, ray occlusion, freshness, epoch and invalid-joint checks passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
