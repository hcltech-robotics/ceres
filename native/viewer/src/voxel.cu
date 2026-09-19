#include "ceres/voxel_kernel.hpp"
#include <algorithm>
#include <cmath>
#include <cuda_runtime.h>
#include <stdexcept>

namespace ceres {
namespace {
using Key = unsigned long long;
constexpr Key empty_key = 0, tombstone_key = 2;
constexpr unsigned axis_bits = 21, axis_mask = (1u << axis_bits) - 1;
constexpr int axis_bias = 1 << (axis_bits - 1);
constexpr unsigned colour_scale = 4095, maximum_weight = 16, block_size = 256;
constexpr unsigned candidate_flag = 0x80000000u;
constexpr unsigned maximum_storage_level = axis_bits;
struct Cell {
    float r, g, b, last_seen, confidence;
    unsigned weight;
    float contradiction_gap;
    unsigned contradictions;
    float x, y, z;
    unsigned colour_weight;
    float last_observed;
    unsigned support;
};
struct Accumulator {
    unsigned r, g, b, count, colour_count;
    float x, y, z;
};
struct GroupAccumulator {
    unsigned long long r, g, b, confidence, support, colour_count;
    unsigned count, latest, weight, latest_evidence;
    double x, y, z;
    Accumulator incoming;
};
struct Pressure {
    unsigned occupied;
    unsigned coarsen_floor, regroup, group_count;
    unsigned budget;
};
struct Admission {
    unsigned active, retry, floor, group_count, overflow, occupied;
};
struct TsdfCell {
    float distance, weight, last_seen;
    float r, g, b, colour_weight;
};
static_assert(stereo_voxel_max_samples <= 0xffffffffu / colour_scale);
static_assert(stereo_voxel_capacity <= 0xffffffffu / colour_scale);

__device__ unsigned hash_key(Key value) {
    value ^= value >> 30;
    value *= 0xbf58476d1ce4e5b9ull;
    value ^= value >> 27;
    value *= 0x94d049bb133111ebull;
    value ^= value >> 31;
    return unsigned(value);
}
__device__ Key spread_axis(unsigned value) {
    Key bits = value & axis_mask;
    bits = (bits | (bits << 32)) & 0x001f00000000ffffull;
    bits = (bits | (bits << 16)) & 0x001f0000ff0000ffull;
    bits = (bits | (bits << 8)) & 0x100f00f00f00f00full;
    bits = (bits | (bits << 4)) & 0x10c30c30c30c30c3ull;
    return (bits | (bits << 2)) & 0x1249249249249249ull;
}
__device__ unsigned compact_axis(Key bits) {
    bits &= 0x1249249249249249ull;
    bits = (bits ^ (bits >> 2)) & 0x10c30c30c30c30c3ull;
    bits = (bits ^ (bits >> 4)) & 0x100f00f00f00f00full;
    bits = (bits ^ (bits >> 8)) & 0x001f0000ff0000ffull;
    bits = (bits ^ (bits >> 16)) & 0x001f00000000ffffull;
    return unsigned((bits ^ (bits >> 32)) & axis_mask);
}
__device__ unsigned key_level(Key key) {
    return unsigned(__ffsll(static_cast<long long>(key)) - 1) / 3;
}
__device__ Key coordinate_key(unsigned x, unsigned y, unsigned z, unsigned level = 0) {
    const unsigned mask = ~((1u << level) - 1);
    const Key morton = spread_axis(x & mask) | (spread_axis(y & mask) << 1) |
                       (spread_axis(z & mask) << 2);
    return (morton << 1) | (Key(1) << (3 * level));
}
__device__ void key_axes(Key key, unsigned* axes) {
    const Key morton = (key & (key - 1)) >> 1;
    axes[0] = compact_axis(morton);
    axes[1] = compact_axis(morton >> 1);
    axes[2] = compact_axis(morton >> 2);
}
__device__ void key_centre(Key key, float voxel_size, float* centre) {
    unsigned axes[3];
    key_axes(key, axes);
    const float half_width = float(1u << key_level(key)) * .5f;
    for (unsigned axis = 0; axis < 3; ++axis)
        centre[axis] = (int(axes[axis]) - axis_bias + half_width) * voxel_size;
}
__device__ bool occupied(Key key) { return key != empty_key && key != tombstone_key; }
__device__ bool quantise(float coordinate, float inverse_size, unsigned& axis) {
    const float cell = floorf(coordinate * inverse_size);
    if (!isfinite(cell) || cell < -float(axis_bias) || cell >= float(axis_bias))
        return false;
    axis = unsigned(int(cell) + axis_bias);
    return true;
}
__device__ void transform(const float* matrix, const float* point, float* output) {
    for (unsigned row = 0; row < 3; ++row)
        output[row] = matrix[row] * point[0] + matrix[4 + row] * point[1] +
                      matrix[8 + row] * point[2] + matrix[12 + row];
}
__device__ bool point_key(const StereoPoint& point, const VoxelGpuConfig& config,
                          const HandMaskSet& hands, Key& key, bool world_input = false) {
    if (!isfinite(point.valid) || point.valid <= 0 || !isfinite(point.x) || !isfinite(point.y) ||
        !isfinite(point.z) || !isfinite(point.r) || !isfinite(point.g) || !isfinite(point.b))
        return false;
    const float local[3]{point.x, point.y, point.z};
    float world[3];
    if (world_input)
        for (unsigned axis = 0; axis < 3; ++axis) world[axis] = local[axis];
    else
        transform(config.head_to_world, local, world);
    if (hand_mask_contains(hands, world[0], world[1], world[2]))
        return false;
    unsigned axes[3];
    for (unsigned axis = 0; axis < 3; ++axis)
        if (!quantise(world[axis], 1.f / config.voxel_size, axes[axis]))
            return false;
    key = coordinate_key(axes[0], axes[1], axes[2]);
    return true;
}
__device__ unsigned quantise_colour(float value) {
    return unsigned(fminf(1.f, fmaxf(0.f, value)) * colour_scale + .5f);
}
__device__ void accumulate(Accumulator* accumulators, unsigned index, const StereoPoint& point,
                           const VoxelGpuConfig& config, bool world_input) {
    auto& sum = accumulators[index];
    if (config.intrinsic_colour) {
        atomicAdd(&sum.r, quantise_colour(point.r));
        atomicAdd(&sum.g, quantise_colour(point.g));
        atomicAdd(&sum.b, quantise_colour(point.b));
        atomicAdd(&sum.colour_count, 1u);
    }
    const float local[3]{point.x, point.y, point.z};
    float world[3];
    if (world_input)
        for (unsigned axis = 0; axis < 3; ++axis) world[axis] = local[axis];
    else
        transform(config.head_to_world, local, world);
    atomicAdd(&sum.x, world[0]);
    atomicAdd(&sum.y, world[1]);
    atomicAdd(&sum.z, world[2]);
    atomicAdd(&sum.count, 1u);
}
__device__ bool pressured(const Pressure* pressure, unsigned capacity) {
    return (pressure->occupied & candidate_flag) &&
           (pressure->occupied & ~candidate_flag) > min(capacity, pressure->budget) * 3 / 4;
}
__global__ void count_candidates(const StereoPoint* points, unsigned count,
                                 VoxelGpuConfig config, HandMaskSet hands, Pressure* pressure,
                                 bool world_input) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    Key key;
    const bool candidate = index < count && point_key(points[index], config, hands, key, world_input);
    if (__any_sync(__activemask(), candidate) && !(threadIdx.x & 31u))
        atomicOr(&pressure->occupied, candidate_flag);
}
__device__ bool measured_depth(const ProjectiveDepthObservation& observation,
                               const float* view, float& depth, StereoPoint* sample = nullptr) {
    const auto* p = observation.projection;
    float clip[4];
    for (unsigned row = 0; row < 4; ++row)
        clip[row] = p[row] * view[0] + p[4 + row] * view[1] +
                    p[8 + row] * view[2] + p[12 + row];
    if (!isfinite(clip[3]) || clip[3] <= 0)
        return false;
    const float u = .5f * (clip[0] / clip[3] + 1.f);
    const float v = .5f * (1.f - clip[1] / clip[3]);
    if (!(u >= 0 && u < 1 && v >= 0 && v < 1))
        return false;
    const auto* n = observation.norm_depth_from_norm_view;
    const float w = n[3] * u + n[7] * v + n[15];
    if (!isfinite(w) || fabsf(w) < 1e-6f)
        return false;
    const float du = (n[0] * u + n[4] * v + n[12]) / w;
    const float dv = (n[1] * u + n[5] * v + n[13]) / w;
    if (!(du >= 0 && du < 1 && dv >= 0 && dv < 1))
        return false;
    const auto point = observation.points[int(dv * observation.height) * observation.width +
                                           int(du * observation.width)];
    const float input[3]{point.x, point.y, point.z};
    float observed_view[3];
    transform(observation.view_from_input, input, observed_view);
    depth = -observed_view[2];
    if (sample) *sample = point;
    return isfinite(point.valid) && point.valid > 0 && isfinite(depth) && depth > 0;
}
__global__ void revise_evidence(Key* keys, Cell* cells, unsigned capacity,
                                VoxelGpuConfig config, ProjectiveDepthObservation observation) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= capacity || !occupied(keys[index]) || !cells[index].weight)
        return;
    float world[3];
    key_centre(keys[index], config.voxel_size, world);
    Cell& cell = cells[index];
    if (hand_mask_contains(observation.hands, world[0], world[1], world[2])) {
        keys[index] = tombstone_key;
        cell = {};
        return;
    }
    if (!observation.points || config.sample_time_seconds <= cell.last_seen)
        return;
    const unsigned previous_contradictions = cell.contradictions;
    cell.contradictions = 0;
    const auto* m = observation.view_from_world;
    const float origin[3]{-(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]),
                          -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]),
                          -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14])};
    if (hand_mask_occludes(observation.hands, origin, world))
        return;
    float view[3];
    transform(m, world, view);
    const float radius = .866026f * config.voxel_size * (1u << key_level(keys[index]));
    const float distance = -view[2];
    if (distance <= radius)
        return;
    const float tolerance = config.surface_tolerance + .01f * distance;
    bool free_space = true;
    float nearest = 3.402823466e38f, farthest = 0;
    // Every sample of the projected voxel footprint must see farther geometry.
    // Invalid pixels, depth edges, foreground occlusion and off-screen areas retain evidence.
    for (int y = -1; y <= 1 && free_space; ++y)
        for (int x = -1; x <= 1; ++x) {
            const float corner[3]{view[0] + x * radius, view[1] + y * radius, view[2] + radius};
            float measured = 0;
            if (!measured_depth(observation, corner, measured) ||
                measured <= distance + radius + tolerance) {
                free_space = false;
                break;
            }
            nearest = fminf(nearest, measured);
            farthest = fmaxf(farthest, measured);
        }
    if (free_space) {
        const bool established = cell.weight >= 4;
        // A depth discontinuity is not coherent evidence that an established
        // surface disappeared. Compare the free-space gap, which stays stable
        // under camera translation, across consecutive accepted observations.
        // Idle time carries no evidence. Invalid, occluded and out-of-view
        // captures already break this sequence above, regardless of cadence.
        const float gap = nearest - distance;
        if (established && farthest - nearest > fmaxf(.08f, .03f * nearest))
            return;
        const bool coherent = previous_contradictions &&
            fabsf(gap - cell.contradiction_gap) <= fmaxf(.08f, .05f * gap);
        cell.contradictions = coherent ? min(previous_contradictions + 1, 255u) : 1u;
        cell.contradiction_gap = gap;
        const float support = established ? sqrtf(float(cell.weight)) : 1.f;
        if (!established || cell.contradictions >= 3)
            cell.confidence = fmaxf(0.f, cell.confidence - config.contradiction_decrement / support);
        cell.last_seen = config.sample_time_seconds;
        if (cell.confidence <= 1e-5f) {
            keys[index] = tombstone_key;
            cell = {};
        }
    }
}
__global__ void prepare(const Key* keys, Accumulator* accumulators, unsigned capacity,
                        Pressure* pressure) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= capacity)
        return;
    accumulators[index] = {};
    if (occupied(keys[index]))
        atomicAdd(&pressure->occupied, 1u);
}
__device__ float axis_distance(float eye, float minimum, float size) {
    return fmaxf(fmaxf(minimum - eye, eye - minimum - size), 0.f);
}
__device__ Key lod_key(Key key, float voxel_size, const VoxelLodConfig& config) {
    unsigned axes[3];
    key_axes(key, axes);
    const unsigned original_level = key_level(key);
    unsigned level = max(original_level, config.max_level);
    for (; level > original_level; --level) {
        const unsigned width = 1u << level;
        const float size = voxel_size * width;
        float squared_distance = 0;
        for (unsigned axis = 0; axis < 3; ++axis) {
            const float minimum = (int(axes[axis] & ~(width - 1)) - axis_bias) * voxel_size;
            const float distance = axis_distance(config.view_position[axis], minimum, size);
            squared_distance += distance * distance;
        }
        const float distance = sqrtf(squared_distance);
        if (distance >= config.minimum_distance &&
            size * config.focal_length_pixels <= distance * config.target_pixels)
            break;
    }
    return coordinate_key(axes[0], axes[1], axes[2], level);
}
__global__ void prepare_groups(Key* keys, GroupAccumulator* sums, unsigned table_capacity,
                               StereoPoint* output, unsigned capacity, unsigned* output_count,
                               const Pressure* pressure) {
    if (pressure && (!pressured(pressure, capacity) || !pressure->regroup))
        return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < table_capacity) { keys[index] = empty_key; sums[index] = {}; }
    if (output && index < capacity)
        output[index] = {};
    if (!index && output_count)
        *output_count = 0;
    if (pressure && !index)
        const_cast<Pressure*>(pressure)->group_count = 0;
}
__device__ void accumulate_cell(GroupAccumulator& sum, const Cell& cell) {
    const auto support = static_cast<unsigned long long>(cell.support);
    if (cell.colour_weight) {
        atomicAdd(&sum.r, quantise_colour(cell.r) * support);
        atomicAdd(&sum.g, quantise_colour(cell.g) * support);
        atomicAdd(&sum.b, quantise_colour(cell.b) * support);
        atomicAdd(&sum.colour_count, support);
    }
    atomicAdd(&sum.x, double(cell.x) * support);
    atomicAdd(&sum.y, double(cell.y) * support);
    atomicAdd(&sum.z, double(cell.z) * support);
    atomicAdd(&sum.confidence, quantise_colour(cell.confidence) * support);
    atomicAdd(&sum.support, support);
    atomicAdd(&sum.count, 1u);
    atomicMax(&sum.latest, __float_as_uint(cell.last_observed));
    atomicMax(&sum.latest_evidence, __float_as_uint(cell.last_seen));
    atomicMax(&sum.weight, cell.weight);
}
__global__ void group_cells(const Key* source_keys, const Cell* cells, unsigned capacity,
                            Key* keys, GroupAccumulator* sums, unsigned table_capacity,
                            float voxel_size, VoxelLodConfig lod, const Pressure* pressure) {
    if (pressure && (!pressured(pressure, capacity) || !pressure->regroup))
        return;
    const unsigned source = blockIdx.x * blockDim.x + threadIdx.x;
    if (source >= capacity || !occupied(source_keys[source]) || !cells[source].weight)
        return;
    const Cell cell = cells[source];
    Key key = lod_key(source_keys[source], voxel_size, lod);
    if (pressure && key_level(key) < pressure->coarsen_floor) {
        unsigned axes[3];
        key_axes(key, axes);
        key = coordinate_key(axes[0], axes[1], axes[2], pressure->coarsen_floor);
    }
    const unsigned mask = table_capacity - 1, start = hash_key(key) & mask;
    for (unsigned probe = 0; probe <= capacity; ++probe) {
        const unsigned index = (start + probe) & mask;
        const Key previous = atomicCAS(keys + index, empty_key, key);
        if (previous != empty_key && previous != key)
            continue;
        accumulate_cell(sums[index], cell);
        return;
    }
}
__device__ Cell group_cell(const GroupAccumulator& sum) {
    Cell result{};
    if (!sum.support) return result;
    const float inverse = 1.f / (float(sum.support) * colour_scale);
    const float colour_inverse = sum.colour_count ? 1.f / (float(sum.colour_count) * colour_scale) : 0;
    result.r = sum.r * colour_inverse;
    result.g = sum.g * colour_inverse;
    result.b = sum.b * colour_inverse;
    result.last_seen = __uint_as_float(sum.latest_evidence);
    result.last_observed = __uint_as_float(sum.latest);
    result.confidence = sum.confidence * inverse;
    result.weight = sum.weight;
    result.support = unsigned(min(sum.support, 0xffffffffull));
    result.x = float(sum.x / sum.support);
    result.y = float(sum.y / sum.support);
    result.z = float(sum.z / sum.support);
    result.colour_weight = sum.colour_count ? sum.weight : 0;
    return result;
}
__global__ void begin_pressure(Pressure* pressure, unsigned capacity) {
    pressure->regroup = pressured(pressure, capacity) ? 1u : 0u;
}
__global__ void count_groups(const GroupAccumulator* sums, unsigned capacity, Pressure* pressure) {
    if (!pressured(pressure, capacity) || !pressure->regroup)
        return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < 2 * capacity && sums[index].count)
        atomicAdd(&pressure->group_count, 1u);
}
__global__ void choose_coarsening(Pressure* pressure, unsigned capacity) {
    if (!pressured(pressure, capacity) || !pressure->regroup)
        return;
    const unsigned budget = min(capacity, pressure->budget);
    const unsigned remaining = max(1u, budget - max(1u, budget / 8));
    // The level-21 universal parent guarantees that spatial merging can meet
    // every positive budget without dropping a region or ranking its evidence.
    if (pressure->group_count > remaining && pressure->coarsen_floor < maximum_storage_level) {
        ++pressure->coarsen_floor;
        return;
    }
    pressure->regroup = 0;
}
__global__ void clear_under_pressure(Key* keys, Cell* cells, unsigned capacity,
                                     const Pressure* pressure) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < capacity && pressured(pressure, capacity)) { keys[index] = empty_key; cells[index] = {}; }
}
__global__ void retain_groups(const Key* source_keys, const GroupAccumulator* sums,
                              Key* keys, Cell* cells, unsigned capacity, Pressure* pressure) {
    if (!pressured(pressure, capacity))
        return;
    const unsigned source = blockIdx.x * blockDim.x + threadIdx.x;
    if (source >= 2 * capacity || !sums[source].count)
        return;
    const Key key = source_keys[source];
    const Cell cell = group_cell(sums[source]);
    const unsigned mask = capacity - 1, hash = hash_key(key), start = hash & mask;
    const unsigned stride = ((hash >> 16) | 1u);
    // Odd-stride probing spans the whole power-of-two table instead of dropping
    // a new region when one contiguous hash window fills. Work remains bounded.
    for (unsigned probe = 0; probe < capacity; ++probe) {
        const unsigned index = (start + probe * stride) & mask;
        if (atomicCAS(keys + index, empty_key, key) == empty_key) { cells[index] = cell; return; }
    }
}
__device__ unsigned find_key(Key key, const Key* keys, unsigned capacity, unsigned probe_limit = 0) {
    const unsigned mask = capacity - 1, hash = hash_key(key), start = hash & mask;
    const unsigned stride = ((hash >> 16) | 1u);
    for (unsigned probe = 0; probe < (probe_limit ? min(capacity, probe_limit) : capacity); ++probe) {
        const unsigned index = (start + probe * stride) & mask;
        const Key found = atomicAdd(const_cast<Key*>(keys) + index, Key(0));
        if (found == key)
            return index;
        if (found == empty_key)
            break;
    }
    return capacity;
}
__global__ void initialise_pressure(Pressure* pressure, unsigned budget, bool forced) {
    *pressure = {};
    pressure->budget = budget;
    if (forced) pressure->occupied = candidate_flag;
}
__global__ void count_tsdf(const Key* keys, unsigned capacity,
                           unsigned* count) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    const bool present = index < capacity && occupied(keys[index]);
    const unsigned mask = __ballot_sync(__activemask(), present);
    if (!(threadIdx.x & 31u)) atomicAdd(count, __popc(mask));
}
__global__ void mark_tsdf_candidates(const StereoPoint* points, unsigned count,
                                     VoxelGpuConfig config, HandMaskSet hands,
                                     unsigned* occupied_count) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    Key key;
    const bool valid = index < count && point_key(points[index], config, hands, key);
    if (__any_sync(__activemask(), valid) && !(threadIdx.x & 31u))
        atomicOr(occupied_count, candidate_flag);
}
__global__ void reclaim_tsdf(Key* keys, TsdfCell* cells, unsigned capacity,
                             const unsigned* count) {
    if (!(*count & candidate_flag) || (*count & ~candidate_flag) <= capacity * 3 / 4) return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    // Surface extraction from the preceding capture has already been committed
    // to the persistent cache. Working SDF samples can therefore be reclaimed
    // without deleting acquired world geometry.
    if (index < capacity) { keys[index] = empty_key; cells[index] = {}; }
}
__device__ void allocate_tsdf_cell(Key key, Key* keys, TsdfCell* cells, unsigned capacity) {
    const unsigned hash = hash_key(key), mask = capacity - 1, start = hash & mask;
    const unsigned stride = (hash >> 16) | 1u;
    for (unsigned probe = 0; probe < min(capacity, 128u); ++probe) {
        const unsigned index = (start + probe * stride) & mask;
        const Key previous = atomicCAS(keys + index, empty_key, key);
        if (previous == empty_key) { cells[index] = {}; return; }
        if (previous == key) return;
    }
}
__global__ void allocate_tsdf_band(const StereoPoint* points, unsigned count, Key* keys,
                                   TsdfCell* cells, unsigned capacity, VoxelGpuConfig config,
                                   ProjectiveDepthObservation observation) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    Key ignored;
    if (index >= count || !point_key(points[index], config, observation.hands, ignored)) return;
    const auto& point = points[index];
    const float input[3]{point.x, point.y, point.z};
    float world[3], view[3];
    transform(config.head_to_world, input, world);
    transform(observation.view_from_world, world, view);
    const float depth = -view[2];
    if (!(depth > 0)) return;
    const auto* m = observation.view_from_world;
    const float origin[3]{-(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]),
                          -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]),
                          -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14])};
    if (hand_mask_occludes(observation.hands, origin, world)) return;
    const float truncation = config.truncation_voxels * config.voxel_size;
    float ray[3];
    float maximum_step = 0;
    for (unsigned axis = 0; axis < 3; ++axis) {
        ray[axis] = (world[axis] - origin[axis]) / depth;
        maximum_step = fmaxf(maximum_step, fabsf(ray[axis]));
    }
    const unsigned steps = min(256u, max(2u, unsigned(ceilf(4.f * config.truncation_voxels * maximum_step))));
    for (unsigned step = 0; step <= steps; ++step) {
        const float distance = depth - truncation + 2.f * truncation * float(step) / steps;
        if (distance <= 0) continue;
        unsigned axes[3];
        bool valid = true;
        for (unsigned axis = 0; axis < 3; ++axis)
            valid = quantise(origin[axis] + ray[axis] * distance, 1.f / config.voxel_size, axes[axis]) && valid;
        if (!valid) continue;
        allocate_tsdf_cell(coordinate_key(axes[0], axes[1], axes[2]), keys, cells, capacity);
        // Neighbour samples make the three positive grid edges available for
        // zero-crossing extraction even when adjacent camera rays are sparse.
        for (unsigned axis = 0; axis < 3; ++axis) {
            if (axes[axis] == axis_mask) continue;
            ++axes[axis];
            allocate_tsdf_cell(coordinate_key(axes[0], axes[1], axes[2]), keys, cells, capacity);
            --axes[axis];
        }
    }
}
__global__ void fuse_tsdf(const Key* keys, TsdfCell* cells, unsigned capacity,
                          VoxelGpuConfig config, ProjectiveDepthObservation observation) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= capacity || !occupied(keys[index])) return;
    float world[3], view[3];
    key_centre(keys[index], config.voxel_size, world);
    if (hand_mask_contains(observation.hands, world[0], world[1], world[2])) {
        cells[index] = {};
        return;
    }
    const auto* m = observation.view_from_world;
    const float origin[3]{-(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]),
                          -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]),
                          -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14])};
    if (hand_mask_occludes(observation.hands, origin, world)) return;
    transform(m, world, view);
    float depth = 0;
    StereoPoint sample{};
    if (!measured_depth(observation, view, depth, &sample)) return;
    const float truncation = config.truncation_voxels * config.voxel_size;
    const float signed_distance = depth + view[2];
    // A point farther behind the observed surface is occluded, not free space.
    if (signed_distance < -truncation) return;
    auto& cell = cells[index];
    const float weight = fminf(cell.weight, float(maximum_weight - 1));
    cell.distance = (cell.distance * weight + fminf(truncation, signed_distance)) / (weight + 1);
    cell.weight = weight + 1;
    cell.last_seen = config.sample_time_seconds;
    if (config.intrinsic_colour && isfinite(sample.r) && isfinite(sample.g) && isfinite(sample.b)) {
        const float colour_weight = fminf(cell.colour_weight, float(maximum_weight - 1));
        cell.r = (cell.r * colour_weight + fminf(1.f, fmaxf(0.f, sample.r))) / (colour_weight + 1);
        cell.g = (cell.g * colour_weight + fminf(1.f, fmaxf(0.f, sample.g))) / (colour_weight + 1);
        cell.b = (cell.b * colour_weight + fminf(1.f, fmaxf(0.f, sample.b))) / (colour_weight + 1);
        cell.colour_weight = colour_weight + 1;
    }
}
__global__ void extract_tsdf(const Key* keys, const TsdfCell* cells, unsigned capacity,
                             VoxelGpuConfig config, StereoPoint* output) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= capacity) return;
    output[index] = {};
    if (!occupied(keys[index]) || cells[index].weight <= 0 ||
        cells[index].last_seen != config.sample_time_seconds) return;
    const auto& cell = cells[index];
    float centre[3];
    key_centre(keys[index], config.voxel_size, centre);
    unsigned axes[3];
    key_axes(keys[index], axes);
    StereoPoint point{};
    unsigned crossings = 0;
    if (fabsf(cell.distance) <= config.voxel_size * 1e-5f) {
        point.x = centre[0]; point.y = centre[1]; point.z = centre[2];
        crossings = 1;
    } else {
        for (unsigned axis = 0; axis < 3; ++axis) {
            if (axes[axis] == axis_mask) continue;
            ++axes[axis];
            const unsigned neighbour = find_key(coordinate_key(axes[0], axes[1], axes[2]), keys, capacity, 128);
            --axes[axis];
            if (neighbour == capacity || cells[neighbour].weight <= 0) continue;
            const float other = cells[neighbour].distance;
            if ((cell.distance < 0) == (other < 0) || cell.distance == other) continue;
            const float fraction = cell.distance / (cell.distance - other);
            point.x += centre[0] + (axis == 0 ? fraction * config.voxel_size : 0);
            point.y += centre[1] + (axis == 1 ? fraction * config.voxel_size : 0);
            point.z += centre[2] + (axis == 2 ? fraction * config.voxel_size : 0);
            ++crossings;
        }
    }
    if (!crossings) return;
    point.x /= crossings; point.y /= crossings; point.z /= crossings;
    point.valid = point.a = 1;
    point.r = cell.r; point.g = cell.g; point.b = cell.b;
    output[index] = point;
}
__global__ void read_tsdf(const Key* keys, const TsdfCell* cells, unsigned capacity,
                          float voxel_size, const StereoPoint* points, unsigned count,
                          VoxelTsdfSample* output) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= count) return;
    output[index] = {};
    const float coordinates[3]{points[index].x, points[index].y, points[index].z};
    unsigned axes[3];
    for (unsigned axis = 0; axis < 3; ++axis)
        if (!quantise(coordinates[axis], 1.f / voxel_size, axes[axis])) return;
    const unsigned found = find_key(coordinate_key(axes[0], axes[1], axes[2]), keys, capacity, 128);
    if (found < capacity && cells[found].weight > 0)
        output[index] = {cells[found].distance, cells[found].weight};
}
__device__ bool refine_visible(Key key, const VoxelGpuConfig& config,
                               const ProjectiveDepthObservation& observation) {
    if (!observation.points)
        return false;
    unsigned axes[3];
    key_axes(key, axes);
    const unsigned width = 1u << key_level(key);
    const float size = width * config.voxel_size;
    const auto* m = observation.view_from_world;
    const float origin[3]{-(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]),
                          -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]),
                          -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14])};
    float farthest_squared = 0;
    for (unsigned axis = 0; axis < 3; ++axis) {
        const float minimum = (int(axes[axis]) - axis_bias) * config.voxel_size;
        const float distance = fmaxf(fabsf(minimum - origin[axis]),
                                     fabsf(minimum + size - origin[axis]));
        farthest_squared += distance * distance;
    }
    // Hysteresis against the pressure LoD thresholds avoids repeated splitting
    // and merging at a boundary. Demand applies to the whole retained cell.
    const float refinement_distance = .8f * fmaxf(1.5f, .75f * width);
    if (farthest_squared >= refinement_distance * refinement_distance)
        return false;
    float world[3], view[3];
    key_centre(key, config.voxel_size, world);
    if (hand_mask_occludes(observation.hands, origin, world))
        return false;
    transform(m, world, view);
    float depth = 0;
    return measured_depth(observation, view, depth) &&
           fabsf(depth + view[2]) <= .866026f * size + config.surface_tolerance;
}
__global__ void mark_refinement(const StereoPoint* points, unsigned count, const Key* keys,
                                Accumulator* sums, unsigned capacity, VoxelGpuConfig config,
                                ProjectiveDepthObservation observation, bool world_input) {
    if (!observation.points)
        return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    Key fine_key;
    if (index >= count || !point_key(points[index], config, observation.hands, fine_key, world_input))
        return;
    unsigned fine_axes[3];
    key_axes(fine_key, fine_axes);
    for (unsigned level = 1; level <= maximum_storage_level; ++level) {
        const Key parent = coordinate_key(fine_axes[0], fine_axes[1], fine_axes[2], level);
        const unsigned cell = find_key(parent, keys, capacity);
        if (cell == capacity)
            continue;
        if (!refine_visible(parent, config, observation))
            return;
        const unsigned width = 1u << level, outer = max(1u, width / 4);
        unsigned coverage = 0, octant = 0;
        for (unsigned axis = 0; axis < 3; ++axis) {
            const unsigned offset = fine_axes[axis] & (width - 1);
            if (offset < outer)
                coverage |= 1u << (2 * axis);
            if (offset >= width - outer)
                coverage |= 1u << (2 * axis + 1);
            if (offset >= width / 2)
                octant |= 1u << axis;
        }
        atomicOr(&sums[cell].count, coverage | (1u << (6 + octant)));
        return;
    }
}
__global__ void refine_cells(Key* keys, Cell* cells, Accumulator* sums, unsigned capacity,
                             Pressure* pressure) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= capacity)
        return;
    const unsigned coverage = sums[index].count;
    unsigned covered_axes = 0;
    for (unsigned axis = 0; axis < 3; ++axis)
        covered_axes += ((coverage >> (2 * axis)) & 3u) == 3u;
    if (covered_axes >= 2 && __popc(coverage >> 6) >= 4) {
        keys[index] = tombstone_key;
        cells[index] = {};
        atomicSub(&pressure->occupied, 1u);
    }
    sums[index].count = 0;
}
__global__ void add_points(const StereoPoint* points, unsigned count, Key* keys,
                           Accumulator* accumulators, unsigned capacity, VoxelGpuConfig config,
                           HandMaskSet hands, bool world_input, Admission* admission) {
    const unsigned point_index = blockIdx.x * blockDim.x + threadIdx.x;
    if (point_index >= count || admission->active)
        return;
    const StereoPoint point = points[point_index];
    Key key;
    if (!point_key(point, config, hands, key, world_input))
        return;
    unsigned index = find_key(key, keys, capacity);
    if (index < capacity) { accumulate(accumulators, index, point, config, world_input); return; }
    unsigned axes[3];
    key_axes(key, axes);
    for (unsigned level = 1; level <= maximum_storage_level; ++level) {
        if (admission->active) return;
        index = find_key(coordinate_key(axes[0], axes[1], axes[2], level), keys, capacity);
        if (index < capacity) { accumulate(accumulators, index, point, config, world_input); return; }
    }
    const unsigned mask = capacity - 1, hash = hash_key(key), start = hash & mask;
    const unsigned stride = ((hash >> 16) | 1u);
    for (unsigned probe = 0; probe < min(capacity, 128u); ++probe) {
        if (admission->active) return;
        index = (start + probe * stride) & mask;
        Key found = atomicAdd(keys + index, Key(0));
        if (found == empty_key || found == tombstone_key) {
            const Key previous = atomicCAS(keys + index, found, key);
            if (previous == found) {
                const unsigned limit = count > capacity ? max(1u, capacity * 7 / 8) : capacity;
                if (atomicAdd(&admission->occupied, 1u) >= limit) {
                    atomicExch(&admission->active, 1u);
                    return;
                }
            }
            found = previous == found ? key : previous;
        }
        if (found == key) { accumulate(accumulators, index, point, config, world_input); return; }
    }
    atomicExch(&admission->active, 1u);
}
__device__ void merge_cell(Cell& cell, const Accumulator& sum, const VoxelGpuConfig& config) {
    if (!sum.count) return;
    const unsigned previous_weight = min(cell.weight, maximum_weight - 1);
    const float inverse_weight = 1.f / float(previous_weight + 1);
    if (sum.colour_count) {
        const unsigned colour_weight = min(cell.colour_weight, maximum_weight - 1);
        const float inverse_count = 1.f / (float(sum.colour_count) * colour_scale);
        const float colour_inverse = 1.f / float(colour_weight + 1);
        cell.r = (cell.r * colour_weight + sum.r * inverse_count) * colour_inverse;
        cell.g = (cell.g * colour_weight + sum.g * inverse_count) * colour_inverse;
        cell.b = (cell.b * colour_weight + sum.b * inverse_count) * colour_inverse;
        cell.colour_weight = colour_weight + 1;
    }
    cell.x = (cell.x * previous_weight + sum.x / sum.count) * inverse_weight;
    cell.y = (cell.y * previous_weight + sum.y / sum.count) * inverse_weight;
    cell.z = (cell.z * previous_weight + sum.z / sum.count) * inverse_weight;
    cell.confidence = cell.weight ? fminf(1.f, cell.confidence + config.support_increment) : 1.f;
    cell.weight = previous_weight + 1;
    cell.support = unsigned(min(static_cast<unsigned long long>(cell.support) + sum.count, 0xffffffffull));
    cell.last_seen = config.sample_time_seconds;
    cell.last_observed = config.sample_time_seconds;
    cell.contradiction_gap = 0;
    cell.contradictions = 0;
}
__global__ void merge_cells(Cell* cells, const Accumulator* sums, unsigned capacity,
                            VoxelGpuConfig config, const Admission* admission) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < capacity && !admission->active) merge_cell(cells[index], sums[index], config);
}
__global__ void initialise_admission(const Key* keys, const Cell* cells, unsigned capacity,
                                     Admission* admission) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < capacity && occupied(keys[index]) && cells[index].weight)
        atomicAdd(&admission->occupied, 1u);
}
__global__ void begin_admission(Admission* admission) {
    admission->retry = admission->active;
}
__global__ void prepare_admission(Key* keys, GroupAccumulator* sums, unsigned capacity,
                                  Admission* admission) {
    if (!admission->retry) return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < capacity) { keys[index] = empty_key; sums[index] = {}; }
    if (!index) { admission->group_count = 0; admission->overflow = 0; }
}
__device__ Key admission_key(Key key, unsigned level) {
    if (key_level(key) >= level) return key;
    unsigned axes[3];
    key_axes(key, axes);
    return coordinate_key(axes[0], axes[1], axes[2], level);
}
__device__ unsigned admission_slot(Key key, Key* keys, unsigned capacity, Admission* admission) {
    const unsigned start = hash_key(key) & (capacity - 1);
    for (unsigned probe = 0; probe < capacity; ++probe) {
        if (admission->overflow) return capacity;
        const unsigned index = (start + probe) & (capacity - 1);
        const Key previous = atomicCAS(keys + index, empty_key, key);
        if (previous == empty_key) {
            // Only half the fixed scratch table may contain committed groups.
            // A failed pass changes neither retained cells nor its input lease.
            if (atomicAdd(&admission->group_count, 1u) >= capacity / 2) {
                atomicExch(&admission->overflow, 1u);
                return capacity;
            }
            return index;
        }
        if (previous == key) return index;
    }
    atomicExch(&admission->overflow, 1u);
    return capacity;
}
__global__ void group_admission_cells(const Key* source, const Cell* cells, unsigned capacity,
                                      Key* keys, GroupAccumulator* sums, Admission* admission) {
    if (!admission->retry) return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= capacity || !occupied(source[index]) || !cells[index].weight) return;
    const Key key = admission_key(source[index], admission->floor);
    const unsigned target = admission_slot(key, keys, 2 * capacity, admission);
    if (target < 2 * capacity) accumulate_cell(sums[target], cells[index]);
}
__global__ void group_admission_points(const StereoPoint* points, unsigned count,
                                       unsigned capacity, Key* keys, GroupAccumulator* sums, VoxelGpuConfig config,
                                       HandMaskSet hands, bool world_input, Admission* admission) {
    if (!admission->retry || admission->overflow) return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    Key key;
    if (index >= count || !point_key(points[index], config, hands, key, world_input)) return;
    unsigned axes[3];
    key_axes(key, axes);
    // Original retained groups were inserted by the preceding kernel. Resolve
    // their ancestors in this at-most-half-full table, where provisional writes
    // from the failed first attempt cannot force full-table negative lookups.
    for (unsigned level = admission->floor + 1; level <= maximum_storage_level; ++level) {
        if (admission->overflow) return;
        const Key ancestor = coordinate_key(axes[0], axes[1], axes[2], level);
        const unsigned start = hash_key(ancestor) & (2 * capacity - 1);
        bool retained = false;
        for (unsigned probe = 0; probe < 2 * capacity; ++probe) {
            const unsigned target = (start + probe) & (2 * capacity - 1);
            const Key found = atomicAdd(keys + target, Key(0));
            if (found == empty_key) break;
            if (found == ancestor && sums[target].count) { retained = true; break; }
        }
        if (retained) { key = ancestor; break; }
    }
    key = admission_key(key, admission->floor);
    const unsigned target = admission_slot(key, keys, 2 * capacity, admission);
    if (target < 2 * capacity) accumulate(&sums[target].incoming, 0, points[index], config, world_input);
}
__global__ void choose_admission(Admission* admission, unsigned budget) {
    if (!admission->retry) return;
    if (admission->overflow || admission->group_count > budget) {
        ++admission->floor;
        return;
    }
    admission->retry = 0;
}
__global__ void clear_for_admission(Key* keys, Cell* cells, unsigned capacity,
                                    const Admission* admission) {
    if (!admission->active || admission->retry) return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < capacity) { keys[index] = empty_key; cells[index] = {}; }
}
__global__ void commit_admission(const Key* source, const GroupAccumulator* sums,
                                 Key* keys, Cell* cells, unsigned capacity,
                                 VoxelGpuConfig config, const Admission* admission) {
    if (!admission->active || admission->retry) return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= 2 * capacity || !occupied(source[index])) return;
    const Key key = source[index];
    Cell cell = group_cell(sums[index]);
    merge_cell(cell, sums[index].incoming, config);
    const unsigned hash = hash_key(key), stride = (hash >> 16) | 1u;
    for (unsigned probe = 0; probe < capacity; ++probe) {
        const unsigned target = ((hash & (capacity - 1)) + probe * stride) & (capacity - 1);
        if (atomicCAS(keys + target, empty_key, key) == empty_key) { cells[target] = cell; return; }
    }
}
__device__ StereoPoint cell_point(Key key, const Cell& cell, float voxel_size) {
    StereoPoint point{};
    float centre[3];
    key_centre(key, voxel_size, centre);
    point.x = centre[0]; point.y = centre[1]; point.z = centre[2];
    point.valid = float(1u << key_level(key));
    point.r = cell.r; point.g = cell.g; point.b = cell.b; point.a = cell.confidence;
    return point;
}
__global__ void write_snapshot(const Key* keys, const Cell* cells, unsigned capacity,
                               float voxel_size, StereoPoint* output) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < capacity)
        output[index] = occupied(keys[index]) && cells[index].weight ?
                        cell_point(keys[index], cells[index], voxel_size) : StereoPoint{};
}
__global__ void write_groups(const Key* keys, const GroupAccumulator* sums,
                             unsigned table_capacity, float voxel_size, StereoPoint* output,
                             unsigned* output_count) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < table_capacity && sums[index].count)
        output[atomicAdd(output_count, 1u)] = cell_point(keys[index], group_cell(sums[index]), voxel_size);
}
__device__ SpatialMapPoint metadata_point(Key key, const Cell& cell, float voxel_size,
                                         int64_t time_origin_us) {
    SpatialMapPoint result{};
    result.x = cell.x; result.y = cell.y; result.z = cell.z;
    result.cell_size = voxel_size * (1u << key_level(key));
    result.r = cell.r; result.g = cell.g; result.b = cell.b;
    result.confidence = cell.confidence;
    result.observed_us = time_origin_us + int64_t(double(cell.last_observed) * 1000000.0 + .5);
    result.weight = cell.support;
    result.flags = cell.colour_weight ? spatial_map_intrinsic_rgb : 0;
    return result;
}
__global__ void write_metadata(const Key* keys, const Cell* cells, unsigned capacity,
                               float voxel_size, int64_t origin, SpatialMapPoint* output) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < capacity)
        output[index] = occupied(keys[index]) && cells[index].weight ?
            metadata_point(keys[index], cells[index], voxel_size, origin) : SpatialMapPoint{};
}
__global__ void write_group_metadata(const Key* keys, const GroupAccumulator* sums,
                                     unsigned capacity, float voxel_size, int64_t origin,
                                     SpatialMapPoint* output, unsigned* count) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < capacity && sums[index].count)
        output[atomicAdd(count, 1u)] = metadata_point(keys[index], group_cell(sums[index]), voxel_size, origin);
}
__device__ void add_cell_group(Key key, const Cell& cell, Key* keys, GroupAccumulator* sums,
                               unsigned capacity) {
    unsigned axes[3];
    key_axes(key, axes);
    // Import and regridding run coarse levels first. A fine representative is
    // merged into any retained ancestor instead of introducing overlapping cells.
    for (unsigned level = key_level(key) + 1; level <= maximum_storage_level; ++level) {
        const Key ancestor = coordinate_key(axes[0], axes[1], axes[2], level);
        const unsigned start = hash_key(ancestor) & (capacity - 1);
        for (unsigned probe = 0; probe < capacity; ++probe) {
            const Key found = keys[(start + probe) & (capacity - 1)];
            if (found == ancestor) { key = ancestor; break; }
            if (found == empty_key) break;
        }
    }
    const unsigned start = hash_key(key) & (capacity - 1);
    for (unsigned probe = 0; probe < capacity; ++probe) {
        const unsigned index = (start + probe) & (capacity - 1);
        const Key previous = atomicCAS(keys + index, empty_key, key);
        if (previous != empty_key && previous != key) continue;
        accumulate_cell(sums[index], cell);
        return;
    }
}
__device__ unsigned retained_level(float cell_size, float voxel_size) {
    unsigned level = 0;
    while (level < maximum_storage_level && voxel_size * (1u << level) < cell_size * .99999f) ++level;
    return level;
}
__global__ void regrid_cells(const Key* source_keys, const Cell* cells, unsigned count,
                             float old_size, float new_size, unsigned pass,
                             Key* keys, GroupAccumulator* sums, unsigned capacity) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= count || !occupied(source_keys[index]) || !cells[index].weight) return;
    const Cell cell = cells[index];
    const unsigned level = retained_level(old_size * (1u << key_level(source_keys[index])), new_size);
    if (level != pass) return;
    const float coordinates[3]{cell.x, cell.y, cell.z};
    unsigned axes[3];
    for (unsigned axis = 0; axis < 3; ++axis)
        if (!quantise(coordinates[axis], 1.f / new_size, axes[axis])) return;
    add_cell_group(coordinate_key(axes[0], axes[1], axes[2], level), cell, keys, sums, capacity);
}
__global__ void import_metadata(const SpatialMapPoint* input, unsigned count, float voxel_size,
                                int64_t origin, unsigned pass, Key* keys,
                                GroupAccumulator* sums, unsigned capacity) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= count) return;
    const auto point = input[index];
    if (!point.weight || !isfinite(point.cell_size) || point.cell_size <= 0 ||
        !isfinite(point.confidence) || point.confidence <= 0 || point.confidence > 1 ||
        point.observed_us < 0) return;
    const unsigned level = retained_level(point.cell_size, voxel_size);
    if (level != pass) return;
    const float coordinates[3]{point.x, point.y, point.z};
    unsigned axes[3];
    for (unsigned axis = 0; axis < 3; ++axis)
        if (!quantise(coordinates[axis], 1.f / voxel_size, axes[axis])) return;
    Cell cell{};
    cell.x = point.x; cell.y = point.y; cell.z = point.z;
    cell.confidence = point.confidence;
    cell.weight = min(point.weight, maximum_weight);
    cell.support = point.weight;
    cell.last_seen = float(fmax(0.0, (double(point.observed_us) - double(origin)) / 1000000.0));
    cell.last_observed = cell.last_seen;
    if ((point.flags & spatial_map_intrinsic_rgb) && isfinite(point.r) && isfinite(point.g) && isfinite(point.b)) {
        cell.r = fminf(1.f, fmaxf(0.f, point.r));
        cell.g = fminf(1.f, fmaxf(0.f, point.g));
        cell.b = fminf(1.f, fmaxf(0.f, point.b));
        cell.colour_weight = cell.weight;
    }
    add_cell_group(coordinate_key(axes[0], axes[1], axes[2], level), cell, keys, sums, capacity);
}
__global__ void materialise_groups(const Key* source, const GroupAccumulator* sums,
                                   Key* keys, Cell* cells, unsigned capacity) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= 2 * capacity || !sums[index].count) return;
    const Key key = source[index];
    const unsigned hash = hash_key(key), stride = (hash >> 16) | 1u;
    for (unsigned probe = 0; probe < capacity; ++probe) {
        const unsigned target = ((hash & (capacity - 1)) + probe * stride) & (capacity - 1);
        if (atomicCAS(keys + target, empty_key, key) == empty_key) {
            cells[target] = group_cell(sums[index]);
            return;
        }
    }
}
__global__ void initialise_statistics(VoxelStatistics* output) {
    *output = {};
    output->minimum_cell_size = 3.402823466e38f;
}
__global__ void count_statistics(const Key* keys, const Cell* cells, unsigned capacity,
                                 const Key* tsdf_keys, const TsdfCell* tsdf_cells,
                                 unsigned tsdf_capacity, float size, VoxelStatistics* output) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < capacity && occupied(keys[index]) && cells[index].weight) {
        atomicAdd(&output->occupied_points, 1u);
        const float width = size * (1u << key_level(keys[index]));
        atomicMin(reinterpret_cast<unsigned*>(&output->minimum_cell_size), __float_as_uint(width));
        atomicMax(reinterpret_cast<unsigned*>(&output->maximum_cell_size), __float_as_uint(width));
    }
    if (index < tsdf_capacity && occupied(tsdf_keys[index]) && tsdf_cells[index].weight > 0)
        atomicAdd(&output->tsdf_voxels, 1u);
}
__global__ void finish_statistics(VoxelStatistics* output) {
    if (!output->occupied_points) output->minimum_cell_size = 0;
}
void check(cudaError_t result) {
    if (result != cudaSuccess)
        throw std::runtime_error(cudaGetErrorString(result));
}
bool valid_rigid(const float* m) {
    for (int i = 0; i < 16; ++i)
        if (!std::isfinite(m[i]))
            return false;
    if (std::abs(m[3]) > 1e-4f || std::abs(m[7]) > 1e-4f || std::abs(m[11]) > 1e-4f ||
        std::abs(m[15] - 1.f) > 1e-4f)
        return false;
    for (int column = 0; column < 3; ++column)
        for (int other = column; other < 3; ++other) {
            float dot = 0;
            for (int row = 0; row < 3; ++row)
                dot += m[column * 4 + row] * m[other * 4 + row];
            if (std::abs(dot - (column == other ? 1.f : 0.f)) > 1e-3f)
                return false;
        }
    const float determinant = m[0] * (m[5] * m[10] - m[9] * m[6]) -
                              m[4] * (m[1] * m[10] - m[9] * m[2]) +
                              m[8] * (m[1] * m[6] - m[5] * m[2]);
    return std::abs(determinant - 1.f) <= 1e-3f;
}
bool valid_config(const VoxelGpuConfig& config) {
    return std::isfinite(config.voxel_size) && config.voxel_size > 0 &&
           std::isfinite(1.f / config.voxel_size) &&
           std::isfinite(config.sample_time_seconds) && config.sample_time_seconds >= 0 &&
           std::isfinite(config.now_seconds) && config.now_seconds >= config.sample_time_seconds &&
           std::isfinite(config.contradiction_decrement) && config.contradiction_decrement > 0 &&
           config.contradiction_decrement <= 1 && std::isfinite(config.support_increment) &&
           config.support_increment > 0 && config.support_increment <= 1 &&
           std::isfinite(config.surface_tolerance) && config.surface_tolerance >= 0 &&
           std::isfinite(config.truncation_voxels) && config.truncation_voxels >= 1 &&
           config.truncation_voxels <= 8 &&
           valid_rigid(config.head_to_world);
}
bool valid_lod_config(const VoxelLodConfig& config) {
    return std::isfinite(config.view_position[0]) && std::isfinite(config.view_position[1]) &&
           std::isfinite(config.view_position[2]) && std::isfinite(config.focal_length_pixels) &&
           config.focal_length_pixels > 0 && std::isfinite(config.target_pixels) &&
           config.target_pixels > 0 && std::isfinite(config.minimum_distance) &&
           config.minimum_distance >= 0 && config.max_level <= 6;
}
bool valid_observation(const ProjectiveDepthObservation& observation) {
    if (!valid_hand_mask(observation.hands))
        return false;
    if (!observation.points)
        return observation.width == 0 && observation.height == 0;
    if (observation.width <= 0 || observation.height <= 0 ||
        size_t(observation.width) * size_t(observation.height) > stereo_voxel_max_samples ||
        !valid_rigid(observation.view_from_world) || !valid_rigid(observation.view_from_input))
        return false;
    for (unsigned i = 0; i < 16; ++i)
        if (!std::isfinite(observation.projection[i]) ||
            !std::isfinite(observation.norm_depth_from_norm_view[i]))
            return false;
    return true;
}
} // namespace

