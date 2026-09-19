#pragma once
#include "spatial_map_point.hpp"
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

namespace ceres {
inline constexpr std::uint64_t spatial_map_default_max_bytes = 16ull * 1024 * 1024;
inline constexpr std::uint64_t spatial_map_header_bytes = 256;
inline constexpr std::uint64_t spatial_map_record_bytes = 48;
inline constexpr std::uint64_t spatial_map_hard_max_bytes = 256ull * 1024 * 1024;

enum class SpatialMapSource : std::uint32_t { environment_depth = 0, stereo = 1 };

struct SpatialMapSnapshot {
    // An application-owned tracking-world identity, at most 64 ASCII characters.
    // Numeric epochs alone do not identify a world across separate connections.
    std::string world_id;
    SpatialMapSource source = SpatialMapSource::environment_depth;
    std::uint32_t epoch = 0, space_epoch = 0;
    std::int64_t time_origin_us = 0;
    std::uint64_t generation = 0;
    float base_voxel_size = .03f;
    std::vector<SpatialMapPoint> points;
};

struct SpatialMapFileInfo {
    std::uint64_t bytes = 0, input_points = 0, stored_points = 0;
    float grid_size = 0;
    bool recovered_pending = false;
};

struct SpatialMapReadResult {
    SpatialMapSnapshot map;
    SpatialMapFileInfo info;
};

// These blocking functions are intended for the storage worker and tests.
// The budget covers the completed file. Atomic replacement temporarily keeps
// the committed file and one pending file in the same directory.
SpatialMapFileInfo save_spatial_map(const std::filesystem::path& path,
                                   const SpatialMapSnapshot& map,
                                   std::uint64_t max_bytes = spatial_map_default_max_bytes);
SpatialMapReadResult load_spatial_map(const std::filesystem::path& path,
                                     std::uint64_t max_bytes = spatial_map_default_max_bytes);

struct SpatialMapStoreStatus {
    bool busy = false;
    std::uint64_t submitted_generation = 0, saved_generation = 0;
    std::uint64_t max_bytes = spatial_map_default_max_bytes;
    SpatialMapFileInfo file;
    std::string error;
};

// One immutable, complete snapshot replaces the pending snapshot. Saves never
// merge old geometry back into a newer map. Load/save work runs off the caller.
class SpatialMapStore {
  public:
    // A nonzero history count keeps that many recent managed autosave files
    // across both sources after each successful save. User filenames opt out.
    explicit SpatialMapStore(std::filesystem::path path,
                             std::uint64_t max_bytes = spatial_map_default_max_bytes,
                             std::size_t managed_history = 0);
    ~SpatialMapStore();
    SpatialMapStore(const SpatialMapStore&) = delete;
    SpatialMapStore& operator=(const SpatialMapStore&) = delete;

    bool submit(std::shared_ptr<const SpatialMapSnapshot> map);
    void set_max_bytes(std::uint64_t max_bytes);
    // A nonzero point limit coarsens the loaded snapshot on the worker without
    // changing the source file. Zero retains every validated stored point.
    void request_load(std::size_t max_points = 0);
    std::shared_ptr<const SpatialMapSnapshot> take_loaded();
    SpatialMapStoreStatus status() const;
    // Wait only during an explicit save barrier or shutdown. Errors remain in status().
    void flush();

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace ceres
