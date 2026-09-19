#include "ceres/depth_kernel.hpp"
#include <array>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <vector>

namespace {
void check(cudaError_t result) {
    if (result != cudaSuccess)
        throw std::runtime_error(cudaGetErrorString(result));
}
void require(bool value, const char* message) {
    if (!value)
        throw std::runtime_error(message);
}
bool near(float a, float b) {
    return std::abs(a - b) < .0001f;
}
struct Vec3 {
    float x, y, z;
};
Vec3 operator+(Vec3 a, Vec3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
Vec3 operator*(Vec3 a, float b) { return {a.x * b, a.y * b, a.z * b}; }
struct CapturePose {
    float pitch, yaw, roll;
    Vec3 position;
    Vec3 rotate(Vec3 v) const {
        const float cp = std::cos(pitch), sp = std::sin(pitch);
        const float cy = std::cos(yaw), sy = std::sin(yaw);
        const float cr = std::cos(roll), sr = std::sin(roll);
        const Vec3 p{v.x, cp * v.y - sp * v.z, sp * v.y + cp * v.z};
        const Vec3 y{cy * p.x + sy * p.z, p.y, -sy * p.x + cy * p.z};
        return {cr * y.x - sr * y.y, sr * y.x + cr * y.y, y.z};
    }
};
struct Box { Vec3 minimum, maximum; };
float intersect_box(Vec3 origin, Vec3 direction, Box box) {
    const std::array<float, 3> o{origin.x, origin.y, origin.z};
    const std::array<float, 3> d{direction.x, direction.y, direction.z};
    const std::array<float, 3> low{box.minimum.x, box.minimum.y, box.minimum.z};
    const std::array<float, 3> high{box.maximum.x, box.maximum.y, box.maximum.z};
    float first = .1f, last = 8.f;
    for (size_t axis = 0; axis < 3; ++axis) {
        if (std::abs(d[axis]) < 1e-7f) {
            if (o[axis] < low[axis] || o[axis] > high[axis])
                return 0;
        } else {
            const float a = (low[axis] - o[axis]) / d[axis];
            const float b = (high[axis] - o[axis]) / d[axis];
            first = std::max(first, std::min(a, b));
            last = std::min(last, std::max(a, b));
            if (first > last)
                return 0;
        }
    }
    return first;
}
void asymmetric_room(uint16_t* samples, ceres::StereoPoint* points, cudaStream_t stream) {
    const auto started = std::chrono::steady_clock::now();
    constexpr int width = 48, height = 36;
    constexpr float aspect = float(width) / height;
    ceres::DepthGpuConfig config;
    config.width = width;
    config.height = height;
    config.min_depth = .1f;
    config.max_depth = 8.f;
    config.inverse_projection[0] = aspect;
    config.inverse_projection[5] = 1;
    config.inverse_projection[11] = -4.95f;
    config.inverse_projection[14] = -1;
    config.inverse_projection[15] = 5.05f;
    for (int i = 0; i < 16; i += 5)
        config.norm_view_from_norm_depth[i] = 1;
    const std::array<CapturePose, 4> poses{{
        {0, 0, 0, {0, 1.25f, 0}},
        {.15f, .10f, 0, {.18f, 1.4f, .12f}},
        {-.13f, -.11f, .07f, {-.2f, 1.15f, -.12f}},
        {.05f, .16f, -.08f, {.08f, 1.3f, .2f}}}};
    // Unequal raised and low obstacles make a vertical reflection observable.
    const std::array<Box, 2> obstacles{{
        {{-.8f, 1.75f, -1.9f}, {-.3f, 2.2f, -1.5f}},
        {{.25f, .35f, -1.55f}, {.75f, .7f, -1.2f}}}};
    float maximum_world_error = 0;
    size_t negative_control_failures = 0;
    for (const auto& pose : poses) {
        std::vector<uint16_t> image(width * height);
        std::vector<Vec3> expected(image.size());
        std::vector<unsigned> labels(image.size());
        std::array<size_t, 4> hits{};
        for (int y = 0; y < height; ++y) {
            for (int x = 0; x < width; ++x) {
                const auto direction = pose.rotate({aspect * (2.f * (x + .5f) / width - 1),
                                                     1 - 2.f * (y + .5f) / height, -1});
                float depth = (-3.f - pose.position.z) / direction.z;
                unsigned label = 0;
                if (direction.y < -1e-7f) {
                    const float floor = -pose.position.y / direction.y;
                    if (floor >= .1f && floor < depth) {
                        depth = floor;
                        label = 1;
                    }
                }
                for (unsigned obstacle = 0; obstacle < obstacles.size(); ++obstacle) {
                    const float hit = intersect_box(pose.position, direction, obstacles[obstacle]);
                    if (hit > 0 && hit < depth) {
                        depth = hit;
                        label = obstacle + 2;
                    }
                }
                require(depth >= .1f && depth < 8.f, "Room ray remains in the depth range");
                const size_t i = size_t(y) * width + x;
                image[i] = uint16_t(std::lround(depth * 1000));
                expected[i] = pose.position + direction * depth;
                labels[i] = label;
                ++hits[label];
            }
        }
        for (const auto count : hits)
            require(count >= 4, "Every capture sees floor, wall and both asymmetric obstacles");
        auto run = [&] {
            check(cudaMemcpyAsync(samples, image.data(), image.size() * sizeof(uint16_t),
                                  cudaMemcpyHostToDevice, stream));
            check(ceres::unproject_environment_depth(samples, points, config, stream));
            std::vector<ceres::StereoPoint> out(image.size());
            check(cudaMemcpyAsync(out.data(), points, out.size() * sizeof(out[0]),
                                  cudaMemcpyDeviceToHost, stream));
            check(cudaStreamSynchronize(stream));
            return out;
        };
        config.norm_view_from_norm_depth[5] = 1;
        config.norm_view_from_norm_depth[13] = 0;
        const auto top_left = run();
        for (size_t i = 0; i < top_left.size(); ++i) {
            const auto& point = top_left[i];
            require(point.valid == 1, "Asymmetric room sample is valid");
            const auto world = pose.position + pose.rotate({point.x, point.y, point.z});
            const auto& hit = expected[i];
            maximum_world_error = std::max({maximum_world_error, std::abs(world.x - hit.x),
                                             std::abs(world.y - hit.y), std::abs(world.z - hit.z)});
            require(std::abs(world.x - hit.x) < .002f && std::abs(world.y - hit.y) < .002f &&
                        std::abs(world.z - hit.z) < .002f,
                    "Capture pose and row orientation must retain the stationary world scene");
            if (labels[i] == 1)
                require(std::abs(world.y) < .002f, "The floor must remain below the headset");
            if (labels[i] == 2)
                require(world.y >= 1.748f, "The raised obstacle must remain above the headset");
            if (labels[i] == 3)
                require(world.y <= .702f, "The low obstacle must remain below the raised obstacle");
        }
        // Reversing packed rows requires the matching buffer-coordinate matrix.
        // The unprojector uses this explicit contract, independent of acquisition API.
        for (int y = 0; y < height / 2; ++y)
            for (int x = 0; x < width; ++x)
                std::swap(image[y * width + x], image[(height - 1 - y) * width + x]);
        config.norm_view_from_norm_depth[5] = -1;
        config.norm_view_from_norm_depth[13] = 1;
        const auto bottom_left = run();
        for (int y = 0; y < height; ++y) {
            for (int x = 0; x < width; ++x) {
                const auto& a = top_left[y * width + x];
                const auto& b = bottom_left[(height - 1 - y) * width + x];
                require(near(a.x, b.x) && near(a.y, b.y) && near(a.z, b.z),
                        "Explicit row normalisation must produce identical world geometry");
            }
        }
        config.norm_view_from_norm_depth[5] = 1;
        config.norm_view_from_norm_depth[13] = 0;
        const auto incorrect = run();
        size_t wrong_side = 0;
        for (int y = 0; y < height; ++y)
            for (int x = 0; x < width; ++x) {
                const auto& a = top_left[y * width + x];
                const auto& b = incorrect[(height - 1 - y) * width + x];
                wrong_side += a.y * b.y < 0 && std::abs(a.y - b.y) > .05f;
            }
        require(wrong_side > image.size() / 2,
                "The asymmetric regression must detect a missing or repeated vertical flip");
        negative_control_failures += wrong_side;
    }
    const auto milliseconds = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - started).count();
    std::cout << "Asymmetric room: captures=" << poses.size()
              << " points=" << poses.size() * width * height
              << " maximum_world_error_m=" << maximum_world_error
              << " wrong_flip_points=" << negative_control_failures
              << " elapsed_ms=" << milliseconds << '\n';
}
} // namespace
int main() {
    uint16_t* samples = nullptr;
    ceres::StereoPoint* points = nullptr;
    cudaStream_t stream = nullptr;
    try {
        check(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking));
        check(cudaMalloc(&samples, 256 * 256 * sizeof(uint16_t)));
        check(cudaMalloc(&points, 256 * 256 * sizeof(ceres::StereoPoint)));
        ceres::DepthGpuConfig config;
        config.width = config.height = 2;
        // Inverse of an OpenGL 90-degree perspective matrix with near .1, far 10.
        config.inverse_projection[0] = config.inverse_projection[5] = 1;
        config.inverse_projection[11] = -4.95f;
        config.inverse_projection[14] = -1;
        config.inverse_projection[15] = 5.05f;
        for (int i = 0; i < 16; i += 5)
            config.norm_view_from_norm_depth[i] = 1;
        const uint16_t data[] = {2000, 1000, 0, 9000};
        auto run = [&] {
            check(ceres::unproject_environment_depth(samples, points, config, stream));
            std::vector<ceres::StereoPoint> out(size_t(config.width) * config.height);
            check(cudaMemcpyAsync(out.data(), points, out.size() * sizeof(out[0]),
                                  cudaMemcpyDeviceToHost, stream));
            check(cudaStreamSynchronize(stream));
            return out;
        };
        check(cudaMemcpyAsync(samples, data, sizeof(data), cudaMemcpyHostToDevice, stream));
        auto out = run();
        require(out[0].valid == 1 && near(out[0].x, -1) && near(out[0].y, 1) && near(out[0].z, -2),
                "Depth must be axial, with top-left mapping and negative WebXR Z");
        require(out[1].valid == 1 && near(out[1].x, .5f) && near(out[1].y, .5f),
                "Right-side projection");
        require(out[0].r == 0 && out[0].g == 0 && out[0].b == 0 &&
                    out[1].r == 0 && out[1].g == 0 && out[1].b == 0,
                "Unprojected depth carries geometry without a baked display palette");
        require(out[2].valid == 0 && out[3].valid == 0,
                "Missing and out-of-range depth must remain invalid");
        config.norm_view_from_norm_depth[0] = -1;
        config.norm_view_from_norm_depth[12] = 1;
        out = run();
        require(near(out[0].x, 1) && near(out[1].x, -.5f),
                "Depth transform must honour horizontal mirroring");
        config.norm_view_from_norm_depth[0] = 2;
        config.norm_view_from_norm_depth[12] = -.5f;
        out = run();
        require(near(out[0].x, -2) && near(out[1].x, 1), "Depth crop must preserve full-view rays");
        config.norm_view_from_norm_depth[12] = 3;
        out = run();
        require(out[0].valid == 0 && out[1].valid == 0,
                "Outside-view samples must not create points");
        config.inverse_projection[0] = std::numeric_limits<float>::quiet_NaN();
        require(ceres::unproject_environment_depth(samples, points, config, stream) ==
                    cudaErrorInvalidValue,
                "Non-finite projection rejected");
        config.inverse_projection[0] = 1;
        config.width = 257;
        require(ceres::unproject_environment_depth(samples, points, config, stream) ==
                    cudaErrorInvalidValue,
                "Oversized depth rejected");
        config.width = config.height = 2;
        config.min_depth = 1;
        config.max_depth = 2;
        std::fill_n(config.norm_view_from_norm_depth, 16, 0.f);
        for (int i = 0; i < 16; i += 5)
            config.norm_view_from_norm_depth[i] = 1;
        out = run();
        require(out[0].r == 0 && out[0].g == 0 && out[0].b == 0 &&
                    out[1].r == 0 && out[1].g == 0 && out[1].b == 0,
                "Changing acquisition depth bounds cannot recolour retained geometry");
        asymmetric_room(samples, points, stream);
        check(cudaStreamDestroy(stream));
        stream = nullptr;
        check(cudaFree(samples));
        samples = nullptr;
        check(cudaFree(points));
        points = nullptr;
        std::cout << "Environment depth projection tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        if (stream)
            cudaStreamSynchronize(stream);
        cudaFree(samples);
        cudaFree(points);
        if (stream)
            cudaStreamDestroy(stream);
        std::cerr << error.what() << '\n';
        return 1;
    }
}
