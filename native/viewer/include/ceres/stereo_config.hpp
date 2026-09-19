#pragma once
#include <cstddef>

namespace ceres {
inline constexpr int stereo_max_width = 384;
inline constexpr int stereo_max_height = 384;
inline constexpr int stereo_max_disparity = 96;

struct StereoGpuCamera {
    int width = 0, height = 0;
    float fx = 0, fy = 0, cx = 0, cy = 0;
    float distortion[5]{};
    // Row-major rotation from a rectified WebXR ray into this camera's WebXR frame.
    float ray_to_camera[9]{};
    int flip_x = 0, flip_y = 0;
};

struct StereoGpuConfig {
    int width = 0, height = 0, max_disparity = stereo_max_disparity;
    float fx = 0, fy = 0, cx = 0, cy = 0, baseline_metres = 0;
    float rect_to_head[9]{}, left_origin[3]{};
    StereoGpuCamera left{}, right{};
    float min_depth = 0.15f, max_depth = 5.0f;
    float uniqueness = 0.12f, consistency = 1.0f, texture_range = 10.0f;
};

// Two vec4 vertex attributes. Invalid points have valid=0 and alpha=0.
struct StereoPoint {
    float x = 0, y = 0, z = 0, valid = 0;
    float r = 0, g = 0, b = 0, a = 0;
};
static_assert(sizeof(StereoPoint) == 8 * sizeof(float));
} // namespace ceres
