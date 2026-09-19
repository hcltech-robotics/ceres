#pragma once
#include <cstdint>
#include <type_traits>

namespace ceres {
inline constexpr std::uint32_t spatial_map_intrinsic_rgb = 1u;

// World coordinates and retained cell width are in metres. observed_us uses
// the map's source clock, not wall-clock time. A zero weight marks an empty slot.
// Display palettes are computed from these values and are never stored here.
struct SpatialMapPoint {
    float x = 0, y = 0, z = 0, cell_size = 0;
    float r = 0, g = 0, b = 0, confidence = 0;
    std::int64_t observed_us = 0;
    std::uint32_t weight = 0, flags = 0;
};
static_assert(sizeof(SpatialMapPoint) == 48);
static_assert(std::is_trivially_copyable_v<SpatialMapPoint>);
} // namespace ceres
