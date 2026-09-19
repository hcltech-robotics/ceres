#include "ceres/hand_trails.hpp"
#include <algorithm>
#include <cmath>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <type_traits>
#include <vector>

namespace {
using ceres::HandColour;
using ceres::HandTrails;
using ceres::HandTrailSegment;
using ceres::TrailMode;

void check(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}

bool near(const std::array<float, 3>& actual, const std::array<float, 3>& expected,
          float tolerance = 1e-5f) {
    for (size_t axis = 0; axis < actual.size(); ++axis)
        if (!std::isfinite(actual[axis]) || std::abs(actual[axis] - expected[axis]) > tolerance)
            return false;
    return true;
}

void colour_maths() {
    using ceres::hand_colour;
    check(near(hand_colour(HandColour::side, 0, {}, {}), {.27f, .64f, .95f}) &&
              near(hand_colour(HandColour::side, 1, {}, {}), {.95f, .47f, .38f}),
          "Hand sides lost their established colours");
    check(near(hand_colour(HandColour::normals, 0, {1, 0, -1}, {}), {1, .5f, 0}),
          "Normal components were not mapped to RGB");
    check(near(hand_colour(HandColour::velocity, 0, {}, {}), {0, 0, .5f}) &&
              near(hand_colour(HandColour::velocity, 0, {}, {.375f, 0, 0}), {0, .5f, 1}) &&
              near(hand_colour(HandColour::velocity, 0, {}, {0, -.75f, 0}), {.5f, 1, .5f}) &&
              near(hand_colour(HandColour::velocity, 0, {}, {0, 0, 1.5f}), {.5f, 0, 0}),
          "Velocity colours do not follow the 1.5 metre-per-second jet scale");
    check(near(hand_colour(HandColour::motion_flow, 0, {}, {}), {1, 1, 1}) &&
              near(hand_colour(HandColour::motion_flow, 0, {}, {1.5f, 0, 0}), {1, 0, 0}) &&
              near(hand_colour(HandColour::motion_flow, 0, {}, {.75f, 0, 0}), {1, .5f, .5f}) &&
              near(hand_colour(HandColour::motion_flow, 0, {}, {-1.5f, 0, 0}), {0, 17.f / 22, 1}) &&
              near(hand_colour(HandColour::motion_flow, 0, {}, {0, 0, 1.5f}), {1, 11.f / 12, 0}) &&
              near(hand_colour(HandColour::motion_flow, 0, {}, {0, 0, -1.5f}), {21.f / 52, 0, 1}) &&
              near(hand_colour(HandColour::motion_flow, 0, {}, {0, 2, 0}), {1, 1, 1}),
          "Middlebury colours differ from the web app X/Z wheel or magnitude saturation");
    const float nan = std::numeric_limits<float>::quiet_NaN();
    const float inf = std::numeric_limits<float>::infinity();
    for (const auto mode :
         {HandColour::side, HandColour::normals, HandColour::velocity, HandColour::motion_flow}) {
        for (const auto value : {std::array<float, 3>{nan, inf, -inf},
                                 std::array<float, 3>{std::numeric_limits<float>::max(), 0, 0}}) {
            const auto colour = hand_colour(mode, 0, value, value);
            check(std::all_of(colour.begin(), colour.end(),
                              [](float channel) {
                                  return std::isfinite(channel) && channel >= 0 && channel <= 1;
                              }),
                  "Colour maths emitted non-finite or unbounded channels");
        }
    }
}

ceres::ReceiverSnapshot snapshot(int64_t time, uint32_t sequence) {
    ceres::ReceiverSnapshot result;
    result.epoch = 7;
    result.space_epoch = 2;
    result.now_us = time;
    result.clock.valid = true;
    for (size_t hand = 0; hand < 2; ++hand) {
        ceres::PoseSample pose;
        pose.kind = static_cast<uint8_t>(hand + 2);
        pose.valid = true;
        pose.epoch = result.epoch;
        pose.space_epoch = result.space_epoch;
        pose.sequence = sequence;
        pose.joint_mask = (1u << 25) - 1;
        pose.observed_us = pose.received_us = time;
        for (size_t joint = 0; joint < 25; ++joint) {
            pose.values[joint * 8] = static_cast<float>(hand) + float(time % 1000000) / 1000000;
            pose.values[joint * 8 + 1] = static_cast<float>(joint) * .01f;
            pose.values[joint * 8 + 2] = -.5f;
            pose.values[joint * 8 + 6] = 1;
        }
        result.poses[hand + 1] = pose;
    }
    return result;
}

ceres::ReceiverSnapshot replay_snapshot(int64_t wall_time, int64_t position, int64_t observed,
                                        uint32_t sequence, double speed,
                                        bool manual_delay = false) {
    auto result = snapshot(observed, sequence);
    result.now_us = wall_time;
    result.clock.rate = manual_delay ? 1 : 1 / speed;
    result.clock.offset_us = manual_delay ? 0 : wall_time - position / speed;
    for (size_t hand = 1; hand < 3; ++hand) {
        result.poses[hand]->received_us =
            wall_time + int64_t((observed - position) / (manual_delay ? 1 : speed));
        if (manual_delay)
            result.poses[hand]->observed_us = wall_time + observed - position;
    }
    return result;
}

size_t count(const HandTrails& trails, std::vector<HandTrailSegment>& segments,
             TrailMode mode = TrailMode::joints, HandColour colour = HandColour::side) {
    return trails.write_segments(segments, mode, colour);
}

void geometries_and_colours(std::vector<HandTrailSegment>& segments) {
    HandTrails trails;
    auto first = snapshot(1000000, 0);
    auto second = snapshot(1010000, 1);
    for (auto* observation : {&first, &second})
        for (size_t hand = 1; hand < 3; ++hand) {
            auto& values = observation->poses[hand]->values;
            values[4] = values[6] = 2;
            values[4 * 8 + 3] = values[4 * 8 + 6] = 2;
        }
    trails.update(first, true, 1, 1000000);
    trails.update(second, true, 1, 1010000);
    check(count(trails, segments, TrailMode::off) == 0, "Off trails emitted geometry");
    check(count(trails, segments, TrailMode::hand) == 2,
          "Hand trails did not create one centre-of-gravity path per hand");
    for (size_t hand = 0; hand < 2; ++hand) {
        check(segments[hand].hand == hand &&
                  segments[hand].joint == HandTrails::centre_of_gravity &&
                  near(segments[hand].from, {static_cast<float>(hand), .12f, -.5f}) &&
                  near(segments[hand].to, {static_cast<float>(hand) + .01f, .12f, -.5f}),
              "Hand trails were not the mean of valid joint observations");
    }
    check(count(trails, segments, TrailMode::fingertips) == 10,
          "Fingertip trails included a wrist or omitted a fingertip");
    for (size_t index = 0; index < 10; ++index)
        check(segments[index].joint == HandTrails::fingertips[index % 5] &&
                  segments[index].hand == index / 5,
              "Fingertip identities differed from WebXR indices");
    check(count(trails, segments, TrailMode::bones) == 96,
          "Bone trails did not retain 24 skeletal edges from each observation");
    for (size_t index = 0; index < 96; ++index) {
        const auto& segment = segments[index];
        const size_t joint = index % 24 + 1;
        const size_t hand = index / 48;
        const float x = static_cast<float>(hand) + static_cast<float>((index / 24) % 2) * .01f;
        check(segment.hand == hand && segment.joint == joint &&
                  near(segment.from, {x, float(ceres::joint_parents[joint]) * .01f, -.5f}) &&
                  near(segment.to, {x, float(joint) * .01f, -.5f}) &&
                  segment.from_alpha == segment.to_alpha,
              "Bone trails emitted midpoint traces or incorrect historical skeletons");
    }
    check(count(trails, segments, TrailMode::joints, HandColour::normals) == 50 &&
              near(segments[0].to_colour, {1, .5f, .5f}) &&
              near(segments[4].to_colour, {.5f, 0, .5f}),
          "Joint normals were not derived from normalised orientation quaternions");
    check(count(trails, segments, TrailMode::hand, HandColour::normals) == 2 &&
              near(segments[0].to_colour, {.5f, 0, .5f}),
          "Hand trails did not use the palm orientation normal");
    check(count(trails, segments, TrailMode::joints, HandColour::velocity) == 50 &&
              near(segments[0].from_colour, {0, 0, .5f}) &&
              near(segments[0].to_colour, {1, 5.f / 6, 0}),
          "Trail endpoint colours did not retain source observation velocity");
    for (const auto mode :
         {TrailMode::hand, TrailMode::joints, TrailMode::bones, TrailMode::fingertips}) {
        std::array<HandTrailSegment, 4> bounded{};
        bounded.back().hand = 123;
        const auto written =
            trails.write_segments(std::span(bounded).first(3), mode, HandColour::motion_flow);
        check(written == (mode == TrailMode::hand ? 2 : 3) && bounded.back().hand == 123,
              "A trail geometry mode wrote beyond the destination span");
    }
    auto partial = snapshot(1020000, 2);
    partial.poses[1]->joint_mask &= ~(1u << 5);
    trails.update(partial, true, 1, 1020000);
    check(count(trails, segments, TrailMode::hand) == 3,
          "A changing COG contribution mask drew a centre-of-gravity jump");
    partial = snapshot(1030000, 3);
    partial.poses[1]->joint_mask &= ~(1u << 5);
    trails.update(partial, true, 1, 1030000);
    check(count(trails, segments, TrailMode::hand) == 5,
          "COG trails did not resume with a stable contribution mask");

    trails.clear();
    first = snapshot(2000000, 0);
    second = snapshot(2010000, 1);
    first.poses[2].reset();
    second.poses[2].reset();
    first.poses[1]->joint_mask = second.poses[1]->joint_mask = (1u << 3) | (1u << 4);
    second.poses[1]->values[3 * 8] = .005f;
    second.poses[1]->values[4 * 8] = .015f;
    trails.update(first, true, 1, 2000000);
    trails.update(second, true, 1, 2010000);
    check(count(trails, segments, TrailMode::bones, HandColour::velocity) == 2 &&
              near(segments[1].from_colour, {1, 5.f / 6, 0}) &&
              near(segments[1].to_colour, {1, 5.f / 6, 0}),
          "Bone velocity colouring did not use mean endpoint velocity");
}

void observation_velocities(std::vector<HandTrailSegment>& segments) {
    HandTrails trails;
    check(near(trails.joint_velocity(0, 0), {}) && near(trails.joint_velocity(2, 25), {}),
          "Empty or out-of-range velocities were not zero");
    trails.update(replay_snapshot(50000000, 1050000, 1030000, 0, .1), true, 1, 1050000, .1);
    trails.update(replay_snapshot(50100000, 1060000, 1040000, 1, .1), true, 1, 1060000, .1);
    check(near(trails.joint_velocity(0, 0), {1, 0, 0}),
          "Velocity depended on slow replay wall-clock speed");
    for (int frame = 0; frame < 100; ++frame)
        trails.update(replay_snapshot(55100000 + frame, 1060000, 1040000, 1, .1), true, 1, 1060000,
                      .1);
    check(near(trails.joint_velocity(0, 0), {1, 0, 0}) && count(trails, segments) == 50,
          "Render-frame repeats changed source velocity or history");
    trails.update(replay_snapshot(55200000, 1070000, 1050000, 2, 2), true, 1, 1070000, 2);
    check(near(trails.joint_velocity(1, 24), {1, 0, 0}),
          "Playback speed changes altered source velocity");
    auto partial = replay_snapshot(55210000, 1080000, 1060000, 3, 1);
    partial.poses[1]->joint_mask &= ~(1u << 4);
    partial.poses[1]->values[9 * 8] = std::numeric_limits<float>::quiet_NaN();
    trails.update(partial, true, 1, 1080000);
    check(near(trails.joint_velocity(0, 4), {}) && near(trails.joint_velocity(0, 9), {}) &&
              near(trails.joint_velocity(0, 3), {1, 0, 0}),
          "Joint invalidity did not reset only the affected velocities");
    trails.update(replay_snapshot(55220000, 1090000, 1070000, 4, 1), true, 1, 1090000);
    check(near(trails.joint_velocity(0, 4), {}) && near(trails.joint_velocity(0, 9), {}),
          "A recovered joint derived velocity across a validity gap");
    trails.update(replay_snapshot(55230000, 1100000, 1080000, 5, 1), true, 1, 1100000);
    check(near(trails.joint_velocity(0, 4), {1, 0, 0}),
          "Recovered joints did not resume source velocity");
    auto stale = replay_snapshot(55310000, 1110000, 1050000, 6, 1);
    trails.update(stale, true, 1, 1110000);
    check(near(trails.joint_velocity(0, 0), {}) && near(trails.joint_velocity(1, 24), {}),
          "Stale tracking retained live velocities");
    trails.update(replay_snapshot(55320000, 1120000, 1100000, 7, 1), true, 1, 1120000);
    check(near(trails.joint_velocity(0, 0), {}), "Velocity bridged a stale observation");
    trails.update(replay_snapshot(55420000, 1220000, 1200000, 8, 1), true, 1, 1220000);
    check(near(trails.joint_velocity(0, 0), {}), "Velocity bridged an unobserved source-time gap");
    trails.clear();
    trails.update(replay_snapshot(60000000, 2050000, 2030000, 0, 1, true), true, 1, 2050000);
    trails.update(replay_snapshot(60010000, 2060000, 2040000, 1, 1, true), true, 1, 2060000);
    check(near(trails.joint_velocity(0, 0), {1, 0, 0}),
          "Inspection delay used rebased wall time for velocity");
    trails.update(replay_snapshot(65020000, 2070000, 2050000, 2, 1, true), true, 1, 2070000);
    check(near(trails.joint_velocity(0, 0), {1, 0, 0}),
          "Inspection delay pause affected resumed velocity");
    trails.update(snapshot(3000000, 3), false, 1, 3000000);
    check(near(trails.joint_velocity(0, 0), {}), "Clearing history retained velocity");
}

void finite_observations(std::vector<HandTrailSegment>& segments) {
    HandTrails trails;
    auto first = snapshot(1000000, 0);
    auto second = snapshot(1000000, 1);
    second.poses[1]->values[0] = 1;
    trails.update(first, true, 1, 1000000);
    trails.update(second, true, 1, 1000000);
    check(near(trails.joint_velocity(0, 0), {}),
          "Coincident observation timestamps produced a non-zero velocity");

    auto extreme = snapshot(1010000, 2);
    for (size_t hand = 1; hand < 3; ++hand) {
        auto& pose = *extreme.poses[hand];
        for (size_t joint = 0; joint < HandTrails::joint_count; ++joint) {
            pose.values[joint * 8] = std::numeric_limits<float>::max();
            pose.values[joint * 8 + 3] = std::numeric_limits<float>::quiet_NaN();
        }
    }
    trails.update(extreme, true, 1, 1010000);
    check(near(trails.joint_velocity(0, 0), {}),
          "Unrepresentable source velocity was not reset to zero");
    for (const auto mode :
         {TrailMode::hand, TrailMode::joints, TrailMode::bones, TrailMode::fingertips}) {
        for (const auto colour : {HandColour::side, HandColour::normals, HandColour::velocity,
                                  HandColour::motion_flow}) {
            const auto written = count(trails, segments, mode, colour);
            check(written > 0, "Extreme finite observations lost all trail geometry");
            for (size_t index = 0; index < written; ++index) {
                const auto& segment = segments[index];
                for (const auto& values :
                     {segment.from, segment.to, segment.from_colour, segment.to_colour})
                    check(std::all_of(values.begin(), values.end(),
                                      [](float value) { return std::isfinite(value); }),
                          "Trail output contained a non-finite position or colour");
                check(segment.from_alpha >= 0 && segment.from_alpha <= 1 && segment.to_alpha >= 0 &&
                          segment.to_alpha <= 1,
                      "Trail fade was outside its bounded range");
            }
        }
    }
}

void joints_and_sequences(std::vector<HandTrailSegment>& segments) {
    HandTrails trails;
    trails.update(snapshot(1000000, 0xfffffffe), true, 1, 1000000);
    check(count(trails, segments) == 0, "First sample created a segment");
    trails.update(snapshot(1010000, 0xffffffff), true, 1, 1010000);
    check(count(trails, segments) == 50, "All 25 joints were not tracked separately");
    for (size_t index = 0; index < 50; ++index) {
        const auto& segment = segments[index];
        check(segment.hand == index / 25 && segment.joint == index % 25,
              "Left/right identity or WebXR joint index differs");
        check(std::abs(segment.from[0] - float(segment.hand)) < 1e-6f &&
                  std::abs(segment.to[1] - float(segment.joint) * .01f) < 1e-6f,
              "Trail positions differ from the source observations");
    }
    trails.update(snapshot(1020000, 0), true, 1, 1020000);
    check(count(trails, segments) == 100, "Sequence wrap interrupted valid motion");
    auto repeated = snapshot(1020000, 0);
    for (int frame = 0; frame < 100; ++frame)
        trails.update(repeated, true, 1, 1020000);
    check(count(trails, segments) == 100, "Repeated render frames appended duplicate observations");
    trails.update(snapshot(1025000, 0xffffffff), true, 1, 1025000);
    trails.update(snapshot(1025000, 0x80000000), true, 1, 1025000);
    check(count(trails, segments) == 100, "Older or ambiguous sequences were accepted");
    trails.update(snapshot(1030000, 1), true, 1, 1030000);
    check(count(trails, segments) == 150, "Sequence rejection affected the next accepted pose");
    check(trails.write_segments({}, TrailMode::joints, HandColour::side) == 0 &&
              trails.write_segments(std::span<HandTrailSegment>(segments.data(), 3),
                                    TrailMode::joints, HandColour::side) == 3,
          "Destination span was not respected");

    trails.clear();
    auto partial = snapshot(2000000, 0);
    partial.poses[1]->joint_mask = (1u << 4) | (1u << 6);
    partial.poses[2]->joint_mask = (1u << 0) | (1u << 24);
    trails.update(partial, true, 1, 2000000);
    partial = snapshot(2010000, 1);
    partial.poses[1]->joint_mask = (1u << 4) | (1u << 6);
    partial.poses[2]->joint_mask = (1u << 0) | (1u << 24);
    trails.update(partial, true, 1, 2010000);
    check(count(trails, segments) == 4 && segments[0].joint == 4 && segments[0].hand == 0 &&
              segments[1].joint == 6 && segments[2].joint == 0 && segments[2].hand == 1 &&
              segments[3].joint == 24,
          "Joint validity affected the wrong trail paths");
}

void gaps(std::vector<HandTrailSegment>& segments) {
    HandTrails trails;
    auto push = [&](int64_t time, uint32_t sequence, bool valid = true) {
        auto sample = snapshot(time, sequence);
        sample.poses[2].reset();
        sample.poses[1]->valid = valid;
        trails.update(sample, true, 1, time);
    };
    push(1000000, 1);
    push(1010000, 2);
    push(1020000, 3, false);
    push(1030000, 4);
    check(count(trails, segments) == 25, "Invalid tracking was bridged or erased valid history");
    push(1040000, 5);
    check(count(trails, segments) == 50, "Tracking did not resume after a validity gap");
    auto stale = snapshot(1040000, 5);
    stale.poses[2].reset();
    stale.now_us = 1090001;
    trails.update(stale, true, 1, 1090001);
    push(1100000, 6);
    check(count(trails, segments) == 50, "Stale tracking was bridged");
    push(1110000, 7);
    push(1200000, 8);
    check(count(trails, segments) == 75, "An unobserved time gap was bridged");

    trails.clear();
    push(2000000, 1);
    auto partial = snapshot(2010000, 2);
    partial.poses[2].reset();
    partial.poses[1]->joint_mask &= ~(1u << 9);
    partial.poses[1]->values[14 * 8] = std::numeric_limits<float>::quiet_NaN();
    trails.update(partial, true, 1, 2010000);
    check(count(trails, segments) == 23, "Missing or non-finite joint created a segment");
    push(2020000, 3);
    check(count(trails, segments) == 46, "A recovered joint bridged its tracking gap");
    push(2030000, 4);
    check(count(trails, segments) == 71, "Recovered joints failed to resume their trails");

    trails.clear();
    auto first = snapshot(3000000, 1);
    trails.update(first, true, 1, 3000000);
    auto second = snapshot(3010000, 2);
    second.clock.uncertainty_us = 40001;
    second.poses[1]->observed_us = 2990000;
    trails.update(second, true, 1, 3010000);
    check(count(trails, segments) == 25 && segments[0].hand == 1,
          "Clock uncertainty did not reject an old hand independently");
    second = snapshot(3020000, 3);
    second.clock.valid = false;
    trails.update(second, true, 1, 3020000);
    trails.update(snapshot(3030000, 4), true, 1, 3030000);
    check(count(trails, segments) == 25, "Invalid clock mapping was bridged");

    trails.clear();
    // Both observations are fresh, but they are more than 50 ms apart in source time.
    trails.update(replay_snapshot(10000000, 4000000, 3959999, 1, 1), true, 1, 4000000);
    trails.update(replay_snapshot(10010000, 4010000, 4010000, 2, 1), true, 1, 4010000);
    check(count(trails, segments) == 0, "Source observation gap was bridged on a rebased clock");
}

void replay_clocks(std::vector<HandTrailSegment>& segments) {
    HandTrails trails;
    // At 0.1x speed, a 20 ms old source observation appears 200 ms old on the rebased clock.
    trails.update(replay_snapshot(50000000, 1000000, 980000, 0, .1), true, 1, 1000000, .1);
    trails.update(replay_snapshot(50100000, 1010000, 990000, 1, .1), true, 1, 1010000, .1);
    check(count(trails, segments) == 50,
          "Slow replay freshness or continuity was measured against wall time");
    const float before_pause = segments[0].from_alpha;
    trails.update(replay_snapshot(55100000, 1010000, 990000, 1, .1), true, 1, 1010000, .1);
    check(count(trails, segments) == 50 && segments[0].from_alpha == before_pause,
          "A paused replay appended duplicates or changed trail fading");
    trails.update(replay_snapshot(55200000, 1020000, 1000000, 2, .1), true, 1, 1020000, .1);
    check(count(trails, segments) == 100,
          "Resuming a slow replay interrupted continuous source observations");

    // A speed change also rebases the clock without changing the source observation spacing.
    trails.update(replay_snapshot(55205000, 1030000, 1010000, 3, 2), true, 1, 1030000, 2);
    check(count(trails, segments) == 150, "Playback speed changes interrupted source continuity");
    auto uncertain = replay_snapshot(55305000, 1040000, 1020000, 4, .1);
    uncertain.clock.uncertainty_us = 30001;
    trails.update(uncertain, true, 1, 1040000, .1);
    check(count(trails, segments) == 150, "Slow playback reduced the source clock uncertainty");
    trails.update(replay_snapshot(55405000, 1050000, 1030000, 5, .1), true, 1, 1050000, .1);
    check(count(trails, segments) == 150, "Replay bridged a freshness rejection");

    trails.clear();
    // Inspection delay rewrites observed_us on every frame instead of modifying the clock mapping.
    trails.update(replay_snapshot(60000000, 2000000, 1980000, 0, 1, true), true, 1, 2000000);
    trails.update(replay_snapshot(60010000, 2010000, 1990000, 1, 1, true), true, 1, 2010000);
    check(count(trails, segments) == 50, "Inspection delay failed to retain continuous motion");
    trails.update(replay_snapshot(65010000, 2010000, 1990000, 1, 1, true), true, 1, 2010000);
    check(count(trails, segments) == 50, "Paused inspection delay appended a duplicate pose");
    trails.update(replay_snapshot(65020000, 2020000, 2000000, 2, 1, true), true, 1, 2020000);
    check(count(trails, segments) == 100,
          "Inspection delay connected timestamps from different wall-clock rebases");

    constexpr std::array<double, 4> invalid_scales{0, -1, std::numeric_limits<double>::infinity(),
                                                   std::numeric_limits<double>::quiet_NaN()};
    for (const double scale : invalid_scales)
        trails.update(replay_snapshot(65030000, 2030000, 2010000, 3, 1, true), true, 1, 2030000,
                      scale);
    check(count(trails, segments) == 100, "Invalid playback speed contributed observations");
    trails.update(replay_snapshot(65040000, 2040000, 2020000, 4, 1, true), true, 1, 2040000);
    check(count(trails, segments) == 100, "Invalid playback speed failed to break continuity");
    trails.update(replay_snapshot(65050000, 2050000, 2030000, 5, 1, true), true, 1, 2050000);
    check(count(trails, segments) == 150, "Valid playback speed did not resume trail sampling");
}

void fade_and_resets(std::vector<HandTrailSegment>& segments) {
    HandTrails trails;
    trails.update(snapshot(1000000, 0), true, .25f, 1000000);
    trails.update(snapshot(1025000, 1), true, .25f, 1025000);
    auto lost = snapshot(1125000, 2);
    lost.poses = {};
    trails.update(lost, true, .25f, 1125000);
    check(count(trails, segments) == 50 && std::abs(segments[0].from_alpha - .5f) < 1e-6f &&
              std::abs(segments[0].to_alpha - .6f) < 1e-6f,
          "Trail endpoints did not fade linearly through tracking loss");
    // Receiver freshness time can advance while a replay is paused.
    lost.now_us += 5000000;
    trails.update(lost, true, .25f, 1125000);
    check(count(trails, segments) == 50 && std::abs(segments[0].to_alpha - .6f) < 1e-6f,
          "Paused replay trails decayed against wall time");
    trails.update(lost, true, .25f, 1275000);
    check(count(trails, segments) == 0, "Expired trail segments remained visible");

    auto pair = [&](int64_t time) {
        trails.update(snapshot(time, 0), true, 1, time);
        trails.update(snapshot(time + 10000, 1), true, 1, time + 10000);
        check(count(trails, segments) == 50, "Reset did not accept a fresh sequence zero");
    };
    trails.clear();
    pair(2000000);
    auto epoch = snapshot(2020000, 2);
    ++epoch.epoch;
    for (size_t hand = 1; hand < 3; ++hand)
        epoch.poses[hand]->epoch = epoch.epoch;
    trails.update(epoch, true, 1, 2020000);
    check(count(trails, segments) == 0, "Connection epoch retained old trails");
    epoch = snapshot(2030000, 3);
    epoch.poses[1]->epoch = 0;
    epoch.poses[2]->space_epoch = 0;
    trails.update(epoch, true, 1, 2030000);
    trails.update(snapshot(2040000, 4), true, 1, 2040000);
    check(count(trails, segments) == 0, "Mismatched pose epochs contributed trail points");
    trails.update(snapshot(2050000, 5), true, 1, 2050000);
    check(count(trails, segments) == 50, "Valid epoch did not resume trail sampling");
    auto space = snapshot(2060000, 6);
    ++space.space_epoch;
    for (size_t hand = 1; hand < 3; ++hand)
        space.poses[hand]->space_epoch = space.space_epoch;
    trails.update(space, true, 1, 2060000);
    check(count(trails, segments) == 0, "Reference-space reset retained old trails");
    trails.clear();
    pair(3000000);
    trails.update(snapshot(2990000, 0), true, 1, 2990000);
    check(count(trails, segments) == 0, "Backwards replay seek retained old trails");
    trails.update(snapshot(3000000, 1), true, 1, 3000000);
    check(count(trails, segments) == 50, "Backwards seek did not reset sequence tracking");
    trails.update(snapshot(3010000, 2), false, 1, 3010000);
    check(count(trails, segments) == 0, "Disabling trails retained visible history");
    trails.update(snapshot(3020000, 3), true, 1, 3020000);
    check(count(trails, segments) == 0, "Enabling trails joined old observations");
}

void bounded_history(std::vector<HandTrailSegment>& segments) {
    static_assert(std::is_nothrow_move_constructible_v<HandTrails>);
    static_assert(sizeof(HandTrails) < 128 * 1024);
    HandTrails trails;
    for (uint32_t index = 0; index < 10000; ++index) {
        const int64_t time = 1000000 + index * 1000;
        trails.update(snapshot(time, index), true, 100, time);
    }
    check(count(trails, segments) == HandTrails::max_segments,
          "Long-running trails exceeded or underfilled the fixed history bound");
    check(std::abs(segments[0].from[0] - .360f) < 1e-5f,
          "The ring buffer retained obsolete samples instead of recent observations");
    check(count(trails, segments, TrailMode::hand) == 2 * (HandTrails::max_samples - 1) &&
              count(trails, segments, TrailMode::fingertips) ==
                  2 * 5 * (HandTrails::max_samples - 1) &&
              count(trails, segments, TrailMode::bones) == 2 * 24 * HandTrails::max_samples,
          "Trail geometry modes exceeded or underfilled their fixed history bounds");
    auto missing = snapshot(15999000, 10000);
    missing.poses = {};
    trails.update(missing, true, 100, 15999000);
    check(count(trails, segments) == 0, "Duration was not bounded to five seconds");

    trails.clear();
    trails.update(snapshot(20000000, 0), true, -1, 20000000);
    trails.update(snapshot(20010000, 1), true, -1, 20010000);
    missing = snapshot(20249999, 2);
    missing.poses = {};
    trails.update(missing, true, -1, 20249999);
    check(count(trails, segments) == 50, "Minimum duration did not retain recent motion");
    trails.update(missing, true, -1, 20260000);
    check(count(trails, segments) == 0, "Minimum duration did not expire motion");
}
} // namespace

int main() {
    try {
        std::vector<HandTrailSegment> segments(HandTrails::max_segments);
        colour_maths();
        geometries_and_colours(segments);
        observation_velocities(segments);
        finite_observations(segments);
        joints_and_sequences(segments);
        gaps(segments);
        replay_clocks(segments);
        fade_and_resets(segments);
        bounded_history(segments);
        std::cout
            << "PASS: hand colours, trail geometry, source velocities, replay time and bounds\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL: " << error.what() << '\n';
        return 1;
    }
}
