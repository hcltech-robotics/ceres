#pragma once

#ifdef __CUDACC__
#define CERES_DEPTH_HD __host__ __device__
#else
#define CERES_DEPTH_HD
#endif

namespace ceres {
struct DepthColour {
    float r, g, b;
};

// The renderer, CUDA samples and on-screen scale share a warm-near, cool-far spectrum.
CERES_DEPTH_HD inline DepthColour spectral_depth_colour(float fraction) {
    const DepthColour stops[] = {{.835f, .243f, .310f}, {.957f, .427f, .263f},
                                {.996f, .878f, .545f}, {1.f, 1.f, .749f},
                                {.671f, .867f, .643f}, {.400f, .761f, .647f},
                                {.196f, .533f, .741f}, {.369f, .310f, .635f}};
    const float bounded = fraction > 0 ? (fraction < 1 ? fraction : 1.f) : 0.f;
    const float position = bounded * 7;
    const int index = position < 7 ? int(position) : 6;
    const float weight = position - float(index);
    return {stops[index].r + (stops[index + 1].r - stops[index].r) * weight,
            stops[index].g + (stops[index + 1].g - stops[index].g) * weight,
            stops[index].b + (stops[index + 1].b - stops[index].b) * weight};
}
} // namespace ceres

#undef CERES_DEPTH_HD
