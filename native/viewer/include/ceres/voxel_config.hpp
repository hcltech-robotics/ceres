#pragma once
#include <cstddef>

namespace ceres {
inline constexpr size_t stereo_voxel_capacity = 262144;
inline constexpr size_t stereo_voxel_max_samples = 1048576;

struct VoxelGpuConfig {
    float voxel_size = 0.03f;
    float sample_time_seconds = 0;
    float now_seconds = 0;
    float contradiction_decrement = .2f;
    float support_increment = .25f;
    float surface_tolerance = .04f;
    // Column-major rigid transform, as stored by glm. World coordinates are metres.
    float head_to_world[16]{};
};

struct VoxelLodConfig {
    // World-space eye position. Coarser cells remain aligned to the original grid.
    float view_position[3]{};
    float focal_length_pixels = 900.f;
    float target_pixels = 6.f;
    float minimum_distance = 1.5f;
    // Zero preserves the normal snapshot. Levels 1 to 6 merge 2 to 64 cells per axis.
    unsigned max_level = 3;
};
} // namespace ceres
