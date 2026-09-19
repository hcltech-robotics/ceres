#pragma once
#include "ceres/stereo_config.hpp"
#include <cstdint>

#if defined(__CUDACC__)
#define CERES_SPATIAL_HD __host__ __device__
#else
#define CERES_SPATIAL_HD
#endif

namespace ceres {
inline constexpr unsigned hand_mask_max_capsules = 50;
inline constexpr unsigned hand_mask_max_palms = 2;

struct HandMaskCapsule {
    float from[3]{}, to[3]{};
    float radius = 0;
};

struct HandMaskPalm {
    float centre[3]{};
    // Three orthonormal world-space axes, stored consecutively.
    float axes[9]{};
    float half_extent[3]{};
};

struct HandMaskSet {
    HandMaskCapsule capsules[hand_mask_max_capsules]{};
    HandMaskPalm palms[hand_mask_max_palms]{};
    unsigned capsule_count = 0, palm_count = 0;
};

// Invalid depth is represented by valid=0. view_from_input transforms organised
// samples into the capture's view space, where axial depth is -z. All matrices
// are column-major and hand volumes are in the same tracking world as the map.
// View-normalised image coordinates have their origin at the top left, as in
// unproject_environment_depth().
struct ProjectiveDepthObservation {
    const StereoPoint* points = nullptr;
    int width = 0, height = 0;
    float projection[16]{};
    float norm_depth_from_norm_view[16]{};
    float view_from_world[16]{};
    float view_from_input[16]{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    HandMaskSet hands{};
};

static_assert(sizeof(ProjectiveDepthObservation) < 3072);

namespace hand_mask_detail {
CERES_SPATIAL_HD inline float dot(const float a[3], const float b[3]) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
CERES_SPATIAL_HD inline float clamp_unit(float value) {
    return value < 0 ? 0 : (value > 1 ? 1 : value);
}
CERES_SPATIAL_HD inline bool finite_value(float value) {
    return value >= -3.402823466e38f && value <= 3.402823466e38f;
}
CERES_SPATIAL_HD inline bool finite_point(const float point[3]) {
    for (unsigned i = 0; i < 3; ++i)
        if (!finite_value(point[i]))
            return false;
    return true;
}
CERES_SPATIAL_HD inline bool valid_capsule(const HandMaskCapsule& capsule) {
    return capsule.radius > 0 && finite_value(capsule.radius * capsule.radius) &&
           finite_point(capsule.from) && finite_point(capsule.to);
}
CERES_SPATIAL_HD inline bool valid_palm(const HandMaskPalm& palm) {
    if (!finite_point(palm.centre))
        return false;
    for (unsigned axis = 0; axis < 3; ++axis) {
        if (!(palm.half_extent[axis] > 0) || !finite_value(palm.half_extent[axis]))
            return false;
        const float* basis = palm.axes + axis * 3;
        const float norm = dot(basis, basis);
        if (!(norm >= .999f && norm <= 1.001f))
            return false;
        for (unsigned other = 0; other < axis; ++other) {
            const float alignment = dot(basis, palm.axes + other * 3);
            if (!(alignment >= -.001f && alignment <= .001f))
                return false;
        }
    }
    return true;
}
CERES_SPATIAL_HD inline float segment_distance_squared(const float p0[3], const float p1[3],
                                                       const float q0[3], const float q1[3]) {
    float u[3], v[3], w[3];
    for (unsigned i = 0; i < 3; ++i) {
        u[i] = p1[i] - p0[i];
        v[i] = q1[i] - q0[i];
        w[i] = p0[i] - q0[i];
    }
    const float a = dot(u, u), b = dot(u, v), c = dot(v, v);
    const float d = dot(u, w), e = dot(v, w);
    constexpr float epsilon = 1e-12f;
    float s = 0, t = 0;
    if (a <= epsilon) {
        t = c > epsilon ? clamp_unit(e / c) : 0;
    } else if (c <= epsilon) {
        s = clamp_unit(-d / a);
    } else {
        const float denominator = a * c - b * b;
        s = denominator > epsilon ? clamp_unit((b * e - c * d) / denominator) : 0;
        t = (b * s + e) / c;
        if (t < 0) {
            t = 0;
            s = clamp_unit(-d / a);
        } else if (t > 1) {
            t = 1;
            s = clamp_unit((b - d) / a);
        }
    }
    float separation[3];
    for (unsigned i = 0; i < 3; ++i)
        separation[i] = w[i] + s * u[i] - t * v[i];
    return dot(separation, separation);
}
CERES_SPATIAL_HD inline bool palm_contains(const HandMaskPalm& palm, const float point[3]) {
    if (!valid_palm(palm))
        return false;
    const float relative[3]{point[0] - palm.centre[0], point[1] - palm.centre[1],
                            point[2] - palm.centre[2]};
    for (unsigned axis = 0; axis < 3; ++axis) {
        const float coordinate = dot(relative, palm.axes + axis * 3);
        if (!(coordinate >= -palm.half_extent[axis] && coordinate <= palm.half_extent[axis]))
            return false;
    }
    return true;
}
CERES_SPATIAL_HD inline bool palm_intersects(const HandMaskPalm& palm, const float from[3],
                                             const float to[3]) {
    if (!valid_palm(palm))
        return false;
    const float relative[3]{from[0] - palm.centre[0], from[1] - palm.centre[1],
                            from[2] - palm.centre[2]};
    const float direction[3]{to[0] - from[0], to[1] - from[1], to[2] - from[2]};
    float begin = 0, end = 1;
    for (unsigned axis = 0; axis < 3; ++axis) {
        const float position = dot(relative, palm.axes + axis * 3);
        const float delta = dot(direction, palm.axes + axis * 3);
        const float extent = palm.half_extent[axis];
        if (delta > -1e-9f && delta < 1e-9f) {
            if (position < -extent || position > extent)
                return false;
        } else {
            float near = (-extent - position) / delta;
            float far = (extent - position) / delta;
            if (near > far) {
                const float swap = near;
                near = far;
                far = swap;
            }
            begin = begin > near ? begin : near;
            end = end < far ? end : far;
            if (begin > end)
                return false;
        }
    }
    return true;
}
} // namespace hand_mask_detail

CERES_SPATIAL_HD inline bool valid_hand_mask(const HandMaskSet& mask) {
    if (mask.capsule_count > hand_mask_max_capsules || mask.palm_count > hand_mask_max_palms)
        return false;
    for (unsigned i = 0; i < mask.capsule_count; ++i)
        if (!hand_mask_detail::valid_capsule(mask.capsules[i]))
            return false;
    for (unsigned i = 0; i < mask.palm_count; ++i)
        if (!hand_mask_detail::valid_palm(mask.palms[i]))
            return false;
    return true;
}

CERES_SPATIAL_HD inline bool hand_mask_contains(const HandMaskSet& mask, float x, float y,
                                                float z) {
    const float point[3]{x, y, z};
    if (!hand_mask_detail::finite_point(point))
        return false;
    for (unsigned i = 0; i < mask.capsule_count && i < hand_mask_max_capsules; ++i) {
        const auto& capsule = mask.capsules[i];
        if (hand_mask_detail::valid_capsule(capsule) &&
            hand_mask_detail::segment_distance_squared(point, point, capsule.from, capsule.to) <=
                capsule.radius * capsule.radius)
            return true;
    }
    for (unsigned i = 0; i < mask.palm_count && i < hand_mask_max_palms; ++i)
        if (hand_mask_detail::palm_contains(mask.palms[i], point))
            return true;
    return false;
}

// A finite camera-to-voxel segment is used, so a hand behind the voxel cannot
// shield it from contradictory depth. An intersected hand shields the static
// background even when the current depth value is missing or unreliable.
CERES_SPATIAL_HD inline bool hand_mask_occludes(const HandMaskSet& mask, const float origin[3],
                                                const float end[3]) {
    if (!hand_mask_detail::finite_point(origin) || !hand_mask_detail::finite_point(end))
        return false;
    for (unsigned i = 0; i < mask.capsule_count && i < hand_mask_max_capsules; ++i) {
        const auto& capsule = mask.capsules[i];
        if (hand_mask_detail::valid_capsule(capsule) &&
            hand_mask_detail::segment_distance_squared(origin, end, capsule.from, capsule.to) <=
                capsule.radius * capsule.radius)
            return true;
    }
    for (unsigned i = 0; i < mask.palm_count && i < hand_mask_max_palms; ++i)
        if (hand_mask_detail::palm_intersects(mask.palms[i], origin, end))
            return true;
    return false;
}
} // namespace ceres

#undef CERES_SPATIAL_HD
