#include "ceres/hand_mask.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>

namespace ceres {
namespace {
using Position = std::array<float, 3>;

int64_t distance_us(int64_t first, int64_t second) {
    // Source timestamps are nonnegative and bounded by the protocol. Checking
    // before subtraction also keeps malformed callers from signed overflow.
    if (first < 0 || second < 0)
        return std::numeric_limits<int64_t>::max();
    return first > second ? first - second : second - first;
}
Position subtract(const Position& first, const Position& second) {
    return {first[0] - second[0], first[1] - second[1], first[2] - second[2]};
}
float dot(const Position& first, const Position& second) {
    return hand_mask_detail::dot(first.data(), second.data());
}
float length(const Position& value) {
    return std::sqrt(dot(value, value));
}
Position normalise(const Position& value) {
    const float scale = 1.f / length(value);
    return {value[0] * scale, value[1] * scale, value[2] * scale};
}
Position cross(const Position& first, const Position& second) {
    return {first[1] * second[2] - first[2] * second[1],
            first[2] * second[0] - first[0] * second[2],
            first[0] * second[1] - first[1] * second[0]};
}

void append_hand(HandMaskSet& mask, const PoseSample& pose) {
    if (!pose.valid)
        return;
    std::array<Position, 25> positions{};
    std::array<float, 25> radii{};
    std::array<bool, 25> valid{};
    for (unsigned joint = 0; joint < valid.size(); ++joint) {
        const float* source = pose.values.data() + joint * 8;
        const float radius = source[7];
        valid[joint] = (pose.joint_mask & (1u << joint)) != 0 &&
                       hand_mask_detail::finite_point(source) && std::isfinite(radius) &&
                       radius >= 0 && radius <= .045f;
        if (!valid[joint])
            continue;
        std::copy_n(source, 3, positions[joint].begin());
        radii[joint] = std::clamp(radius + .008f, .009f, .04f);
    }
    for (unsigned joint = 0; joint < valid.size(); ++joint) {
        if (!valid[joint] || mask.capsule_count == hand_mask_max_capsules)
            continue;
        auto& capsule = mask.capsules[mask.capsule_count++];
        std::copy(positions[joint].begin(), positions[joint].end(), capsule.to);
        std::copy(positions[joint].begin(), positions[joint].end(), capsule.from);
        capsule.radius = radii[joint];
        const int parent = joint_parents[joint];
        if (parent < 0 || !valid[static_cast<unsigned>(parent)])
            continue;
        const float separation = length(subtract(positions[joint], positions[parent]));
        // A missing or implausible bone becomes a local joint sphere. It never
        // bridges unrelated locations through a large exclusion volume.
        const float maximum = parent == 0 ? .14f : .10f;
        if (!std::isfinite(separation) || separation > maximum)
            continue;
        std::copy(positions[parent].begin(), positions[parent].end(), capsule.from);
        capsule.radius = std::max(capsule.radius, radii[parent]);
    }

    // MCP joints and the wrist define a filled palm. Finger capsules alone leave
    // holes between metacarpals that would otherwise retain moving hand points.
    if (!valid[0] || !valid[6] || !valid[11] || !valid[21] ||
        mask.palm_count == hand_mask_max_palms)
        return;
    const Position across = subtract(positions[6], positions[21]);
    const float width = length(across);
    if (!std::isfinite(width) || width < .025f || width > .14f)
        return;
    const Position x = normalise(across);
    Position forward = subtract(positions[11], positions[0]);
    const float along = dot(forward, x);
    for (unsigned i = 0; i < 3; ++i)
        forward[i] -= x[i] * along;
    const float palm_length = length(forward);
    if (!std::isfinite(palm_length) || palm_length < .025f || palm_length > .16f)
        return;
    const Position y = normalise(forward);
    const Position z = cross(x, y);
    const std::array<Position, 3> axes{x, y, z};
    Position minimum{}, maximum{};
    constexpr std::array<unsigned, 9> palm_joints{0, 5, 6, 10, 11, 15, 16, 20, 21};
    float thickness = .012f;
    for (const auto joint : palm_joints) {
        if (!valid[joint])
            continue;
        const Position relative = subtract(positions[joint], positions[0]);
        if (length(relative) > .18f)
            return;
        for (unsigned axis = 0; axis < 3; ++axis) {
            const float coordinate = dot(relative, axes[axis]);
            minimum[axis] = std::min(minimum[axis], coordinate);
            maximum[axis] = std::max(maximum[axis], coordinate);
        }
        thickness = std::max(thickness, std::min(radii[joint], .025f));
    }
    if (maximum[2] - minimum[2] > .06f)
        return;
    auto& palm = mask.palms[mask.palm_count++];
    std::copy(positions[0].begin(), positions[0].end(), palm.centre);
    for (unsigned axis = 0; axis < 3; ++axis) {
        std::copy(axes[axis].begin(), axes[axis].end(), palm.axes + axis * 3);
        const float centre = .5f * (minimum[axis] + maximum[axis]);
        for (unsigned coordinate = 0; coordinate < 3; ++coordinate)
            palm.centre[coordinate] += axes[axis][coordinate] * centre;
        palm.half_extent[axis] = .5f * (maximum[axis] - minimum[axis]) +
                                 (axis == 2 ? thickness : .008f);
    }
}
} // namespace

HandMaskBuilder::HandMaskBuilder(HandMaskCapture capture) : capture_(capture) {}

void HandMaskBuilder::observe(const PoseSample& pose, int64_t receiver_time_us) {
    if (pose.kind < 2 || pose.kind > 3 || pose.epoch != capture_.epoch ||
        pose.space_epoch != capture_.space_epoch)
        return;
    const int64_t receiver_distance = distance_us(receiver_time_us, capture_.receiver_time_us);
    if (receiver_distance > hand_mask_max_age_us ||
        (capture_.require_sender_time &&
         (distance_us(pose.observed_us, capture_.observed_us) > hand_mask_max_age_us ||
          distance_us(pose.target_us, capture_.target_us) > hand_mask_max_age_us)))
        return;
    const unsigned hand = pose.kind - 2;
    const auto rank = [&](const PoseSample& candidate, int64_t time) {
        const int64_t receiver_age = distance_us(time, capture_.receiver_time_us);
        if (!capture_.require_sender_time)
            return std::array<int64_t, 6>{receiver_age, time, 0, 0, 0, 0};
        // XR poses describe their predicted target time. Receiver pose events
        // retain observed time, so matching those alone can select a later hand
        // instead of the hand captured in exactly the same XR frame as depth.
        return std::array<int64_t, 6>{distance_us(candidate.target_us, capture_.target_us),
                                       candidate.target_us,
                                       distance_us(candidate.observed_us, capture_.observed_us),
                                       candidate.observed_us, receiver_age, time};
    };
    if (!selected_[hand] || rank(pose, receiver_time_us) < rank(poses_[hand], times_[hand])) {
        poses_[hand] = pose;
        times_[hand] = receiver_time_us;
        selected_[hand] = true;
    }
}

HandMaskSet HandMaskBuilder::finish() const {
    HandMaskSet result;
    for (unsigned hand = 0; hand < selected_.size(); ++hand)
        if (selected_[hand])
            append_hand(result, poses_[hand]);
    return result;
}
} // namespace ceres
