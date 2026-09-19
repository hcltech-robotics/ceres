#pragma once
#include "ceres/hand_display.hpp"
#include "ceres/types.hpp"
#include <array>
#include <cstddef>
#include <memory>
#include <span>

namespace ceres {
struct HandTrailSegment {
    std::array<float, 3> from{}, to{};
    std::array<float, 3> from_colour{}, to_colour{};
    float from_alpha = 0, to_alpha = 0;
    size_t hand = 0, joint = 0;
};

class HandTrails {
  public:
    static constexpr size_t max_samples = 640;
    static constexpr size_t joint_count = 25;
    static constexpr size_t centre_of_gravity = joint_count;
    static constexpr size_t max_segments = 2 * joint_count * (max_samples - 1);
    static constexpr std::array<size_t, 5> fingertips{4, 9, 14, 19, 24};

    void clear();
    void update(const ReceiverSnapshot& snapshot, bool enabled, float duration_seconds,
                int64_t timeline_us, double time_scale = 1);
    std::array<float, 3> joint_velocity(size_t hand, size_t joint) const;
    size_t write_segments(std::span<HandTrailSegment> destination, TrailMode mode,
                          HandColour colour) const;

  private:
    struct Sample {
        std::array<std::array<float, 3>, joint_count + 1> positions{}, normals{}, velocities{};
        int64_t timeline_us = 0;
        double observation_us = 0;
        uint32_t valid = 0, connected = 0;
    };
    struct History {
        std::array<Sample, max_samples> samples{};
        size_t start = 0, size = 0;
        uint32_t sequence = 0;
        bool has_sequence = false;
        uint32_t continuity = 0;
    };

    // The fixed-capacity history lives on the heap, including when the owner is on the stack.
    std::unique_ptr<std::array<History, 2>> histories_ = std::make_unique<std::array<History, 2>>();
    uint32_t epoch_ = 0, space_epoch_ = 0;
    int64_t timeline_us_ = 0;
    double duration_us_ = 1000000;
    bool initialised_ = false;
};
} // namespace ceres
