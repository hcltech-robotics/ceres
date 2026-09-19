#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <numbers>

namespace ceres {
enum class HandLevel { outline, points, bones, mesh };
enum class HandColour { side, normals, velocity, motion_flow };
enum class TrailMode { off, hand, joints, bones, fingertips };

namespace hand_display_detail {
inline constexpr auto middlebury_wheel = [] {
    constexpr std::array<size_t, 6> lengths{15, 6, 4, 11, 13, 6};
    constexpr std::array<std::array<float, 3>, 7> corners{
        {{1, 0, 0}, {1, 1, 0}, {0, 1, 0}, {0, 1, 1}, {0, 0, 1}, {1, 0, 1}, {1, 0, 0}}};
    std::array<std::array<float, 3>, 55> wheel{};
    size_t index = 0;
    for (size_t segment = 0; segment < lengths.size(); ++segment) {
        for (size_t step = 0; step < lengths[segment]; ++step) {
            const float amount = static_cast<float>(step) / static_cast<float>(lengths[segment]);
            for (size_t channel = 0; channel < 3; ++channel)
                wheel[index][channel] =
                    corners[segment][channel] +
                    (corners[segment + 1][channel] - corners[segment][channel]) * amount;
            ++index;
        }
    }
    return wheel;
}();
} // namespace hand_display_detail

// Velocity is in metres per second in the source reference space. Motion flow
// uses the X/Z plane, 1.5 m/s scale and 55-colour Middlebury wheel from the web app.
inline std::array<float, 3> hand_colour(HandColour mode, size_t side,
                                        const std::array<float, 3>& normal,
                                        const std::array<float, 3>& velocity) {
    const auto bounded = [](float value) {
        return std::clamp(std::isfinite(value) ? value : 0.f, 0.f, 1.f);
    };
    if (mode == HandColour::normals)
        return {bounded(normal[0] * .5f + .5f), bounded(normal[1] * .5f + .5f),
                bounded(normal[2] * .5f + .5f)};
    const bool finite_velocity = std::all_of(velocity.begin(), velocity.end(),
                                             [](float value) { return std::isfinite(value); });
    const double x = finite_velocity ? velocity[0] : 0;
    const double y = finite_velocity ? velocity[1] : 0;
    const double z = finite_velocity ? velocity[2] : 0;
    if (mode == HandColour::velocity) {
        const float speed = static_cast<float>(std::min(std::hypot(x, y, z) / 1.5, 1.0));
        const auto channel = [&](float offset) {
            return bounded(1.5f - std::abs(4 * speed - offset));
        };
        return {channel(3), channel(2), channel(1)};
    }
    if (mode == HandColour::motion_flow) {
        const double magnitude = std::hypot(x, z);
        if (magnitude < 1e-6)
            return {1, 1, 1};
        const auto& wheel = hand_display_detail::middlebury_wheel;
        const double direction = (std::atan2(-z, -x) / std::numbers::pi + 1) * .5;
        const double position = direction * static_cast<double>(wheel.size());
        const size_t lower = static_cast<size_t>(position) % wheel.size();
        const size_t upper = (lower + 1) % wheel.size();
        const float amount = static_cast<float>(position - std::floor(position));
        const float saturation = static_cast<float>(std::min(magnitude / 1.5, 1.0));
        std::array<float, 3> result{};
        for (size_t channel = 0; channel < result.size(); ++channel) {
            const float colour =
                wheel[lower][channel] + (wheel[upper][channel] - wheel[lower][channel]) * amount;
            result[channel] = bounded(1 - saturation * (1 - colour));
        }
        return result;
    }
    return side == 0 ? std::array<float, 3>{.27f, .64f, .95f}
                     : std::array<float, 3>{.95f, .47f, .38f};
}
} // namespace ceres
