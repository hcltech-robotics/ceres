#pragma once
#include "ceres/image_conversion.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>

namespace ceres::test {
inline void expect_image(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}
// Shared acceptance assertions, including the existing one-byte distortion tolerance.
// Pixel must expose four byte components named x, y, z, w in RGBA order.
template <class Pixel, class Convert> void image_cases(Convert&& convert) {
    constexpr int width = 8, height = 8;
    static_assert(sizeof(Pixel) == 4);
    std::array<unsigned char, width * height * 3 / 2> nv12;
    std::array<Pixel, width * height> rgba;
    ImageConversion config{};
    config.width = width;
    config.height = height;
    config.fx = config.fy = 8;
    config.cx = config.cy = 4;
    auto run = [&] { convert(nv12, rgba, config); };
    nv12.fill(128);
    std::fill_n(nv12.begin(), width * height, 16);
    run();
    expect_image(rgba[0].x == 0 && rgba[0].y == 0 && rgba[0].z == 0 && rgba[0].w == 255,
                 "Limited black conversion");
    std::fill_n(nv12.begin(), width * height, 235);
    run();
    expect_image(rgba[0].x >= 254 && rgba[0].y >= 254 && rgba[0].z >= 254,
                 "Limited white conversion");
    // A non-neutral chroma sample distinguishes the four matrix/range choices.
    std::fill_n(nv12.begin(), width * height, 81);
    for (size_t i = width * height; i < nv12.size(); i += 2) {
        nv12[i] = 90;
        nv12[i + 1] = 240;
    }
    const std::array<Pixel, 4> reference{
        {{254, 0, 0, 255}, {255, 24, 0, 255}, {238, 14, 13, 255}, {255, 35, 10, 255}}};
    for (size_t i = 0; i < reference.size(); ++i) {
        config.full_range = int(i / 2);
        config.bt709 = int(i % 2);
        run();
        for (const auto& pixel : rgba)
            expect_image(pixel.x == reference[i].x && pixel.y == reference[i].y &&
                             pixel.z == reference[i].z && pixel.w == 255,
                         "Colour matrix and range conversion");
    }
    nv12.fill(128);
    config.bt709 = false;
    config.full_range = true;
    for (int y = 0; y < height; ++y)
        for (int x = 0; x < width; ++x)
            nv12[y * width + x] = static_cast<unsigned char>(y * 20 + x * 3);
    run();
    expect_image(rgba[0].x == 0 && rgba[63].x == 161, "Full range gradient");
    config.flip_x = true;
    config.flip_y = true;
    run();
    expect_image(rgba[0].x == 161 && rgba[63].x == 0, "Image axes and flips");
    config.flip_x = config.flip_y = false;
    config.undistort = true;
    run();
    expect_image(rgba[0].x == 0 && rgba[63].x == 161, "Zero distortion identity");
    config.distortion[0] = 2;
    run();
    expect_image(rgba[0].x == 0 && rgba[0].y == 0 && rgba[0].z == 0,
                 "Distorted border must be black");
    config.cx = 2.3f;
    config.cy = 4.2f;
    config.distortion[0] = .35f;
    config.distortion[2] = .03f;
    config.distortion[3] = -.02f;
    run();
    const auto unmirrored = rgba;
    for (int y = 0; y < height; ++y)
        for (int x = 0; x < width; ++x)
            nv12[y * width + x] =
                static_cast<unsigned char>((height - 1 - y) * 20 + (width - 1 - x) * 3);
    config.flip_x = config.flip_y = true;
    run();
    for (size_t pixel = 0; pixel < rgba.size(); ++pixel)
        expect_image(std::abs(int(rgba[pixel].x) - int(unmirrored[pixel].x)) <= 1 &&
                         std::abs(int(rgba[pixel].y) - int(unmirrored[pixel].y)) <= 1 &&
                         std::abs(int(rgba[pixel].z) - int(unmirrored[pixel].z)) <= 1,
                     "Source flips preserve calibrated radial/tangential undistortion");
}
} // namespace ceres::test
