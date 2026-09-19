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
constexpr unsigned priority_bins = 64;
constexpr unsigned candidate_flag = 0x80000000u;
constexpr unsigned maximum_storage_level = 6;
struct Cell {
    float r, g, b, last_seen, confidence;
    unsigned weight;
    float contradiction_gap;
    unsigned contradictions;
};
struct Accumulator { unsigned r, g, b, count; };
struct GroupAccumulator { unsigned r, g, b, confidence, count, latest, weight; };
struct Pressure {
    unsigned occupied, histogram[priority_bins], threshold, quota, ticket;
    unsigned coarsen_floor, regroup, group_count;
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
                          const HandMaskSet& hands, Key& key) {
    if (!isfinite(point.valid) || point.valid <= 0 || !isfinite(point.x) || !isfinite(point.y) ||
        !isfinite(point.z) || !isfinite(point.r) || !isfinite(point.g) || !isfinite(point.b))
        return false;
    const float local[3]{point.x, point.y, point.z};
    float world[3];
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
__device__ void accumulate(Accumulator* accumulators, unsigned index, const StereoPoint& point) {
    auto& sum = accumulators[index];
    atomicAdd(&sum.r, quantise_colour(point.r));
    atomicAdd(&sum.g, quantise_colour(point.g));
    atomicAdd(&sum.b, quantise_colour(point.b));
    atomicAdd(&sum.count, 1u);
}
__device__ bool pressured(const Pressure* pressure, unsigned capacity) {
    return (pressure->occupied & candidate_flag) &&
           (pressure->occupied & ~candidate_flag) > capacity * 3 / 4;
}
__global__ void count_candidates(const StereoPoint* points, unsigned count,
                                 VoxelGpuConfig config, HandMaskSet hands, Pressure* pressure) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    Key key;
    const bool candidate = index < count && point_key(points[index], config, hands, key);
    if (__any_sync(__activemask(), candidate) && !(threadIdx.x & 31u))
        atomicOr(&pressure->occupied, candidate_flag);
}
__device__ bool measured_depth(const ProjectiveDepthObservation& observation,
                               const float* view, float& depth) {
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
    if (pressure && index < priority_bins)
        const_cast<Pressure*>(pressure)->histogram[index] = 0;
    if (pressure && !index)
        const_cast<Pressure*>(pressure)->group_count = 0;
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
        auto& sum = sums[index];
        atomicAdd(&sum.r, quantise_colour(cell.r));
        atomicAdd(&sum.g, quantise_colour(cell.g));
        atomicAdd(&sum.b, quantise_colour(cell.b));
        atomicAdd(&sum.confidence, quantise_colour(cell.confidence));
        atomicAdd(&sum.count, 1u);
        atomicMax(&sum.latest, __float_as_uint(cell.last_seen));
        atomicMax(&sum.weight, cell.weight);
        return;
    }
}
__device__ Cell group_cell(const GroupAccumulator& sum) {
    const float inverse = 1.f / (float(sum.count) * colour_scale);
    return {sum.r * inverse, sum.g * inverse, sum.b * inverse,
            __uint_as_float(sum.latest), sum.confidence * inverse, sum.weight};
}
__device__ unsigned priority(Key key, const Cell& cell, const VoxelGpuConfig& config) {
    float centre[3];
    key_centre(key, config.voxel_size, centre);
    float squared_distance = 0;
    for (unsigned axis = 0; axis < 3; ++axis) {
        const float delta = centre[axis] - config.head_to_world[12 + axis];
        squared_distance += delta * delta;
    }
    const float proximity = 1.f - fminf(1.f, sqrtf(squared_distance) / 16.f);
    return min(priority_bins - 1,
               unsigned(24.f * cell.confidence + 7.f * proximity + 2 * min(cell.weight, 16u)));
}
__global__ void begin_pressure(Pressure* pressure, unsigned capacity) {
    pressure->regroup = pressured(pressure, capacity) ? 1u : 0u;
}
__global__ void count_priorities(const Key* keys, const GroupAccumulator* sums,
                                 unsigned capacity, Pressure* pressure, VoxelGpuConfig config) {
    if (!pressured(pressure, capacity) || !pressure->regroup)
        return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < 2 * capacity && sums[index].count) {
        atomicAdd(&pressure->group_count, 1u);
        atomicAdd(&pressure->histogram[priority(keys[index], group_cell(sums[index]), config)], 1u);
    }
}
__global__ void choose_priority(Pressure* pressure, unsigned capacity) {
    if (!pressured(pressure, capacity) || !pressure->regroup)
        return;
    unsigned remaining = capacity - max(1u, capacity / 8);
    // Exhaust useful spatial coarsening before considering evidence eviction.
    // All passes reuse the same fixed scratch table and original retained map.
    if (pressure->group_count > remaining && pressure->coarsen_floor < maximum_storage_level) {
        ++pressure->coarsen_floor;
        return;
    }
    pressure->regroup = 0;
    pressure->threshold = 0;
    pressure->quota = remaining;
    for (int bin = priority_bins - 1; bin >= 0; --bin) {
        if (pressure->histogram[bin] > remaining) {
            pressure->threshold = unsigned(bin);
            pressure->quota = remaining;
            break;
        }
        remaining -= pressure->histogram[bin];
    }
}
__global__ void clear_under_pressure(Key* keys, Cell* cells, unsigned capacity,
                                     const Pressure* pressure) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < capacity && pressured(pressure, capacity)) { keys[index] = empty_key; cells[index] = {}; }
}
__global__ void retain_groups(const Key* source_keys, const GroupAccumulator* sums,
                              Key* keys, Cell* cells, unsigned capacity, Pressure* pressure,
                              VoxelGpuConfig config) {
    if (!pressured(pressure, capacity))
        return;
    const unsigned source = blockIdx.x * blockDim.x + threadIdx.x;
    if (source >= 2 * capacity || !sums[source].count)
        return;
    const Key key = source_keys[source];
    const Cell cell = group_cell(sums[source]);
    const unsigned score = priority(key, cell, config);
    if (score < pressure->threshold ||
        (score == pressure->threshold && atomicAdd(&pressure->ticket, 1u) >= pressure->quota))
        return;
    const unsigned mask = capacity - 1, hash = hash_key(key), start = hash & mask;
    const unsigned stride = ((hash >> 16) | 1u);
    // Odd-stride probing spans the whole power-of-two table instead of dropping
    // a new region when one contiguous hash window fills. Work remains bounded.
    for (unsigned probe = 0; probe < min(capacity, 128u); ++probe) {
        const unsigned index = (start + probe * stride) & mask;
        if (atomicCAS(keys + index, empty_key, key) == empty_key) { cells[index] = cell; return; }
    }
}
__device__ unsigned find_key(Key key, const Key* keys, unsigned capacity) {
    const unsigned mask = capacity - 1, hash = hash_key(key), start = hash & mask;
    const unsigned stride = ((hash >> 16) | 1u);
    for (unsigned probe = 0; probe < min(capacity, 128u); ++probe) {
        const unsigned index = (start + probe * stride) & mask;
        const Key found = atomicAdd(const_cast<Key*>(keys) + index, Key(0));
        if (found == key)
            return index;
        if (found == empty_key)
            break;
    }
    return capacity;
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
                                ProjectiveDepthObservation observation) {
    if (!observation.points)
        return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    Key fine_key;
    if (index >= count || !point_key(points[index], config, observation.hands, fine_key))
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
                           HandMaskSet hands) {
    const unsigned point_index = blockIdx.x * blockDim.x + threadIdx.x;
    if (point_index >= count)
        return;
    const StereoPoint point = points[point_index];
    Key key;
    if (!point_key(point, config, hands, key))
        return;
    unsigned index = find_key(key, keys, capacity);
    if (index < capacity) { accumulate(accumulators, index, point); return; }
    unsigned axes[3];
    key_axes(key, axes);
    for (unsigned level = 1; level <= maximum_storage_level; ++level) {
        index = find_key(coordinate_key(axes[0], axes[1], axes[2], level), keys, capacity);
        if (index < capacity) { accumulate(accumulators, index, point); return; }
    }
    const unsigned mask = capacity - 1, hash = hash_key(key), start = hash & mask;
    const unsigned stride = ((hash >> 16) | 1u);
    for (unsigned probe = 0; probe < min(capacity, 128u); ++probe) {
        index = (start + probe * stride) & mask;
        Key found = atomicAdd(keys + index, Key(0));
        if (found == empty_key || found == tombstone_key) {
            const Key previous = atomicCAS(keys + index, found, key);
            found = previous == found ? key : previous;
        }
        if (found == key) { accumulate(accumulators, index, point); return; }
    }
}
__global__ void merge_cells(Cell* cells, const Accumulator* sums, unsigned capacity,
                            VoxelGpuConfig config) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= capacity || !sums[index].count)
        return;
    const Accumulator sum = sums[index];
    Cell& cell = cells[index];
    const unsigned previous_weight = min(cell.weight, maximum_weight - 1);
    const float inverse_count = 1.f / (float(sum.count) * colour_scale);
    const float inverse_weight = 1.f / float(previous_weight + 1);
    cell.r = (cell.r * previous_weight + sum.r * inverse_count) * inverse_weight;
    cell.g = (cell.g * previous_weight + sum.g * inverse_count) * inverse_weight;
    cell.b = (cell.b * previous_weight + sum.b * inverse_count) * inverse_weight;
    cell.confidence = cell.weight ? fminf(1.f, cell.confidence + config.support_increment) : 1.f;
    cell.weight = previous_weight + 1;
    cell.last_seen = config.sample_time_seconds;
    cell.contradiction_gap = 0;
    cell.contradictions = 0;
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
    unsigned capacity;
    Key* keys = nullptr;
    Cell* cells = nullptr;
    Accumulator* accumulators = nullptr;
    Key* group_keys = nullptr;
    GroupAccumulator* group_accumulators = nullptr;
    unsigned* output_count = nullptr;
    Pressure* pressure = nullptr;
    bool initialised = false, configured = false, observed = false;
    float voxel_size = .03f, now = 0, sample_time = 0;
    explicit Impl(unsigned size) : capacity(size) {}
    ~Impl() {
        cudaFree(keys); cudaFree(cells); cudaFree(accumulators);
        cudaFree(group_keys); cudaFree(group_accumulators); cudaFree(output_count); cudaFree(pressure);
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
}
StereoVoxelVolume::~StereoVoxelVolume() = default;
size_t StereoVoxelVolume::capacity() const { return impl_->capacity; }
size_t StereoVoxelVolume::scratch_bytes() const {
    return capacity() * (sizeof(Key) + sizeof(Cell) + sizeof(Accumulator) +
                        2 * (sizeof(Key) + sizeof(GroupAccumulator))) +
           sizeof(unsigned) + sizeof(Pressure);
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
    impl_->now = config.now_seconds;
    impl_->configured = true;
    if (!count || (impl_->observed && config.sample_time_seconds <= impl_->sample_time))
        return cudaSuccess;
    const unsigned size = impl_->capacity, grid = (size + block_size - 1) / block_size;
    const unsigned table_grid = (2 * size + block_size - 1) / block_size;
    revise_evidence<<<grid, block_size, 0, stream>>>(impl_->keys, impl_->cells, size, config, observation);
    auto result = cudaGetLastError();
    if (result != cudaSuccess)
        return result;
    result = cudaMemsetAsync(impl_->pressure, 0, sizeof(Pressure), stream);
    if (result != cudaSuccess)
        return result;
    count_candidates<<<(unsigned(count) + block_size - 1) / block_size, block_size, 0, stream>>>(
        input, unsigned(count), config, observation.hands, impl_->pressure);
    prepare<<<grid, block_size, 0, stream>>>(impl_->keys, impl_->accumulators, size, impl_->pressure);
    mark_refinement<<<(unsigned(count) + block_size - 1) / block_size, block_size, 0, stream>>>(
        input, unsigned(count), impl_->keys, impl_->accumulators, size, config, observation);
    refine_cells<<<grid, block_size, 0, stream>>>(impl_->keys, impl_->cells, impl_->accumulators,
                                               size, impl_->pressure);
    begin_pressure<<<1, 1, 0, stream>>>(impl_->pressure, size);
    VoxelLodConfig storage;
    for (unsigned axis = 0; axis < 3; ++axis)
        storage.view_position[axis] = config.head_to_world[12 + axis];
    storage.focal_length_pixels = 1.f;
    storage.target_pixels = config.voxel_size * (4.f / 3.f);
    storage.minimum_distance = 1.5f;
    storage.max_level = 3;
    for (unsigned attempt = 0; attempt <= maximum_storage_level; ++attempt) {
        prepare_groups<<<table_grid, block_size, 0, stream>>>(impl_->group_keys, impl_->group_accumulators,
            2 * size, nullptr, size, nullptr, impl_->pressure);
        group_cells<<<grid, block_size, 0, stream>>>(impl_->keys, impl_->cells, size,
            impl_->group_keys, impl_->group_accumulators, 2 * size, config.voxel_size, storage, impl_->pressure);
        count_priorities<<<table_grid, block_size, 0, stream>>>(impl_->group_keys,
            impl_->group_accumulators, size, impl_->pressure, config);
        choose_priority<<<1, 1, 0, stream>>>(impl_->pressure, size);
    }
    clear_under_pressure<<<grid, block_size, 0, stream>>>(impl_->keys, impl_->cells, size, impl_->pressure);
    retain_groups<<<table_grid, block_size, 0, stream>>>(impl_->group_keys, impl_->group_accumulators,
        impl_->keys, impl_->cells, size, impl_->pressure, config);
    add_points<<<(unsigned(count) + block_size - 1) / block_size, block_size, 0, stream>>>(
        input, unsigned(count), impl_->keys, impl_->accumulators, size, config, observation.hands);
    merge_cells<<<grid, block_size, 0, stream>>>(impl_->cells, impl_->accumulators, size, config);
    result = cudaGetLastError();
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
} // namespace ceres
