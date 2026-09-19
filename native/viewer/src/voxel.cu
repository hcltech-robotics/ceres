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
    float precision, quality, variance, first_observed, evidence;
};
struct Accumulator {
    unsigned r, g, b, count, colour_count;
    float x, y, z, quality;
};
struct GroupAccumulator {
    double r, g, b, confidence, support, colour_count;
    unsigned count, latest, weight, latest_evidence, independent_support, earliest_birth, immediate_birth;
    double x, y, z;
    Accumulator incoming;
};
struct GroupDecision {
    unsigned children, protected_group, merge;
};
struct Pressure {
    unsigned occupied;
    unsigned coarsen_floor, regroup, group_count;
    unsigned budget;
    unsigned refinement_claims;
};
struct Admission {
    unsigned active, retry, floor, group_count, overflow, occupied, tier;
};
struct TsdfCell {
    float distance, weight, last_seen;
    float r, g, b, colour_weight;
    float quality, variance;
};
struct MapTransform {
    float matrix[16];
    float maximum_scale;
};
static_assert(stereo_voxel_max_samples <= 0xffffffffu / colour_scale);

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
    atomicAdd(&sum.quality, isfinite(point.a) ? fminf(1.f, fmaxf(.05f, point.a)) : .05f);
    atomicAdd(&sum.count, 1u);
}
__device__ bool pressured(const Pressure* pressure, unsigned capacity) {
    return (pressure->occupied & candidate_flag) &&
           (pressure->occupied & ~candidate_flag) > min(capacity, pressure->budget);
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
                               const float* view, float& depth, StereoPoint* sample = nullptr,
                               float* quality = nullptr) {
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
    if (!(isfinite(point.valid) && point.valid > 0 && isfinite(depth) && depth > 0)) return false;
    if (quality) {
        // These bounded reliability weights express relative measurement quality,
        // rather than a calibrated probability. Range and off-axis rays carry
        // less evidence than nearby central measurements.
        const float radial = (2.f * u - 1.f) * (2.f * u - 1.f) +
                             (2.f * v - 1.f) * (2.f * v - 1.f);
        float value = expf(-.5f * radial) * fminf(1.f, 4.f / (depth * depth));
        const int px = int(du * observation.width), py = int(dv * observation.height);
        for (unsigned neighbour = 0; neighbour < 4; ++neighbour) {
            const int nx = px + (neighbour == 0 ? -1 : neighbour == 1 ? 1 : 0);
            const int ny = py + (neighbour == 2 ? -1 : neighbour == 3 ? 1 : 0);
            if (nx < 0 || ny < 0 || nx >= int(observation.width) || ny >= int(observation.height)) continue;
            const auto adjacent = observation.points[ny * observation.width + nx];
            if (!(adjacent.valid > 0)) { value *= .85f; continue; }
            const float adjacent_input[3]{adjacent.x, adjacent.y, adjacent.z};
            float adjacent_view[3];
            transform(observation.view_from_input, adjacent_input, adjacent_view);
            if (!isfinite(adjacent_view[2]) || fabsf(depth + adjacent_view[2]) > fmaxf(.06f, depth * .03f))
                value *= .5f;
        }
        *quality = fmaxf(.05f, value);
    }
    return true;
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
        const bool established = cell.support >= 4 && cell.confidence >= .6f;
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
        const float support = established ? sqrtf(float(min(cell.support, 64u))) : 1.f;
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
    if (pressure && !pressure->regroup)
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
    const double support = double(max(1u, cell.support)) * fmaxf(.05f, cell.confidence);
    if (cell.colour_weight) {
        atomicAdd(&sum.r, double(cell.r) * support);
        atomicAdd(&sum.g, double(cell.g) * support);
        atomicAdd(&sum.b, double(cell.b) * support);
        atomicAdd(&sum.colour_count, support);
    }
    atomicAdd(&sum.x, double(cell.x) * support);
    atomicAdd(&sum.y, double(cell.y) * support);
    atomicAdd(&sum.z, double(cell.z) * support);
    atomicAdd(&sum.confidence, double(cell.confidence) * support);
    atomicAdd(&sum.support, support);
    atomicAdd(&sum.count, 1u);
    atomicMax(&sum.latest, __float_as_uint(cell.last_observed));
    atomicMax(&sum.latest_evidence, __float_as_uint(cell.last_seen));
    atomicMax(&sum.weight, cell.weight);
    atomicMax(&sum.independent_support, cell.support);
    if (cell.first_observed < 0) atomicOr(&sum.immediate_birth, 1u);
    else atomicMax(&sum.earliest_birth, ~__float_as_uint(cell.first_observed));
}
__device__ Cell group_cell(const GroupAccumulator& sum) {
    Cell result{};
    if (!sum.support) return result;
    const double inverse = 1. / sum.support;
    const double colour_inverse = sum.colour_count ? 1. / sum.colour_count : 0;
    result.r = sum.r * colour_inverse;
    result.g = sum.g * colour_inverse;
    result.b = sum.b * colour_inverse;
    result.last_seen = __uint_as_float(sum.latest_evidence);
    result.last_observed = __uint_as_float(sum.latest);
    result.confidence = sum.confidence * inverse;
    result.weight = sum.weight;
    result.support = sum.independent_support;
    result.x = float(sum.x / sum.support);
    result.y = float(sum.y / sum.support);
    result.z = float(sum.z / sum.support);
    result.colour_weight = sum.colour_count ? sum.weight : 0;
    result.precision = fminf(64.f, result.support * fmaxf(.05f, result.confidence));
    result.evidence = fminf(64.f, -4.f * logf(fmaxf(1e-7f, 1.f - result.confidence)));
    result.quality = fminf(1.f, fmaxf(.05f, result.evidence / max(1u, result.support)));
    result.first_observed = sum.immediate_birth ? -1.f : __uint_as_float(~sum.earliest_birth);
    return result;
}
__global__ void begin_pressure(Pressure* pressure, unsigned capacity) {
    pressure->regroup = pressured(pressure, capacity) ? 1u : 0u;
}
__global__ void clear_under_pressure(Key* keys, Cell* cells, unsigned capacity,
                                     const Pressure* pressure) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < capacity && pressure->regroup) { keys[index] = empty_key; cells[index] = {}; }
}
__global__ void retain_groups(const Key* source_keys, const GroupAccumulator* sums,
                              Key* keys, Cell* cells, unsigned capacity, Pressure* pressure) {
    if (!pressure->regroup)
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
__device__ unsigned decision_slot(Key key, Key* keys, unsigned capacity) {
    const unsigned start = hash_key(key) & (capacity - 1);
    for (unsigned probe = 0; probe < capacity; ++probe) {
        const unsigned index = (start + probe) & (capacity - 1);
        const Key previous = atomicCAS(keys + index, empty_key, key);
        if (previous == empty_key || previous == key) return index;
    }
    return capacity;
}
__device__ unsigned find_decision(Key key, const Key* keys, unsigned capacity) {
    const unsigned start = hash_key(key) & (capacity - 1);
    for (unsigned probe = 0; probe < capacity; ++probe) {
        const unsigned index = (start + probe) & (capacity - 1);
        if (keys[index] == key) return index;
        if (keys[index] == empty_key) break;
    }
    return capacity;
}
__device__ Key parent_key(Key key, unsigned level) {
    if (key_level(key) >= level) return key;
    unsigned axes[3];
    key_axes(key, axes);
    return coordinate_key(axes[0], axes[1], axes[2], level);
}
__global__ void initialise_selection(const Key* keys, Key* selected, unsigned capacity,
                                     const Pressure* pressure) {
    if (pressure && !pressure->regroup) return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < capacity) selected[index] = keys[index];
}
__global__ void prepare_decisions(Key* keys, GroupDecision* decisions, unsigned capacity,
                                  const Pressure* pressure = nullptr, unsigned source_capacity = 0) {
    if (pressure && !pressured(pressure, source_capacity)) return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < capacity) { keys[index] = empty_key; decisions[index] = {}; }
}
__device__ unsigned evidence_level(const Cell& cell) {
    if (cell.confidence >= .85f && cell.support >= 4) return 0;
    if (cell.confidence >= .6f && cell.support >= 3) return 1;
    if (cell.confidence >= .18f) return 2;
    return 3;
}
__global__ void gather_decisions(const Key* source, const Cell* cells, const Key* selected,
                                 unsigned capacity, Key* keys, GroupDecision* decisions,
                                 unsigned level, float threshold, float voxel_size,
                                 VoxelLodConfig lod, const Pressure* pressure) {
    if (pressure && !pressured(pressure, capacity)) return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= capacity || !occupied(source[index]) || !cells[index].weight ||
        key_level(selected[index]) >= level) return;
    const Key parent = parent_key(selected[index], level);
    const unsigned target = decision_slot(parent, keys, 2 * capacity);
    if (target == 2 * capacity) return;
    unsigned axes[3]; key_axes(selected[index], axes);
    const unsigned half = 1u << (level - 1);
    const unsigned child = ((axes[0] & half) ? 1u : 0u) |
                           ((axes[1] & half) ? 2u : 0u) |
                           ((axes[2] & half) ? 4u : 0u);
    atomicOr(&decisions[target].children, 1u << child);
    bool protect = cells[index].confidence > threshold;
    if (!pressure) {
        unsigned desired = key_level(lod_key(source[index], voxel_size, lod));
        if (lod.confidence_adaptive) desired = max(desired, min(lod.max_level, evidence_level(cells[index])));
        protect = desired < level;
    }
    if (protect) atomicOr(&decisions[target].protected_group, 1u);
}
__global__ void choose_decisions(GroupDecision* decisions, unsigned capacity, Pressure* pressure) {
    if (pressure && !pressured(pressure, capacity)) return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= 2 * capacity) return;
    auto& group = decisions[index];
    if (!group.children || group.protected_group) return;
    if (!pressure) { group.merge = 1; return; }
    const unsigned children = __popc(group.children);
    if (children < 2) return;
    unsigned previous = atomicAdd(&pressure->occupied, 0u);
    while ((previous & ~candidate_flag) > pressure->budget) {
        const unsigned updated = previous - (children - 1);
        const unsigned found = atomicCAS(&pressure->occupied, previous, updated);
        if (found == previous) { group.merge = 1; return; }
        previous = found;
    }
}
__global__ void apply_decisions(const Key* source, Key* selected, unsigned capacity,
                                const Key* keys, const GroupDecision* decisions,
                                unsigned level, const Pressure* pressure) {
    // A pass may have reached the budget. Its accepted merges must still commit.
    if (pressure && !pressure->regroup) return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= capacity || !occupied(source[index]) || key_level(selected[index]) >= level) return;
    const Key parent = parent_key(selected[index], level);
    const unsigned group = find_decision(parent, keys, 2 * capacity);
    if (group < 2 * capacity && decisions[group].merge) selected[index] = parent;
}
__global__ void group_selected(const Key* source, const Cell* cells, const Key* selected,
                               unsigned capacity, Key* keys, GroupAccumulator* sums,
                               const Pressure* pressure) {
    if (pressure && !pressure->regroup) return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= capacity || !occupied(source[index]) || !cells[index].weight) return;
    const unsigned group = decision_slot(selected[index], keys, 2 * capacity);
    if (group < 2 * capacity) accumulate_cell(sums[group], cells[index]);
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
    float depth = 0, quality = 1;
    StereoPoint sample{};
    if (!measured_depth(observation, view, depth, &sample, &quality)) return;
    const float truncation = config.truncation_voxels * config.voxel_size;
    const float signed_distance = depth + view[2];
    // A point farther behind the observed surface is occluded, not free space.
    if (signed_distance < -truncation) return;
    auto& cell = cells[index];
    const float measurement = fminf(truncation, signed_distance);
    const float residual = cell.weight > 0 ? measurement - cell.distance : 0.f;
    const float tolerance = fmaxf(config.surface_tolerance, config.voxel_size);
    const float consistency = 1.f / (1.f + residual * residual / (tolerance * tolerance));
    const float vote = quality * consistency;
    const float weight = fminf(cell.weight, float(maximum_weight) - vote);
    const float inverse = 1.f / (weight + vote);
    cell.distance = (cell.distance * weight + measurement * vote) * inverse;
    cell.quality = (cell.quality * weight + quality * vote) * inverse;
    cell.variance = (cell.variance * weight + residual * residual * vote) * inverse;
    cell.weight = weight + vote;
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
    point.valid = 1;
    const float tolerance = fmaxf(config.surface_tolerance, config.voxel_size);
    point.a = fmaxf(.05f, cell.quality / (1.f + cell.variance / (tolerance * tolerance)));
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
        atomicAdd(&sums[cell].colour_count, 1u);
        return;
    }
}
__global__ void prepare_refinement(const Key* keys, Key* previous_keys, SpatialMapPoint* previous,
                                   unsigned capacity) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < capacity) { previous_keys[index] = keys[index]; previous[index] = {}; }
}
__global__ void refine_cells(Key* keys, Cell* cells, Accumulator* sums, unsigned capacity,
                             Pressure* pressure, SpatialMapPoint* previous, float voxel_size) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= capacity)
        return;
    const unsigned coverage = sums[index].count;
    unsigned covered_axes = 0;
    for (unsigned axis = 0; axis < 3; ++axis)
        covered_axes += ((coverage >> (2 * axis)) & 3u) == 3u;
    bool room = false;
    if (covered_axes >= 2 && __popc(coverage >> 6) >= 4 &&
        cells[index].support >= 3 && cells[index].confidence >= .3f) {
        unsigned claimed = atomicAdd(&pressure->refinement_claims, 0u);
        const unsigned candidates = sums[index].colour_count;
        while ((atomicAdd(&pressure->occupied, 0u) & ~candidate_flag) + claimed + candidates - 1 <=
               min(capacity, pressure->budget)) {
            const unsigned found = atomicCAS(&pressure->refinement_claims, claimed, claimed + candidates);
            if (found == claimed) { room = true; break; }
            claimed = found;
        }
    }
    if (room) {
        const auto& cell = cells[index];
        previous[index] = {cell.x, cell.y, cell.z, voxel_size * (1u << key_level(keys[index])),
            cell.r, cell.g, cell.b, cell.confidence,
            cell.first_observed < 0 ? -1 : int64_t(double(cell.first_observed) * 1000000.),
            cell.support, cell.colour_weight ? spatial_map_intrinsic_rgb : 0u};
        keys[index] = tombstone_key;
        cells[index] = {};
        atomicSub(&pressure->occupied, 1u);
    }
    sums[index] = {};
}
__device__ Cell refinement_evidence(Key key, const Key* previous_keys, const SpatialMapPoint* previous,
                                    unsigned capacity) {
    Cell result{};
    for (unsigned level = key_level(key) + 1; level <= maximum_storage_level; ++level) {
        const unsigned index = find_key(parent_key(key, level), previous_keys, capacity);
        if (index == capacity || !previous[index].weight) continue;
        const auto& point = previous[index];
        result.support = point.weight;
        result.weight = min(point.weight, maximum_weight - 1);
        result.confidence = point.confidence;
        result.first_observed = point.observed_us < 0 ? -1.f : float(double(point.observed_us) / 1000000.);
        // Coarse evidence supports the region, while each child's position must
        // come from the new measured sample rather than the old parent centroid.
        result.quality = fminf(.65f, point.confidence);
        result.evidence = fminf(4.f, -4.f * logf(fmaxf(1e-7f, 1.f - point.confidence)));
        if (point.flags & spatial_map_intrinsic_rgb) {
            result.r = point.r; result.g = point.g; result.b = point.b;
            result.colour_weight = result.weight;
        }
        return result;
    }
    return result;
}
__global__ void seed_refinement(const Key* keys, Cell* cells, const Accumulator* sums, unsigned capacity,
                                const Key* previous_keys, const SpatialMapPoint* previous,
                                const Admission* admission) {
    if (admission->active) return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < capacity && occupied(keys[index]) && !cells[index].weight && sums[index].count)
        cells[index] = refinement_evidence(keys[index], previous_keys, previous, capacity);
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
                if (atomicAdd(&admission->occupied, 1u) >= capacity) {
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
    if (!cell.weight) cell.first_observed = config.sample_time_seconds;
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
    const float x = sum.x / sum.count, y = sum.y / sum.count, z = sum.z / sum.count;
    const float dx = x - cell.x, dy = y - cell.y, dz = z - cell.z;
    const float residual = cell.precision > 0 ? dx * dx + dy * dy + dz * dz : 0;
    const float tolerance = fmaxf(config.surface_tolerance, config.voxel_size * .75f);
    const float quality = fminf(1.f, fmaxf(.05f, sum.quality / sum.count));
    const float vote = quality / (1.f + residual / (tolerance * tolerance));
    const float precision = fminf(cell.precision, 64.f - vote);
    const float inverse_precision = 1.f / (precision + vote);
    cell.x = (cell.x * precision + x * vote) * inverse_precision;
    cell.y = (cell.y * precision + y * vote) * inverse_precision;
    cell.z = (cell.z * precision + z * vote) * inverse_precision;
    cell.precision = precision + vote;
    cell.quality = (cell.quality * previous_weight + quality) * inverse_weight;
    cell.variance = (cell.variance * previous_weight + residual) * inverse_weight;
    cell.weight = previous_weight + 1;
    cell.support = cell.support == 0xffffffffu ? cell.support : cell.support + 1;
    // Quality controls the rate at which independent captures earn certainty.
    // Consistent peripheral or distant observations can therefore become precise
    // after enough sweeps, while positional disagreement still limits confidence.
    cell.evidence = fminf(64.f, cell.evidence + quality);
    const float confidence = (1.f - expf(-cell.evidence / 4.f)) /
                             (1.f + cell.variance / (tolerance * tolerance));
    cell.confidence = confidence >= .985f ? 1.f : fmaxf(.01f, confidence);
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
__device__ float admission_threshold(const Admission& admission) {
    return admission.tier == 0 ? .35f : admission.tier == 1 ? .6f : admission.tier == 2 ? .85f : 1.f;
}
__global__ void prepare_admission_decisions(Key* keys, GroupDecision* decisions, unsigned capacity,
                                           const Admission* admission) {
    if (!admission->retry) return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < capacity) { keys[index] = empty_key; decisions[index] = {}; }
}
__global__ void protect_admission_cells(const Key* source, const Cell* cells, unsigned capacity,
                                        Key* keys, GroupDecision* decisions, const Admission* admission) {
    if (!admission->retry || !admission->floor) return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= capacity || !occupied(source[index]) || !cells[index].weight ||
        key_level(source[index]) >= admission->floor ||
        cells[index].confidence <= admission_threshold(*admission)) return;
    const unsigned group = decision_slot(parent_key(source[index], admission->floor), keys, 2 * capacity);
    if (group < 2 * capacity) atomicOr(&decisions[group].protected_group, 1u);
}
__device__ Key protected_admission_key(Key key, unsigned capacity, const Key* protection_keys,
                                       const GroupDecision* decisions, const Admission& admission) {
    if (key_level(key) >= admission.floor) return key;
    const Key parent = parent_key(key, admission.floor);
    const unsigned group = find_decision(parent, protection_keys, 2 * capacity);
    return group < 2 * capacity && decisions[group].protected_group ? key : parent;
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
                                      Key* keys, GroupAccumulator* sums, const Key* protection_keys,
                                      const GroupDecision* decisions, Admission* admission) {
    if (!admission->retry) return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= capacity || !occupied(source[index]) || !cells[index].weight) return;
    const Key key = protected_admission_key(source[index], capacity, protection_keys, decisions, *admission);
    const unsigned target = admission_slot(key, keys, 2 * capacity, admission);
    if (target < 2 * capacity) accumulate_cell(sums[target], cells[index]);
}
__global__ void group_admission_points(const StereoPoint* points, unsigned count,
                                       unsigned capacity, Key* keys, GroupAccumulator* sums, VoxelGpuConfig config,
                                       HandMaskSet hands, bool world_input, const Key* protection_keys,
                                       const GroupDecision* decisions, Admission* admission) {
    if (!admission->retry || admission->overflow) return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    Key key;
    if (index >= count || !point_key(points[index], config, hands, key, world_input)) return;
    unsigned axes[3];
    key_axes(key, axes);
    // Original retained groups were inserted by the preceding kernel. Resolve
    // their ancestors in this at-most-half-full table, where provisional writes
    // from the failed first attempt cannot force full-table negative lookups.
    for (unsigned level = 1; level <= maximum_storage_level; ++level) {
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
    key = protected_admission_key(key, capacity, protection_keys, decisions, *admission);
    const unsigned target = admission_slot(key, keys, 2 * capacity, admission);
    if (target < 2 * capacity) accumulate(&sums[target].incoming, 0, points[index], config, world_input);
}
__global__ void choose_admission(Admission* admission, unsigned budget) {
    if (!admission->retry) return;
    if (admission->overflow || admission->group_count > budget) {
        if (admission->floor < maximum_storage_level) ++admission->floor;
        else { admission->floor = 1; ++admission->tier; }
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
                                 VoxelGpuConfig config, const Key* previous_keys,
                                 const SpatialMapPoint* previous, const Admission* admission) {
    if (!admission->active || admission->retry) return;
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= 2 * capacity || !occupied(source[index])) return;
    const Key key = source[index];
    Cell cell = group_cell(sums[index]);
    if (!cell.weight && sums[index].incoming.count)
        cell = refinement_evidence(key, previous_keys, previous, capacity);
    merge_cell(cell, sums[index].incoming, config);
    const unsigned hash = hash_key(key), stride = (hash >> 16) | 1u;
    for (unsigned probe = 0; probe < capacity; ++probe) {
        const unsigned target = ((hash & (capacity - 1)) + probe * stride) & (capacity - 1);
        if (atomicCAS(keys + target, empty_key, key) == empty_key) { cells[target] = cell; return; }
    }
}
__device__ StereoPoint cell_point(Key key, const Cell& cell, float voxel_size) {
    StereoPoint point{};
    point.x = cell.x; point.y = cell.y; point.z = cell.z;
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
                               float voxel_size, int64_t origin, SpatialMapPoint* output, float* births) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < capacity)
        output[index] = occupied(keys[index]) && cells[index].weight ?
            metadata_point(keys[index], cells[index], voxel_size, origin) : SpatialMapPoint{};
    if (index < capacity && births)
        births[index] = occupied(keys[index]) && cells[index].weight ? cells[index].first_observed : -1.f;
}
__global__ void transform_metadata(SpatialMapPoint* points, unsigned count, MapTransform transform) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= count || !points[index].weight) return;
    auto& point = points[index];
    const float x = point.x, y = point.y, z = point.z;
    const auto* m = transform.matrix;
    point.x = m[0] * x + m[4] * y + m[8] * z + m[12];
    point.y = m[1] * x + m[5] * y + m[9] * z + m[13];
    point.z = m[2] * x + m[6] * y + m[10] * z + m[14];
    point.cell_size *= transform.maximum_scale;
}
__global__ void write_group_metadata(const Key* keys, const GroupAccumulator* sums,
                                     unsigned capacity, float voxel_size, int64_t origin,
                                     SpatialMapPoint* output, unsigned* count, float* births) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < capacity && sums[index].count) {
        const unsigned target = atomicAdd(count, 1u);
        const Cell cell = group_cell(sums[index]);
        output[target] = metadata_point(keys[index], cell, voxel_size, origin);
        if (births) births[target] = cell.first_observed;
    }
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
    cell.first_observed = -1.f;
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
template <class Value>
__global__ void grow_table(const Key* source, const Value* values, unsigned source_capacity,
                           Key* keys, Value* output, unsigned capacity) {
    const unsigned index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= source_capacity || !occupied(source[index]) || !(values[index].weight > 0)) return;
    const Key key = source[index];
    const unsigned hash = hash_key(key), stride = (hash >> 16) | 1u;
    for (unsigned probe = 0; probe < capacity; ++probe) {
        const unsigned target = ((hash & (capacity - 1)) + probe * stride) & (capacity - 1);
        if (atomicCAS(keys + target, empty_key, key) == empty_key) { output[target] = values[index]; return; }
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
bool valid_map_transform(const float* matrix, MapTransform& transform) {
    if (!matrix) return false;
    for (unsigned index = 0; index < 16; ++index) {
        if (!std::isfinite(matrix[index])) return false;
        transform.matrix[index] = matrix[index];
    }
    if (matrix[3] != 0 || matrix[7] != 0 || matrix[11] != 0 || matrix[15] != 1)
        return false;
    double axes[3][3];
    transform.maximum_scale = 0;
    for (unsigned column = 0; column < 3; ++column) {
        double length_squared = 0;
        for (unsigned row = 0; row < 3; ++row)
            length_squared += double(matrix[4 * column + row]) * matrix[4 * column + row];
        const double length = std::sqrt(length_squared);
        if (length <= 1e-6 || !std::isfinite(float(length))) return false;
        transform.maximum_scale = std::max(transform.maximum_scale, float(length));
        for (unsigned row = 0; row < 3; ++row)
            axes[column][row] = matrix[4 * column + row] / length;
    }
    for (unsigned column = 0; column < 3; ++column)
        for (unsigned other = column + 1; other < 3; ++other) {
            double dot = 0;
            for (unsigned row = 0; row < 3; ++row)
                dot += axes[column][row] * axes[other][row];
            if (std::abs(dot) > 1e-4) return false;
        }
    const double determinant =
        axes[0][0] * (axes[1][1] * axes[2][2] - axes[2][1] * axes[1][2]) -
        axes[1][0] * (axes[0][1] * axes[2][2] - axes[2][1] * axes[0][2]) +
        axes[2][0] * (axes[0][1] * axes[1][2] - axes[1][1] * axes[0][2]);
    return determinant > 0;
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
    Key* selected_keys = nullptr;
    Key* refinement_keys = nullptr;
    Key* decision_keys = nullptr;
    GroupDecision* decisions = nullptr;
    unsigned* output_count = nullptr;
    Pressure* pressure = nullptr;
    Admission* admission = nullptr;
    Key* tsdf_keys = nullptr;
    TsdfCell* tsdf_cells = nullptr;
    StereoPoint* surface_points = nullptr;
    SpatialMapPoint* transform_points = nullptr;
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
        cudaFree(selected_keys); cudaFree(refinement_keys); cudaFree(decision_keys); cudaFree(decisions);
        cudaFree(group_keys); cudaFree(group_accumulators); cudaFree(output_count); cudaFree(pressure); cudaFree(admission);
        cudaFree(tsdf_keys); cudaFree(tsdf_cells); cudaFree(surface_points); cudaFree(tsdf_count);
        cudaFree(transform_points);
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
            prepare_refinement<<<grid, block_size, 0, stream>>>(keys, refinement_keys, transform_points, capacity);
            mark_refinement<<<(count + block_size - 1) / block_size, block_size, 0, stream>>>(
                input, count, keys, accumulators, capacity, config, observation, world_input);
            refine_cells<<<grid, block_size, 0, stream>>>(keys, cells, accumulators, capacity, pressure,
                transform_points, config.voxel_size);
        }
        // The preceding accepted observation, restore or budget change already
        // met the point limit. Evidence revision and refinement only remove cells
        // here, so pressure selection is needed after admission, not before it.
        if (refine) return cudaGetLastError();
        begin_pressure<<<1, 1, 0, stream>>>(pressure, capacity);
        initialise_selection<<<grid, block_size, 0, stream>>>(keys, selected_keys, capacity, pressure);
        // Spend the selected point budget first. When it is genuinely exceeded,
        // merge the weakest neighbouring regions before touching reliable detail.
        // Shared parent decisions form a non-overlapping hierarchy cut.
        for (float threshold : {.35f, .6f, .85f, 1.f}) {
            for (unsigned level = 1; level <= maximum_storage_level; ++level) {
                prepare_decisions<<<table_grid, block_size, 0, stream>>>(
                    decision_keys, decisions, 2 * capacity, pressure, capacity);
                gather_decisions<<<grid, block_size, 0, stream>>>(keys, cells, selected_keys,
                    capacity, decision_keys, decisions, level, threshold, config.voxel_size, {}, pressure);
                choose_decisions<<<table_grid, block_size, 0, stream>>>(decisions, capacity, pressure);
                apply_decisions<<<grid, block_size, 0, stream>>>(keys, selected_keys, capacity,
                    decision_keys, decisions, level, pressure);
            }
        }
        prepare_groups<<<table_grid, block_size, 0, stream>>>(group_keys, group_accumulators,
            2 * capacity, nullptr, capacity, nullptr, pressure);
        group_selected<<<grid, block_size, 0, stream>>>(keys, cells, selected_keys,
            capacity, group_keys, group_accumulators, pressure);
        clear_under_pressure<<<grid, block_size, 0, stream>>>(keys, cells, capacity, pressure);
        retain_groups<<<table_grid, block_size, 0, stream>>>(group_keys, group_accumulators,
            keys, cells, capacity, pressure);
        return cudaGetLastError();
    }
    void select_lod(const VoxelLodConfig& lod, cudaStream_t stream) {
        const unsigned grid = (capacity + block_size - 1) / block_size;
        const unsigned table_grid = (2 * capacity + block_size - 1) / block_size;
        initialise_selection<<<grid, block_size, 0, stream>>>(keys, selected_keys, capacity, nullptr);
        for (unsigned level = 1; level <= lod.max_level; ++level) {
            prepare_decisions<<<table_grid, block_size, 0, stream>>>(decision_keys, decisions, 2 * capacity);
            gather_decisions<<<grid, block_size, 0, stream>>>(keys, cells, selected_keys, capacity,
                decision_keys, decisions, level, 1.f, voxel_size, lod, nullptr);
            choose_decisions<<<table_grid, block_size, 0, stream>>>(decisions, capacity, nullptr);
            apply_decisions<<<grid, block_size, 0, stream>>>(keys, selected_keys, capacity,
                decision_keys, decisions, level, nullptr);
        }
    }
};
StereoVoxelVolume::StereoVoxelVolume(size_t capacity) {
    if (!capacity || capacity > stereo_voxel_capacity || (capacity & (capacity - 1)))
        throw std::runtime_error("Voxel capacity must be a power of two from 1 to 8388608");
    impl_ = std::make_unique<Impl>(unsigned(capacity));
    check(cudaMalloc(&impl_->keys, capacity * sizeof(Key)));
    check(cudaMalloc(&impl_->cells, capacity * sizeof(Cell)));
    check(cudaMalloc(&impl_->accumulators, capacity * sizeof(Accumulator)));
    check(cudaMalloc(&impl_->group_keys, 2 * capacity * sizeof(Key)));
    check(cudaMalloc(&impl_->group_accumulators, 2 * capacity * sizeof(GroupAccumulator)));
    check(cudaMalloc(&impl_->selected_keys, capacity * sizeof(Key)));
    check(cudaMalloc(&impl_->refinement_keys, capacity * sizeof(Key)));
    check(cudaMalloc(&impl_->decision_keys, 2 * capacity * sizeof(Key)));
    check(cudaMalloc(&impl_->decisions, 2 * capacity * sizeof(GroupDecision)));
    check(cudaMalloc(&impl_->output_count, sizeof(unsigned)));
    check(cudaMalloc(&impl_->pressure, sizeof(Pressure)));
    check(cudaMalloc(&impl_->admission, sizeof(Admission)));
    check(cudaMalloc(&impl_->tsdf_keys, impl_->tsdf_capacity * sizeof(Key)));
    check(cudaMalloc(&impl_->tsdf_cells, impl_->tsdf_capacity * sizeof(TsdfCell)));
    check(cudaMalloc(&impl_->surface_points, impl_->tsdf_capacity * sizeof(StereoPoint)));
    check(cudaMalloc(&impl_->transform_points, capacity * sizeof(SpatialMapPoint)));
    check(cudaMalloc(&impl_->tsdf_count, sizeof(unsigned)));
}
StereoVoxelVolume::~StereoVoxelVolume() = default;
size_t StereoVoxelVolume::capacity() const { return impl_->capacity; }
size_t StereoVoxelVolume::scratch_bytes() const {
    return capacity() * (sizeof(Key) + sizeof(Cell) + sizeof(Accumulator) + sizeof(SpatialMapPoint) +
                        2 * sizeof(Key) + 2 * (2 * sizeof(Key) + sizeof(GroupAccumulator) + sizeof(GroupDecision))) +
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
    seed_refinement<<<grid, block_size, 0, stream>>>(impl_->keys, impl_->cells, impl_->accumulators,
        size, impl_->refinement_keys, impl_->transform_points, impl_->admission);
    merge_cells<<<grid, block_size, 0, stream>>>(impl_->cells, impl_->accumulators, size, config, impl_->admission);
    begin_admission<<<1, 1, 0, stream>>>(impl_->admission);
    const unsigned table_grid = (2 * size + block_size - 1) / block_size;
    // Retry the entire observation transaction. Failed provisional insertions
    // have no cell weight and cannot masquerade as retained source evidence.
    for (unsigned attempt = 0; attempt <= 4 * maximum_storage_level; ++attempt) {
        prepare_admission<<<table_grid, block_size, 0, stream>>>(impl_->group_keys,
            impl_->group_accumulators, 2 * size, impl_->admission);
        prepare_admission_decisions<<<table_grid, block_size, 0, stream>>>(impl_->decision_keys,
            impl_->decisions, 2 * size, impl_->admission);
        protect_admission_cells<<<grid, block_size, 0, stream>>>(impl_->keys, impl_->cells, size,
            impl_->decision_keys, impl_->decisions, impl_->admission);
        group_admission_cells<<<grid, block_size, 0, stream>>>(impl_->keys, impl_->cells, size,
            impl_->group_keys, impl_->group_accumulators, impl_->decision_keys, impl_->decisions, impl_->admission);
        group_admission_points<<<(unsigned(count) + block_size - 1) / block_size, block_size, 0, stream>>>(
            input, unsigned(count), size, impl_->group_keys,
            impl_->group_accumulators, config, observation.hands, world_input,
            impl_->decision_keys, impl_->decisions, impl_->admission);
        choose_admission<<<1, 1, 0, stream>>>(impl_->admission, impl_->maximum_points);
    }
    clear_for_admission<<<grid, block_size, 0, stream>>>(impl_->keys, impl_->cells, size, impl_->admission);
    commit_admission<<<table_grid, block_size, 0, stream>>>(impl_->group_keys, impl_->group_accumulators,
        impl_->keys, impl_->cells, size, config, impl_->refinement_keys, impl_->transform_points, impl_->admission);
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
    impl_->select_lod(config, stream);
    prepare_groups<<<table_grid, block_size, 0, stream>>>(impl_->group_keys,
        impl_->group_accumulators, 2 * size, output, size, impl_->output_count, nullptr);
    group_selected<<<(size + block_size - 1) / block_size, block_size, 0, stream>>>(impl_->keys,
        impl_->cells, impl_->selected_keys, size, impl_->group_keys, impl_->group_accumulators, nullptr);
    write_groups<<<table_grid, block_size, 0, stream>>>(impl_->group_keys,
        impl_->group_accumulators, 2 * size, impl_->voxel_size, output, impl_->output_count);
    return cudaGetLastError();
}
cudaError_t StereoVoxelVolume::snapshot_metadata(SpatialMapPoint* output, int64_t origin,
                                                 cudaStream_t stream, float* births) {
    if (!output || !stream || origin < 0) return cudaErrorInvalidValue;
    if (!impl_->initialised) {
        const auto result = clear(stream);
        if (result != cudaSuccess) return result;
    }
    write_metadata<<<(impl_->capacity + block_size - 1) / block_size, block_size, 0, stream>>>(
        impl_->keys, impl_->cells, impl_->capacity, impl_->voxel_size, origin, output, births);
    return cudaGetLastError();
}
cudaError_t StereoVoxelVolume::snapshot_metadata_lod(SpatialMapPoint* output,
                                                     const VoxelLodConfig& config,
                                                     int64_t origin, cudaStream_t stream, float* births) {
    if (!output || !stream || origin < 0 || !valid_lod_config(config)) return cudaErrorInvalidValue;
    if (!config.max_level) return snapshot_metadata(output, origin, stream, births);
    if (!impl_->initialised) {
        const auto result = clear(stream);
        if (result != cudaSuccess) return result;
    }
    const auto result = cudaMemsetAsync(output, 0, capacity() * sizeof(SpatialMapPoint), stream);
    if (result != cudaSuccess) return result;
    const unsigned size = impl_->capacity, table_grid = (2 * size + block_size - 1) / block_size;
    impl_->select_lod(config, stream);
    prepare_groups<<<table_grid, block_size, 0, stream>>>(impl_->group_keys,
        impl_->group_accumulators, 2 * size, nullptr, size, impl_->output_count, nullptr);
    group_selected<<<(size + block_size - 1) / block_size, block_size, 0, stream>>>(impl_->keys,
        impl_->cells, impl_->selected_keys, size, impl_->group_keys, impl_->group_accumulators, nullptr);
    write_group_metadata<<<table_grid, block_size, 0, stream>>>(impl_->group_keys,
        impl_->group_accumulators, 2 * size, impl_->voxel_size, origin, output, impl_->output_count, births);
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
cudaError_t StereoVoxelVolume::transform(const float world_from_map[16], float voxel_size,
                                         int64_t origin, cudaStream_t stream) {
    MapTransform parameters{};
    if (!stream || origin < 0 || !std::isfinite(voxel_size) || voxel_size <= 0 ||
        !std::isfinite(1.f / voxel_size) || !valid_map_transform(world_from_map, parameters))
        return cudaErrorInvalidValue;
    auto result = snapshot_metadata(impl_->transform_points, origin, stream);
    if (result != cudaSuccess) return result;
    transform_metadata<<<(impl_->capacity + block_size - 1) / block_size, block_size, 0, stream>>>(
        impl_->transform_points, impl_->capacity, parameters);
    result = cudaGetLastError();
    if (result != cudaSuccess) return result;
    return restore(impl_->transform_points, capacity(), voxel_size, origin, stream);
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
cudaError_t StereoVoxelVolume::reserve(size_t capacity, cudaStream_t stream) {
    if (!stream || !capacity || capacity > stereo_voxel_capacity || (capacity & (capacity - 1)))
        return cudaErrorInvalidValue;
    if (capacity <= impl_->capacity) return cudaSuccess;
    try {
        StereoVoxelVolume replacement(capacity);
        auto result = replacement.clear(stream);
        if (result != cudaSuccess) return result;
        if (impl_->initialised) {
            grow_table<<<(impl_->capacity + block_size - 1) / block_size, block_size, 0, stream>>>(
                impl_->keys, impl_->cells, impl_->capacity, replacement.impl_->keys,
                replacement.impl_->cells, replacement.impl_->capacity);
            grow_table<<<(impl_->tsdf_capacity + block_size - 1) / block_size, block_size, 0, stream>>>(
                impl_->tsdf_keys, impl_->tsdf_cells, impl_->tsdf_capacity, replacement.impl_->tsdf_keys,
                replacement.impl_->tsdf_cells, replacement.impl_->tsdf_capacity);
            result = cudaGetLastError();
            if (result != cudaSuccess) return result;
        }
        result = cudaStreamSynchronize(stream);
        if (result != cudaSuccess) return result;
        replacement.impl_->maximum_points = impl_->maximum_points;
        replacement.impl_->initialised = impl_->initialised;
        replacement.impl_->configured = impl_->configured;
        replacement.impl_->observed = impl_->observed;
        replacement.impl_->configuration = impl_->configuration;
        replacement.impl_->voxel_size = impl_->voxel_size;
        replacement.impl_->now = impl_->now;
        replacement.impl_->sample_time = impl_->sample_time;
        impl_.swap(replacement.impl_);
        return cudaSuccess;
    } catch (const std::runtime_error&) {
        // The old allocation and all its evidence remain authoritative.
        (void)cudaGetLastError();
        return cudaErrorMemoryAllocation;
    }
}
size_t StereoVoxelVolume::max_points() const { return impl_->maximum_points; }
cudaError_t StereoVoxelVolume::statistics(VoxelStatistics* output, cudaStream_t stream) {
    if (!output || !stream) return cudaErrorInvalidValue;
    if (!impl_->initialised) {
        const auto result = clear(stream);
        if (result != cudaSuccess) return result;
    }
    initialise_statistics<<<1, 1, 0, stream>>>(output);
    count_statistics<<<(std::max(impl_->capacity, impl_->tsdf_capacity) + block_size - 1) / block_size, block_size, 0, stream>>>(
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
