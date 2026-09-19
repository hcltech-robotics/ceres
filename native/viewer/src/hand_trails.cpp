#include "ceres/hand_trails.hpp"
#include <algorithm>
#include <bit>
#include <cmath>
#include <limits>

namespace ceres {
namespace {
constexpr double freshness_us = 50000;
constexpr uint32_t joint_bits = (1u << HandTrails::joint_count) - 1;
constexpr uint32_t centre_bit = 1u << HandTrails::centre_of_gravity;

double elapsed(int64_t now, int64_t then) {
    return static_cast<double>(now) - static_cast<double>(then);
}

bool fresh(const PoseSample& pose, const ReceiverSnapshot& snapshot, int64_t now,
           double time_scale) {
    const auto& clock = snapshot.clock;
    const double observed = pose.observed_us * clock.rate + clock.offset_us;
    return pose.valid && pose.epoch == snapshot.epoch && pose.space_epoch == snapshot.space_epoch &&
           clock.valid && std::isfinite(clock.rate) && clock.rate > 0 &&
           std::isfinite(clock.offset_us) && std::isfinite(clock.uncertainty_us) &&
           clock.uncertainty_us >= 0 && std::isfinite(observed) &&
           elapsed(now, pose.received_us) * time_scale <= freshness_us &&
           (now - observed) * time_scale + clock.uncertainty_us <= freshness_us;
}

std::array<float, 3> joint_normal(const PoseSample& pose, size_t joint, bool palm = false) {
    const double x = pose.values[joint * 8 + 3], y = pose.values[joint * 8 + 4];
    const double z = pose.values[joint * 8 + 5], w = pose.values[joint * 8 + 6];
    const double squared_length = x * x + y * y + z * z + w * w;
    if (!std::isfinite(squared_length) || squared_length < 1e-12)
        return palm ? std::array<float, 3>{0, -1, 0} : std::array<float, 3>{0, 0, 1};
    // Joint colours use their local +Z axis. WebXR's palm-facing normal is -Y.
    if (palm)
        return {static_cast<float>(2 * (w * z - x * y) / squared_length),
                static_cast<float>(2 * (x * x + z * z) / squared_length - 1),
                static_cast<float>(-2 * (y * z + w * x) / squared_length)};
    return {static_cast<float>(2 * (x * z + w * y) / squared_length),
            static_cast<float>(2 * (y * z - w * x) / squared_length),
            static_cast<float>(1 - 2 * (x * x + y * y) / squared_length)};
}

std::array<float, 3> source_velocity(const std::array<float, 3>& from,
                                     const std::array<float, 3>& to, double interval_us) {
    std::array<float, 3> result{};
    if (!(interval_us > 0))
        return result;
    for (size_t axis = 0; axis < result.size(); ++axis) {
        const double value = (static_cast<double>(to[axis]) - from[axis]) * 1000000 / interval_us;
        if (!std::isfinite(value) || std::abs(value) > std::numeric_limits<float>::max())
            return {};
        result[axis] = static_cast<float>(value);
    }
    return result;
}
} // namespace

void HandTrails::clear() {
    for (auto& history : *histories_) {
        history.start = 0;
        history.size = 0;
        history.sequence = 0;
        history.has_sequence = false;
        history.continuity = 0;
    }
    initialised_ = false;
}

void HandTrails::update(const ReceiverSnapshot& snapshot, bool enabled, float duration_seconds,
                        int64_t timeline_us, double time_scale) {
    if (!enabled) {
        clear();
        return;
    }
    if (initialised_ && (snapshot.epoch != epoch_ || snapshot.space_epoch != space_epoch_ ||
                         timeline_us < timeline_us_))
        clear();
    initialised_ = true;
    epoch_ = snapshot.epoch;
    space_epoch_ = snapshot.space_epoch;
    timeline_us_ = timeline_us;
    duration_us_ =
        std::clamp(std::isfinite(duration_seconds) ? duration_seconds : 1.f, .25f, 5.f) * 1000000.0;
    const int64_t now = snapshot.now_us ? snapshot.now_us : monotonic_us();
    const bool valid_scale = std::isfinite(time_scale) && time_scale > 0;

    for (size_t hand = 0; hand < histories_->size(); ++hand) {
        auto& history = (*histories_)[hand];
        // Retain one point before the fade boundary for its zero-alpha segment endpoint.
        while (
            history.size > 1 &&
            elapsed(timeline_us, history.samples[(history.start + 1) % max_samples].timeline_us) >=
                duration_us_) {
            history.start = (history.start + 1) % max_samples;
            --history.size;
        }
        const auto& observation = snapshot.poses[hand + 1];
        if (!valid_scale || !observation || !fresh(*observation, snapshot, now, time_scale)) {
            history.continuity = 0;
            continue;
        }
        const auto& pose = *observation;
        if (history.has_sequence) {
            const uint32_t advance = pose.sequence - history.sequence;
            if (advance == 0 || advance >= 0x80000000u)
                continue;
        }

        Sample sample;
        sample.timeline_us = timeline_us;
        // Replay and inspection delay rebase their wall clocks. The common source
        // timeline preserves observation spacing across pauses and playback speeds.
        sample.observation_us =
            timeline_us +
            (pose.observed_us * snapshot.clock.rate + snapshot.clock.offset_us - now) * time_scale;
        if (!std::isfinite(sample.observation_us)) {
            history.continuity = 0;
            continue;
        }
        std::array<double, 3> centre{};
        for (size_t joint = 0; joint < joint_count; ++joint) {
            if (!(pose.joint_mask & (1u << joint)))
                continue;
            const auto position = std::array<float, 3>{
                pose.values[joint * 8], pose.values[joint * 8 + 1], pose.values[joint * 8 + 2]};
            if (!std::all_of(position.begin(), position.end(),
                             [](float value) { return std::isfinite(value); }))
                continue;
            sample.positions[joint] = position;
            sample.normals[joint] = joint_normal(pose, joint);
            sample.valid |= 1u << joint;
            for (size_t axis = 0; axis < centre.size(); ++axis)
                centre[axis] += position[axis];
        }
        if (sample.valid) {
            const auto count = std::popcount(sample.valid);
            for (size_t axis = 0; axis < centre.size(); ++axis)
                sample.positions[centre_of_gravity][axis] =
                    static_cast<float>(centre[axis] / count);
            if (sample.valid & 1u)
                sample.normals[centre_of_gravity] = joint_normal(pose, 0, true);
            sample.valid |= centre_bit;
        }
        if (history.size) {
            const auto& previous =
                history.samples[(history.start + history.size - 1) % max_samples];
            const double timeline_gap = elapsed(sample.timeline_us, previous.timeline_us);
            const double source_gap = sample.observation_us - previous.observation_us;
            if (timeline_gap <= freshness_us && source_gap >= 0 && source_gap <= freshness_us) {
                sample.connected = sample.valid & previous.valid & history.continuity;
                if ((sample.valid & joint_bits) != (previous.valid & joint_bits))
                    sample.connected &= ~centre_bit;
                for (size_t point = 0; point <= joint_count; ++point)
                    if (sample.connected & (1u << point))
                        sample.velocities[point] = source_velocity(
                            previous.positions[point], sample.positions[point], source_gap);
            }
        }
        if (history.size == max_samples) {
            history.start = (history.start + 1) % max_samples;
            --history.size;
        }
        history.samples[(history.start + history.size) % max_samples] = sample;
        ++history.size;
        history.sequence = pose.sequence;
        history.has_sequence = true;
        history.continuity = sample.valid;
    }
}

std::array<float, 3> HandTrails::joint_velocity(size_t hand, size_t joint) const {
    if (hand >= histories_->size() || joint >= joint_count)
        return {};
    const auto& history = (*histories_)[hand];
    if (!history.size || !(history.continuity & (1u << joint)))
        return {};
    return history.samples[(history.start + history.size - 1) % max_samples].velocities[joint];
}

size_t HandTrails::write_segments(std::span<HandTrailSegment> destination, TrailMode mode,
                                  HandColour colour) const {
    if (mode == TrailMode::off)
        return 0;
    size_t written = 0;
    const auto alpha = [&](int64_t time) {
        return static_cast<float>(
            std::clamp(1 - elapsed(timeline_us_, time) / duration_us_, 0.0, 1.0));
    };
    for (size_t hand = 0; hand < histories_->size(); ++hand) {
        const auto& history = (*histories_)[hand];
        const size_t first = mode == TrailMode::bones ? 0 : 1;
        for (size_t index = first; index < history.size; ++index) {
            const auto& sample = history.samples[(history.start + index) % max_samples];
            const float to_alpha = alpha(sample.timeline_us);
            if (to_alpha == 0)
                continue;
            if (mode == TrailMode::bones) {
                for (size_t joint = 1; joint < joint_count; ++joint) {
                    const auto parent = static_cast<size_t>(joint_parents[joint]);
                    const uint32_t mask = (1u << joint) | (1u << parent);
                    if ((sample.valid & mask) != mask)
                        continue;
                    if (written == destination.size())
                        return written;
                    std::array<float, 3> velocity{};
                    for (size_t axis = 0; axis < velocity.size(); ++axis)
                        velocity[axis] = sample.velocities[parent][axis] * .5f +
                                         sample.velocities[joint][axis] * .5f;
                    destination[written++] = {
                        sample.positions[parent],
                        sample.positions[joint],
                        hand_colour(colour, hand, sample.normals[parent], velocity),
                        hand_colour(colour, hand, sample.normals[joint], velocity),
                        to_alpha,
                        to_alpha,
                        hand,
                        joint};
                }
                continue;
            }
            const auto& previous = history.samples[(history.start + index - 1) % max_samples];
            const float from_alpha = alpha(previous.timeline_us);
            const size_t first_point = mode == TrailMode::hand ? centre_of_gravity : 0;
            const size_t end_point = mode == TrailMode::hand ? centre_of_gravity + 1 : joint_count;
            for (size_t point = first_point; point < end_point; ++point) {
                if (!(sample.connected & (1u << point)))
                    continue;
                if (mode == TrailMode::fingertips &&
                    std::find(fingertips.begin(), fingertips.end(), point) == fingertips.end())
                    continue;
                if (written == destination.size())
                    return written;
                destination[written++] = {
                    previous.positions[point],
                    sample.positions[point],
                    hand_colour(colour, hand, previous.normals[point], previous.velocities[point]),
                    hand_colour(colour, hand, sample.normals[point], sample.velocities[point]),
                    from_alpha,
                    to_alpha,
                    hand,
                    point};
            }
        }
    }
    return written;
}
} // namespace ceres
