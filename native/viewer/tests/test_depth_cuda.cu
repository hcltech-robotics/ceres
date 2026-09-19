#include "ceres/depth_kernel.hpp"
#include <array>
#include <algorithm>
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
void stationary_wall(uint16_t* samples, ceres::StereoPoint* points, cudaStream_t stream) {
    constexpr int side = 16;
    ceres::DepthGpuConfig config;
    config.width = config.height = side;
    config.min_depth = .1f;
    config.max_depth = 8.f;
    config.inverse_projection[0] = config.inverse_projection[5] = 1;
    config.inverse_projection[11] = -4.95f;
    config.inverse_projection[14] = -1;
    config.inverse_projection[15] = 5.05f;
    for (int i = 0; i < 16; i += 5)
        config.norm_view_from_norm_depth[i] = 1;
    // The sender's GPU packet includes the output-row flip. Inverting that
    // mapping converts OpenGL readback rows into top-left view coordinates.
    config.norm_view_from_norm_depth[5] = -1;
    config.norm_view_from_norm_depth[13] = 1;
    const std::array<std::array<float, 5>, 4> poses{{
        {0, 0, 0, 1.5f, 0}, {.24f, .18f, .35f, 1.65f, .2f},
        {-.2f, -.16f, -.3f, 1.35f, -.15f}, {.1f, -.2f, .1f, 1.5f, .35f}}};
    for (const auto& pose : poses) {
        const float cp = std::cos(pose[0]), sp = std::sin(pose[0]);
        const float cy = std::cos(pose[1]), sy = std::sin(pose[1]);
        const auto rotate = [&](float x, float y, float z) {
            return std::array<float, 3>{cy * x + sy * (sp * y + cp * z),
                                        cp * y - sp * z,
                                        -sy * x + cy * (sp * y + cp * z)};
        };
        std::vector<uint16_t> image(side * side);
        for (int y = 0; y < side; ++y) {
            for (int x = 0; x < side; ++x) {
                const auto direction = rotate(2.f * (x + .5f) / side - 1,
                                               2.f * (y + .5f) / side - 1, -1);
                const float depth = (-3.f - pose[4]) / direction[2];
                image[y * side + x] = uint16_t(std::lround(depth * 1000));
            }
        }
        check(cudaMemcpyAsync(samples, image.data(), image.size() * sizeof(uint16_t),
                              cudaMemcpyHostToDevice, stream));
        check(ceres::unproject_environment_depth(samples, points, config, stream));
        std::vector<ceres::StereoPoint> gpu(image.size());
        check(cudaMemcpyAsync(gpu.data(), points, gpu.size() * sizeof(gpu[0]),
                              cudaMemcpyDeviceToHost, stream));
        check(cudaStreamSynchronize(stream));
        for (const auto& point : gpu) {
            require(point.valid == 1, "Stationary wall sample is valid");
            const auto world = rotate(point.x, point.y, point.z);
            require(std::abs(world[2] + pose[4] + 3) < .001f,
                    "Pitch, yaw and translation must preserve the stationary world wall");
        }
        for (int y = 0; y < side / 2; ++y)
            for (int x = 0; x < side; ++x)
                std::swap(image[y * side + x], image[(side - 1 - y) * side + x]);
        config.norm_view_from_norm_depth[5] = 1;
        config.norm_view_from_norm_depth[13] = 0;
        check(cudaMemcpyAsync(samples, image.data(), image.size() * sizeof(uint16_t),
                              cudaMemcpyHostToDevice, stream));
        check(ceres::unproject_environment_depth(samples, points, config, stream));
        std::vector<ceres::StereoPoint> cpu(image.size());
        check(cudaMemcpyAsync(cpu.data(), points, cpu.size() * sizeof(cpu[0]),
                              cudaMemcpyDeviceToHost, stream));
        check(cudaStreamSynchronize(stream));
        for (int y = 0; y < side; ++y) {
            for (int x = 0; x < side; ++x) {
                const auto& a = cpu[y * side + x];
                const auto& b = gpu[(side - 1 - y) * side + x];
                require(near(a.x, b.x) && near(a.y, b.y) && near(a.z, b.z),
                        "CPU and corrected GPU packets must paint identical world geometry");
            }
        }
        config.norm_view_from_norm_depth[5] = -1;
        config.norm_view_from_norm_depth[13] = 1;
    }
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
        require(out[0].r != out[1].r || out[0].b != out[1].b,
                "Different measured depths receive different spectral colours");
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
        require(near(out[0].r, .369f) && near(out[0].g, .310f) && near(out[0].b, .635f),
                "Far bound is spectral violet");
        require(near(out[1].r, .835f) && near(out[1].g, .243f) && near(out[1].b, .310f),
                "Near bound is spectral red");
        stationary_wall(samples, points, stream);
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