struct StereoVoxelVolume::Impl {
    unsigned capacity, maximum_points, tsdf_capacity;
    Key* keys = nullptr;
    Cell* cells = nullptr;
    Accumulator* accumulators = nullptr;
    Key* group_keys = nullptr;
    GroupAccumulator* group_accumulators = nullptr;
    unsigned* output_count = nullptr;
    Pressure* pressure = nullptr;
    Admission* admission = nullptr;
    Key* tsdf_keys = nullptr;
    TsdfCell* tsdf_cells = nullptr;
    StereoPoint* surface_points = nullptr;
    unsigned* tsdf_count = nullptr;
    bool initialised = false, configured = false, observed = false;
    float voxel_size = .03f, now = 0, sample_time = 0;
    VoxelGpuConfig configuration;
    explicit Impl(unsigned size) : capacity(size), maximum_points(size),
        tsdf_capacity(unsigned(std::min<size_t>(4 * size, stereo_voxel_max_samples))) {
        configuration.head_to_world[0] = configuration.head_to_world[5] =
            configuration.head_to_world[10] = configuration.head_to_world[15] = 1;
    }
    ~Impl() {
        cudaFree(keys); cudaFree(cells); cudaFree(accumulators);
        cudaFree(group_keys); cudaFree(group_accumulators); cudaFree(output_count); cudaFree(pressure); cudaFree(admission);
        cudaFree(tsdf_keys); cudaFree(tsdf_cells); cudaFree(surface_points); cudaFree(tsdf_count);
    }
    cudaError_t compact(const StereoPoint* input, unsigned count, const VoxelGpuConfig& config,
                         const ProjectiveDepthObservation& observation, cudaStream_t stream,
                         bool world_input, bool forced = false, bool refine = false) {
        const unsigned grid = (capacity + block_size - 1) / block_size;
        const unsigned table_grid = (2 * capacity + block_size - 1) / block_size;
        initialise_pressure<<<1, 1, 0, stream>>>(pressure, maximum_points, forced);
        prepare<<<grid, block_size, 0, stream>>>(keys, accumulators, capacity, pressure);
        if (count)
            count_candidates<<<(count + block_size - 1) / block_size, block_size, 0, stream>>>(
                input, count, config, observation.hands, pressure, world_input);
        if (refine && count) {
            mark_refinement<<<(count + block_size - 1) / block_size, block_size, 0, stream>>>(
                input, count, keys, accumulators, capacity, config, observation, world_input);
            refine_cells<<<grid, block_size, 0, stream>>>(keys, cells, accumulators, capacity, pressure);
        }
        begin_pressure<<<1, 1, 0, stream>>>(pressure, capacity);
        VoxelLodConfig storage;
        for (unsigned axis = 0; axis < 3; ++axis)
            storage.view_position[axis] = config.head_to_world[12 + axis];
        storage.focal_length_pixels = 1.f;
        storage.target_pixels = config.voxel_size * (4.f / 3.f);
        storage.minimum_distance = 1.5f;
        storage.max_level = 3;
        for (unsigned attempt = 0; attempt <= maximum_storage_level; ++attempt) {
            prepare_groups<<<table_grid, block_size, 0, stream>>>(group_keys, group_accumulators,
                2 * capacity, nullptr, capacity, nullptr, pressure);
            group_cells<<<grid, block_size, 0, stream>>>(keys, cells, capacity,
                group_keys, group_accumulators, 2 * capacity, config.voxel_size, storage, pressure);
            count_groups<<<table_grid, block_size, 0, stream>>>(group_accumulators, capacity, pressure);
            choose_coarsening<<<1, 1, 0, stream>>>(pressure, capacity);
        }
        clear_under_pressure<<<grid, block_size, 0, stream>>>(keys, cells, capacity, pressure);
        retain_groups<<<table_grid, block_size, 0, stream>>>(group_keys, group_accumulators,
            keys, cells, capacity, pressure);
        return cudaGetLastError();
    }
};
StereoVoxelVolume::StereoVoxelVolume(size_t capacity) {
    if (!capacity || capacity > stereo_voxel_capacity || (capacity & (capacity - 1)))
        throw std::runtime_error("Voxel capacity must be a power of two from 1 to 262144");
    impl_ = std::make_unique<Impl>(unsigned(capacity));
    check(cudaMalloc(&impl_->keys, capacity * sizeof(Key)));
    check(cudaMalloc(&impl_->cells, capacity * sizeof(Cell)));
    check(cudaMalloc(&impl_->accumulators, capacity * sizeof(Accumulator)));
    check(cudaMalloc(&impl_->group_keys, 2 * capacity * sizeof(Key)));
    check(cudaMalloc(&impl_->group_accumulators, 2 * capacity * sizeof(GroupAccumulator)));
    check(cudaMalloc(&impl_->output_count, sizeof(unsigned)));
    check(cudaMalloc(&impl_->pressure, sizeof(Pressure)));
    check(cudaMalloc(&impl_->admission, sizeof(Admission)));
    check(cudaMalloc(&impl_->tsdf_keys, impl_->tsdf_capacity * sizeof(Key)));
    check(cudaMalloc(&impl_->tsdf_cells, impl_->tsdf_capacity * sizeof(TsdfCell)));
    check(cudaMalloc(&impl_->surface_points, impl_->tsdf_capacity * sizeof(StereoPoint)));
    check(cudaMalloc(&impl_->tsdf_count, sizeof(unsigned)));
}
StereoVoxelVolume::~StereoVoxelVolume() = default;
size_t StereoVoxelVolume::capacity() const { return impl_->capacity; }
size_t StereoVoxelVolume::scratch_bytes() const {
    return capacity() * (sizeof(Key) + sizeof(Cell) + sizeof(Accumulator) +
                        2 * (sizeof(Key) + sizeof(GroupAccumulator))) +
           sizeof(unsigned) + sizeof(Pressure) + sizeof(Admission) +
           impl_->tsdf_capacity * (sizeof(Key) + sizeof(TsdfCell) + sizeof(StereoPoint)) +
           sizeof(unsigned);
}
cudaError_t StereoVoxelVolume::clear(cudaStream_t stream) {
    if (!stream)
        return cudaErrorInvalidValue;
    impl_->initialised = false;
    auto result = cudaMemsetAsync(impl_->keys, 0, capacity() * sizeof(Key), stream);
    if (result != cudaSuccess)
        return result;
    result = cudaMemsetAsync(impl_->cells, 0, capacity() * sizeof(Cell), stream);
    if (result != cudaSuccess)
        return result;
    result = cudaMemsetAsync(impl_->tsdf_keys, 0, impl_->tsdf_capacity * sizeof(Key), stream);
    if (result != cudaSuccess) return result;
    result = cudaMemsetAsync(impl_->tsdf_cells, 0, impl_->tsdf_capacity * sizeof(TsdfCell), stream);
    if (result != cudaSuccess) return result;
    impl_->initialised = true;
    impl_->configured = impl_->observed = false;
    impl_->now = impl_->sample_time = 0;
    return cudaSuccess;
}
cudaError_t StereoVoxelVolume::integrate(const StereoPoint* input, size_t count,
                                         const VoxelGpuConfig& config, cudaStream_t stream) {
    return integrate_projective(input, count, config, {}, stream);
}
cudaError_t StereoVoxelVolume::integrate_projective(const StereoPoint* input, size_t count,
                                                    const VoxelGpuConfig& config,
                                                    const ProjectiveDepthObservation& observation,
                                                    cudaStream_t stream) {
    if (!stream || (count && !input) || count > stereo_voxel_max_samples || !valid_config(config) ||
        !valid_observation(observation) || (impl_->configured &&
         (config.voxel_size != impl_->voxel_size || config.now_seconds < impl_->now)))
        return cudaErrorInvalidValue;
    if (!impl_->initialised) {
        const auto result = clear(stream);
        if (result != cudaSuccess)
            return result;
    }
    impl_->voxel_size = config.voxel_size;
    impl_->configuration = config;
    impl_->now = config.now_seconds;
    impl_->configured = true;
    if (!count || (impl_->observed && config.sample_time_seconds <= impl_->sample_time))
        return cudaSuccess;
    const unsigned size = impl_->capacity, grid = (size + block_size - 1) / block_size;
    revise_evidence<<<grid, block_size, 0, stream>>>(impl_->keys, impl_->cells, size, config, observation);
    auto result = cudaGetLastError();
    if (result != cudaSuccess)
        return result;
    bool world_input = false;
    if (observation.points) {
        const unsigned tsdf_grid = (impl_->tsdf_capacity + block_size - 1) / block_size;
        result = cudaMemsetAsync(impl_->tsdf_count, 0, sizeof(unsigned), stream);
        if (result != cudaSuccess) return result;
        count_tsdf<<<tsdf_grid, block_size, 0, stream>>>(impl_->tsdf_keys,
            impl_->tsdf_capacity, impl_->tsdf_count);
        mark_tsdf_candidates<<<(unsigned(count) + block_size - 1) / block_size, block_size, 0, stream>>>(
            input, unsigned(count), config, observation.hands, impl_->tsdf_count);
        reclaim_tsdf<<<tsdf_grid, block_size, 0, stream>>>(impl_->tsdf_keys, impl_->tsdf_cells,
            impl_->tsdf_capacity, impl_->tsdf_count);
        allocate_tsdf_band<<<(unsigned(count) + block_size - 1) / block_size, block_size, 0, stream>>>(
            input, unsigned(count), impl_->tsdf_keys, impl_->tsdf_cells, impl_->tsdf_capacity, config, observation);
        fuse_tsdf<<<tsdf_grid, block_size, 0, stream>>>(impl_->tsdf_keys, impl_->tsdf_cells,
            impl_->tsdf_capacity, config, observation);
        extract_tsdf<<<tsdf_grid, block_size, 0, stream>>>(impl_->tsdf_keys, impl_->tsdf_cells,
            impl_->tsdf_capacity, config, impl_->surface_points);
        input = impl_->surface_points;
        count = impl_->tsdf_capacity;
        world_input = true;
    }
    result = impl_->compact(input, unsigned(count), config, observation, stream, world_input, false, true);
    if (result != cudaSuccess) return result;
    result = cudaMemsetAsync(impl_->admission, 0, sizeof(Admission), stream);
    if (result != cudaSuccess) return result;
    initialise_admission<<<grid, block_size, 0, stream>>>(impl_->keys, impl_->cells, size, impl_->admission);
    add_points<<<(unsigned(count) + block_size - 1) / block_size, block_size, 0, stream>>>(
        input, unsigned(count), impl_->keys, impl_->accumulators, size, config, observation.hands,
        world_input, impl_->admission);
    merge_cells<<<grid, block_size, 0, stream>>>(impl_->cells, impl_->accumulators, size, config, impl_->admission);
    begin_admission<<<1, 1, 0, stream>>>(impl_->admission);
    const unsigned table_grid = (2 * size + block_size - 1) / block_size;
    // Retry the entire observation transaction. Failed provisional insertions
    // have no cell weight and cannot masquerade as retained source evidence.
    for (unsigned attempt = 0; attempt <= maximum_storage_level; ++attempt) {
        prepare_admission<<<table_grid, block_size, 0, stream>>>(impl_->group_keys,
            impl_->group_accumulators, 2 * size, impl_->admission);
        group_admission_cells<<<grid, block_size, 0, stream>>>(impl_->keys, impl_->cells, size,
            impl_->group_keys, impl_->group_accumulators, impl_->admission);
        group_admission_points<<<(unsigned(count) + block_size - 1) / block_size, block_size, 0, stream>>>(
            input, unsigned(count), size, impl_->group_keys,
            impl_->group_accumulators, config, observation.hands, world_input, impl_->admission);
        choose_admission<<<1, 1, 0, stream>>>(impl_->admission, impl_->maximum_points);
    }
    clear_for_admission<<<grid, block_size, 0, stream>>>(impl_->keys, impl_->cells, size, impl_->admission);
    commit_admission<<<table_grid, block_size, 0, stream>>>(impl_->group_keys, impl_->group_accumulators,
        impl_->keys, impl_->cells, size, config, impl_->admission);
    result = impl_->maximum_points < size ?
        impl_->compact(input, unsigned(count), config, observation, stream, world_input) : cudaGetLastError();
    if (result == cudaSuccess) { impl_->observed = true; impl_->sample_time = config.sample_time_seconds; }
    return result;
}
cudaError_t StereoVoxelVolume::snapshot(StereoPoint* output, cudaStream_t stream) {
    if (!output || !stream)
        return cudaErrorInvalidValue;
    if (!impl_->initialised) {
        const auto result = clear(stream);
        if (result != cudaSuccess)
            return result;
    }
    write_snapshot<<<(impl_->capacity + block_size - 1) / block_size, block_size, 0, stream>>>(
        impl_->keys, impl_->cells, impl_->capacity, impl_->voxel_size, output);
    return cudaGetLastError();
}
cudaError_t StereoVoxelVolume::snapshot_lod(StereoPoint* output, const VoxelLodConfig& config,
                                            cudaStream_t stream) {
    if (!output || !stream || !valid_lod_config(config))
        return cudaErrorInvalidValue;
    if (!config.max_level)
        return snapshot(output, stream);
    if (!impl_->initialised) {
        const auto result = clear(stream);
        if (result != cudaSuccess)
            return result;
    }
    const unsigned size = impl_->capacity, table_grid = (2 * size + block_size - 1) / block_size;
    prepare_groups<<<table_grid, block_size, 0, stream>>>(impl_->group_keys,
        impl_->group_accumulators, 2 * size, output, size, impl_->output_count, nullptr);
    group_cells<<<(size + block_size - 1) / block_size, block_size, 0, stream>>>(impl_->keys,
        impl_->cells, size, impl_->group_keys, impl_->group_accumulators, 2 * size,
        impl_->voxel_size, config, nullptr);
    write_groups<<<table_grid, block_size, 0, stream>>>(impl_->group_keys,
        impl_->group_accumulators, 2 * size, impl_->voxel_size, output, impl_->output_count);
    return cudaGetLastError();
}
cudaError_t StereoVoxelVolume::snapshot_metadata(SpatialMapPoint* output, int64_t origin,
                                                 cudaStream_t stream) {
    if (!output || !stream || origin < 0) return cudaErrorInvalidValue;
    if (!impl_->initialised) {
        const auto result = clear(stream);
        if (result != cudaSuccess) return result;
    }
    write_metadata<<<(impl_->capacity + block_size - 1) / block_size, block_size, 0, stream>>>(
        impl_->keys, impl_->cells, impl_->capacity, impl_->voxel_size, origin, output);
    return cudaGetLastError();
}
cudaError_t StereoVoxelVolume::snapshot_metadata_lod(SpatialMapPoint* output,
                                                     const VoxelLodConfig& config,
                                                     int64_t origin, cudaStream_t stream) {
    if (!output || !stream || origin < 0 || !valid_lod_config(config)) return cudaErrorInvalidValue;
    if (!config.max_level) return snapshot_metadata(output, origin, stream);
    if (!impl_->initialised) {
        const auto result = clear(stream);
        if (result != cudaSuccess) return result;
    }
    const auto result = cudaMemsetAsync(output, 0, capacity() * sizeof(SpatialMapPoint), stream);
    if (result != cudaSuccess) return result;
    const unsigned size = impl_->capacity, table_grid = (2 * size + block_size - 1) / block_size;
    prepare_groups<<<table_grid, block_size, 0, stream>>>(impl_->group_keys,
        impl_->group_accumulators, 2 * size, nullptr, size, impl_->output_count, nullptr);
    group_cells<<<(size + block_size - 1) / block_size, block_size, 0, stream>>>(impl_->keys,
        impl_->cells, size, impl_->group_keys, impl_->group_accumulators, 2 * size,
        impl_->voxel_size, config, nullptr);
    write_group_metadata<<<table_grid, block_size, 0, stream>>>(impl_->group_keys,
        impl_->group_accumulators, 2 * size, impl_->voxel_size, origin, output, impl_->output_count);
    return cudaGetLastError();
}
cudaError_t StereoVoxelVolume::restore(const SpatialMapPoint* input, size_t count,
                                       float voxel_size, int64_t origin, cudaStream_t stream) {
    if (!stream || (count && !input) || count > capacity() || origin < 0 ||
        !std::isfinite(voxel_size) || voxel_size <= 0 || !std::isfinite(1.f / voxel_size))
        return cudaErrorInvalidValue;
    auto result = clear(stream);
    if (result != cudaSuccess) return result;
    impl_->voxel_size = impl_->configuration.voxel_size = voxel_size;
    impl_->configured = true;
    if (!count) return cudaSuccess;
    const unsigned size = impl_->capacity, table_grid = (2 * size + block_size - 1) / block_size;
    prepare_groups<<<table_grid, block_size, 0, stream>>>(impl_->group_keys,
        impl_->group_accumulators, 2 * size, nullptr, size, nullptr, nullptr);
    for (int level = int(maximum_storage_level); level >= 0; --level)
        import_metadata<<<(unsigned(count) + block_size - 1) / block_size, block_size, 0, stream>>>(
            input, unsigned(count), voxel_size, origin, unsigned(level), impl_->group_keys,
            impl_->group_accumulators, 2 * size);
    materialise_groups<<<table_grid, block_size, 0, stream>>>(impl_->group_keys,
        impl_->group_accumulators, impl_->keys, impl_->cells, size);
    return impl_->compact(nullptr, 0, impl_->configuration, {}, stream, false, true);
}
cudaError_t StereoVoxelVolume::reconfigure(float voxel_size, cudaStream_t stream) {
    if (!stream || !std::isfinite(voxel_size) || voxel_size <= 0 || !std::isfinite(1.f / voxel_size))
        return cudaErrorInvalidValue;
    if (!impl_->initialised) {
        const auto result = clear(stream);
        if (result != cudaSuccess) return result;
    }
    if (impl_->voxel_size == voxel_size) return cudaSuccess;
    const unsigned size = impl_->capacity, table_grid = (2 * size + block_size - 1) / block_size;
    prepare_groups<<<table_grid, block_size, 0, stream>>>(impl_->group_keys,
        impl_->group_accumulators, 2 * size, nullptr, size, nullptr, nullptr);
    for (int level = int(maximum_storage_level); level >= 0; --level)
        regrid_cells<<<(size + block_size - 1) / block_size, block_size, 0, stream>>>(
            impl_->keys, impl_->cells, size, impl_->voxel_size, voxel_size, unsigned(level),
            impl_->group_keys, impl_->group_accumulators, 2 * size);
    auto result = cudaMemsetAsync(impl_->keys, 0, size * sizeof(Key), stream);
    if (result != cudaSuccess) return result;
    result = cudaMemsetAsync(impl_->cells, 0, size * sizeof(Cell), stream);
    if (result != cudaSuccess) return result;
    materialise_groups<<<table_grid, block_size, 0, stream>>>(impl_->group_keys,
        impl_->group_accumulators, impl_->keys, impl_->cells, size);
    result = cudaMemsetAsync(impl_->tsdf_keys, 0, impl_->tsdf_capacity * sizeof(Key), stream);
    if (result != cudaSuccess) return result;
    result = cudaMemsetAsync(impl_->tsdf_cells, 0, impl_->tsdf_capacity * sizeof(TsdfCell), stream);
    if (result != cudaSuccess) return result;
    impl_->voxel_size = impl_->configuration.voxel_size = voxel_size;
    return impl_->compact(nullptr, 0, impl_->configuration, {}, stream, false, true);
}
cudaError_t StereoVoxelVolume::set_max_points(size_t maximum_points, cudaStream_t stream) {
    if (!stream || !maximum_points || maximum_points > capacity()) return cudaErrorInvalidValue;
    if (!impl_->initialised) {
        const auto result = clear(stream);
        if (result != cudaSuccess) return result;
    }
    impl_->maximum_points = unsigned(maximum_points);
    return impl_->compact(nullptr, 0, impl_->configuration, {}, stream, false, true);
}
size_t StereoVoxelVolume::max_points() const { return impl_->maximum_points; }
cudaError_t StereoVoxelVolume::statistics(VoxelStatistics* output, cudaStream_t stream) {
    if (!output || !stream) return cudaErrorInvalidValue;
    if (!impl_->initialised) {
        const auto result = clear(stream);
        if (result != cudaSuccess) return result;
    }
    initialise_statistics<<<1, 1, 0, stream>>>(output);
    count_statistics<<<(impl_->tsdf_capacity + block_size - 1) / block_size, block_size, 0, stream>>>(
        impl_->keys, impl_->cells, impl_->capacity, impl_->tsdf_keys, impl_->tsdf_cells,
        impl_->tsdf_capacity, impl_->voxel_size, output);
    finish_statistics<<<1, 1, 0, stream>>>(output);
    return cudaGetLastError();
}
cudaError_t StereoVoxelVolume::query_tsdf(const StereoPoint* points, size_t count,
                                         VoxelTsdfSample* output, cudaStream_t stream) {
    if (!stream || (count && (!points || !output)) || count > stereo_voxel_max_samples)
        return cudaErrorInvalidValue;
    if (!count) return cudaSuccess;
    if (!impl_->initialised) {
        const auto result = clear(stream);
        if (result != cudaSuccess) return result;
    }
    read_tsdf<<<(unsigned(count) + block_size - 1) / block_size, block_size, 0, stream>>>(
        impl_->tsdf_keys, impl_->tsdf_cells, impl_->tsdf_capacity, impl_->voxel_size,
        points, unsigned(count), output);
    return cudaGetLastError();
}
} // namespace ceres
