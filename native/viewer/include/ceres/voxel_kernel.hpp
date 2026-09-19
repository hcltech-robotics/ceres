#pragma once
#include "stereo_config.hpp"
#include "spatial_observation.hpp"
#include "spatial_map_point.hpp"
#include "voxel_config.hpp"
#include <cuda_runtime_api.h>
#include <memory>

namespace ceres {
// Fixed-allocation projective TSDF working layer and persistent surface cache.
// Signed metric distances and weights are fused on the fine world grid, then
// zero crossings feed the cache. Working SDF samples may be reclaimed once their
// extracted surfaces are retained. No display palette is stored in either layer.
// Capacity pressure merges neighbouring regions through the full 21-level
// hierarchy. Weighted representatives preserve their combined support, including
// observations larger than the cache. Geometry is never discarded to meet a budget.
// Capacity is a power of two from 1 to stereo_voxel_capacity. Coordinates span
// +/- 1048576 fine voxels. Idle time never removes or fades geometry.
// Fresh nearby depth covering a retained coarse cell can restore fine detail.
// Sparse, clustered, invalid and occluded observations preserve that cell.
//
// Create/destroy with the owning CUDA context current and no pending work. Use one
// ordered, non-default stream for every operation. Input and output leases remain
// owned until that stream completes. No operation copies points to the CPU.
class StereoVoxelVolume {
  public:
    explicit StereoVoxelVolume(size_t capacity = stereo_voxel_capacity);
    ~StereoVoxelVolume();
    StereoVoxelVolume(const StereoVoxelVolume&) = delete;
    StereoVoxelVolume& operator=(const StereoVoxelVolume&) = delete;

    cudaError_t clear(cudaStream_t stream);
    // One colour vote per occupied cell per pair, irrespective of point density.
    // The vote averages valid input colours and has a bounded history of 16 votes.
    // Times are nonnegative relative session seconds. Older or repeated samples
    // never refresh newer cells. now_seconds must advance monotonically and must
    // not precede sample_time_seconds. Clear before changing voxel size or timebase.
    // A null input with count=0 is inert. Repeated/older observations are ignored.
    cudaError_t integrate(const StereoPoint* input, size_t count, const VoxelGpuConfig& config,
                          cudaStream_t stream);
    // Fresh depth contradicts cells only inside measured free space. Established
    // cells require coherent successive contradiction and resist loss in proportion
    // to their accumulated support. Depth edges break contradiction runs. Occluded,
    // invalid-depth and out-of-view cells persist. Hand masks exclude incoming
    // and existing hand geometry and protect rays passing through a hand.
    // Zero dimensions with null observation.points applies masks to a fresh,
    // nonempty input point array only. A count of zero remains completely inert.
    cudaError_t integrate_projective(const StereoPoint* input, size_t count,
                                     const VoxelGpuConfig& config,
                                     const ProjectiveDepthObservation& observation,
                                     cudaStream_t stream);
    // Writes capacity() points. Empty cells have valid=0. Occupied points contain
    // world-space voxel centres, fused intrinsic RGB and evidence confidence in a (0..1).
    // valid is the retained power-of-two cell width relative to the fine grid.
    cudaError_t snapshot(StereoPoint* output, cudaStream_t stream);
    // Writes capacity() points, coalescing distant cells in a fixed GPU table.
    // valid is the power-of-two cell width relative to the fine voxel size, or 0.
    // RGB and confidence average contributing retained support. Persistent
    // cells are never changed. A coarse ancestor is eligible only if its entire
    // box satisfies the distance/projected-size limits, keeping tier boundaries
    // complete and non-overlapping. Output order is unspecified.
    cudaError_t snapshot_lod(StereoPoint* output, const VoxelLodConfig& config,
                             cudaStream_t stream);
    // Geometry snapshots contain extracted world positions, measured colour when
    // available and acquisition metadata. observed_us is the last supporting
    // observation, not a subsequent contradiction. Weight counts supporting samples
    // and saturates at UINT32_MAX. Every unused slot has weight=0.
    cudaError_t snapshot_metadata(SpatialMapPoint* output, int64_t time_origin_us,
                                  cudaStream_t stream);
    cudaError_t snapshot_metadata_lod(SpatialMapPoint* output, const VoxelLodConfig& config,
                                      int64_t time_origin_us, cudaStream_t stream);
    // Restore the authoritative surface cache. The TSDF working layer starts
    // empty and is rebuilt by subsequent independent depth observations.
    cudaError_t restore(const SpatialMapPoint* input, size_t count, float voxel_size,
                         int64_t time_origin_us, cudaStream_t stream);
    cudaError_t reconfigure(float voxel_size, cudaStream_t stream);
    cudaError_t set_max_points(size_t maximum_points, cudaStream_t stream);
    size_t max_points() const;
    cudaError_t statistics(VoxelStatistics* output, cudaStream_t stream);
    // Queries the nearest world-grid TSDF sample. weight=0 means unobserved.
    cudaError_t query_tsdf(const StereoPoint* world_points, size_t count,
                           VoxelTsdfSample* output, cudaStream_t stream);
    size_t capacity() const;
    size_t scratch_bytes() const;

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace ceres
