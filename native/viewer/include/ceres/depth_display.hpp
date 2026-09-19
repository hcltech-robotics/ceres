#pragma once

#ifdef __CUDACC__
#define CERES_DEPTH_HD __host__ __device__
#else
#define CERES_DEPTH_HD
#endif

namespace ceres {
enum class DepthGradient { spectral, viridis, plasma, inferno, greys };

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

// Eight evenly spaced samples from Matplotlib 3.10.1's canonical colormaps.
// The CPU scale and GPU palette interpolate the same stops.
// https://github.com/matplotlib/matplotlib/tree/v3.10.1/lib/matplotlib
CERES_DEPTH_HD inline DepthColour depth_gradient_colour(DepthGradient gradient, float fraction) {
    if (gradient == DepthGradient::spectral)
        return spectral_depth_colour(fraction);
    const DepthColour palettes[4][8] = {
        {{.267004f, .004874f, .329415f}, {.275191f, .194905f, .496005f},
         {.212395f, .359683f, .551710f}, {.153364f, .497000f, .557724f},
         {.122312f, .633153f, .530398f}, {.288921f, .758394f, .428426f},
         {.626579f, .854645f, .223353f}, {.993248f, .906157f, .143936f}},
        {{.050383f, .029803f, .527975f}, {.325150f, .006915f, .639512f},
         {.546157f, .038954f, .647010f}, {.723444f, .196158f, .538981f},
         {.859750f, .360588f, .406917f}, {.955470f, .533093f, .285490f},
         {.994495f, .740880f, .166335f}, {.940015f, .975158f, .131326f}},
        {{.001462f, .000466f, .013866f}, {.155850f, .044559f, .325338f},
         {.397674f, .083257f, .433183f}, {.621685f, .164184f, .388781f},
         {.832299f, .283913f, .257383f}, {.961293f, .488716f, .084289f},
         {.981173f, .759135f, .156863f}, {.988362f, .998364f, .644924f}},
        {{1.f, 1.f, 1.f}, {.929504f, .929504f, .929504f},
         {.819116f, .819116f, .819116f}, {.677001f, .677001f, .677001f},
         {.508574f, .508574f, .508574f}, {.359123f, .359123f, .359123f},
         {.167935f, .167935f, .167935f}, {0.f, 0.f, 0.f}}};
    const int palette = static_cast<int>(gradient);
    if (palette < 1 || palette > 4)
        return spectral_depth_colour(fraction);
    const auto* stops = palettes[palette - 1];
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
