#include "ceres/stereo_kernel.hpp"
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
void expect(bool value, const char* message) {
    if (!value)
        throw std::runtime_error(message);
}
constexpr int width = 128, height = 96, disparity = 8;
unsigned char pattern(int x, int y) {
    unsigned value = unsigned(x + 17) * 0x9e3779b9u ^ unsigned(y + 23) * 0x85ebca6bu;
    value ^= value >> 16;
    value *= 0x7feb352du;
    value ^= value >> 15;
    return static_cast<unsigned char>(30 + value % 150);
}
void identity(float* matrix) {
    std::fill_n(matrix, 9, 0.0f);
    matrix[0] = matrix[4] = matrix[8] = 1;
}
float texture(float x, float y) {
    const int ix = int(std::floor(x)), iy = int(std::floor(y));
    const float dx = x - ix, dy = y - iy;
    return (1 - dy) * ((1 - dx) * pattern(ix, iy) + dx * pattern(ix + 1, iy)) +
           dy * ((1 - dx) * pattern(ix, iy + 1) + dx * pattern(ix + 1, iy + 1));
}

// Render a plane through each source camera, independently of the rectification kernel.
void camera_plane(std::vector<unsigned char>& image, ceres::StereoGpuCamera& camera, float yaw,
                  float origin_x) {
    const float cosine = std::cos(yaw), sine = std::sin(yaw);
    identity(camera.ray_to_camera);
    camera.ray_to_camera[0] = camera.ray_to_camera[8] = cosine;
    camera.ray_to_camera[2] = -sine;
    camera.ray_to_camera[6] = sine;
    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            const float dx = (x - camera.cx) / camera.fx, dy = (y - camera.cy) / camera.fy;
            float nx = dx, ny = dy;
            for (int i = 0; i < 12; ++i) {
                const float scale = 1 + camera.distortion[0] * (nx * nx + ny * ny);
                nx = dx / scale;
                ny = dy / scale;
            }
            const float ray_x = cosine * nx - sine, ray_y = -ny, ray_z = -sine * nx - cosine;
            const float t = -1.5f / ray_z;
            const float tx = (origin_x + ray_x * t) * 120 / 1.5f + (width - 1) * 0.5f;
            const float ty = -(ray_y * t) * 120 / 1.5f + (height - 1) * 0.5f;
            image[y * width + x] = static_cast<unsigned char>(texture(tx, ty));
        }
    }
}
ceres::StereoGpuConfig config() {
    ceres::StereoGpuConfig c;
    c.width = width;
    c.height = height;
    c.fx = c.fy = 120;
    c.cx = (width - 1) * 0.5f;
    c.cy = (height - 1) * 0.5f;
    c.baseline_metres = 0.1f;
    c.max_disparity = 32;
    identity(c.rect_to_head);
    c.left_origin[0] = -0.05f;
    for (auto* camera : {&c.left, &c.right}) {
        camera->width = width;
        camera->height = height;
        camera->fx = camera->fy = c.fx;
        camera->cx = c.cx;
        camera->cy = c.cy;
        identity(camera->ray_to_camera);
    }
    return c;
}
struct Fixture {
    cudaStream_t stream = nullptr;
    ceres::StereoNv12 left, right;
    ceres::StereoPoint* device_points = nullptr;
    std::vector<unsigned char> luma_left, luma_right;
    std::vector<ceres::StereoPoint> output;
    ceres::StereoGpuWorkspace workspace{width, height};
    Fixture()
        : luma_left(width * height * 3 / 2, 128), luma_right(width * height * 3 / 2, 128),
          output(width * height) {
        check(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking));
        for (auto* input : {&left, &right}) {
            unsigned char* data = nullptr;
            check(cudaMallocPitch(&data, &input->pitch, width, height * 3 / 2));
            input->data = data;
            input->width = width;
            input->height = height;
            input->full_range = true;
        }
        check(cudaMalloc(&device_points, output.size() * sizeof(ceres::StereoPoint)));
        textured();
    }
    ~Fixture() {
        cudaStreamSynchronize(stream);
        cudaFree(const_cast<unsigned char*>(left.data));
        cudaFree(const_cast<unsigned char*>(right.data));
        cudaFree(device_points);
        cudaStreamDestroy(stream);
    }
    void textured() {
        for (int y = 0; y < height; ++y)
            for (int x = 0; x < width; ++x) {
                luma_left[y * width + x] = pattern(x, y);
                luma_right[y * width + x] = pattern(x + disparity, y);
            }
    }
    void run(const ceres::StereoGpuConfig& c) {
        check(cudaMemcpy2DAsync(const_cast<unsigned char*>(left.data), left.pitch, luma_left.data(),
                                width, width, height * 3 / 2, cudaMemcpyHostToDevice, stream));
        check(cudaMemcpy2DAsync(const_cast<unsigned char*>(right.data), right.pitch,
                                luma_right.data(), width, width, height * 3 / 2,
                                cudaMemcpyHostToDevice, stream));
        check(workspace.enqueue(left, right, c, device_points, stream));
        check(cudaMemcpyAsync(output.data(), device_points,
                              output.size() * sizeof(ceres::StereoPoint), cudaMemcpyDeviceToHost,
                              stream));
        check(cudaStreamSynchronize(stream));
    }
};
} // namespace
int main() {
    try {
        Fixture f;
        auto c = config();
        expect(f.workspace.scratch_bytes() < 1024 * 1024, "Scratch allocation must remain bounded");
        f.run(c);
        int valid = 0, total = 0;
        double depth_error = 0;
        for (int y = 8; y < height - 8; ++y) {
            for (int x = disparity + 8; x < width - 8; ++x) {
                const auto& p = f.output[y * width + x];
                ++total;
                if (!p.valid)
                    continue;
                ++valid;
                depth_error += std::abs(-p.z - 1.5f);
                expect(p.a == 1 && p.r >= 0 && p.r <= 1 && p.g >= 0 && p.b <= 1,
                       "Reconstructed point colour");
            }
        }
        expect(valid > total * 0.97, "Textured analytic plane coverage");
        expect(depth_error / valid < 0.02, "Metric analytic plane depth");
        const auto baseline = f.output;
        expect(baseline[height / 4 * width + width / 2].y > 0, "WebXR image up is positive Y");
        expect(baseline[height / 2 * width + width / 4].x < -0.05f,
               "WebXR image left is negative X");

        // Census tolerates a camera brightness offset without altering correspondence.
        for (int i = 0; i < width * height; ++i)
            f.luma_right[i] += 20;
        f.run(c);
        int preserved = 0;
        for (int i = 0; i < width * height; ++i)
            if (baseline[i].valid && f.output[i].valid &&
                std::abs(baseline[i].z - f.output[i].z) < 1e-4)
                ++preserved;
        expect(preserved > valid * 0.95, "Brightness-invariant correspondence");

        f.textured();
        for (auto* pixels : {&f.luma_left, &f.luma_right}) {
            for (int y = 0; y < height; ++y)
                std::reverse(pixels->begin() + y * width, pixels->begin() + (y + 1) * width);
            for (int y = 0; y < height / 2; ++y)
                for (int x = 0; x < width; ++x)
                    std::swap((*pixels)[y * width + x], (*pixels)[(height - 1 - y) * width + x]);
        }
        c.left.flip_x = c.left.flip_y = c.right.flip_x = c.right.flip_y = true;
        f.run(c);
        int unflipped_valid = 0, flipped_valid = 0;
        double flipped_error = 0;
        for (int i = 0; i < width * height; ++i) {
            if (!baseline[i].valid)
                continue;
            ++unflipped_valid;
            if (f.output[i].valid) {
                ++flipped_valid;
                flipped_error += std::abs(f.output[i].z - baseline[i].z);
            }
        }
        std::cout << "Flip coverage " << flipped_valid << '/' << unflipped_valid
                  << ", mean depth difference " << flipped_error / flipped_valid << " m\n";
        expect(flipped_valid > unflipped_valid * 0.99 && flipped_error / flipped_valid < 0.003,
               "Encoded flips must preserve rectified metric depth");

        f.textured();
        c = config();
        c.rect_to_head[0] = c.rect_to_head[8] = 0;
        c.rect_to_head[2] = 1;
        c.rect_to_head[6] = -1;
        c.left_origin[0] = 1;
        c.left_origin[1] = 2;
        c.left_origin[2] = 3;
        f.run(c);
        const int centre = height / 2 * width + width / 2;
        expect(f.output[centre].valid &&
                   std::abs(f.output[centre].x - (baseline[centre].z + 1)) < 1e-5 &&
                   std::abs(f.output[centre].y - (baseline[centre].y + 2)) < 1e-5 &&
                   std::abs(f.output[centre].z - (-baseline[centre].x - 0.05f + 3)) < 1e-5,
               "Point cloud transforms into head-local metres");

        c = config();
        c.left.fx = 126;
        c.right.fx = 116;
        c.left.cx -= 3;
        c.right.cy += 2;
        c.left.distortion[0] = 0.08f;
        c.right.distortion[0] = -0.04f;
        camera_plane(f.luma_left, c.left, 0.035f, 0);
        camera_plane(f.luma_right, c.right, -0.025f, 0.1f);
        f.run(c);
        std::vector<float> warped_errors;
        for (int y = 12; y < height - 12; ++y)
            for (int x = 24; x < width - 16; ++x)
                if (const auto& p = f.output[y * width + x]; p.valid)
                    warped_errors.push_back(std::abs(-p.z - 1.5f));
        expect(warped_errors.size() > 3500, "Calibrated camera rectification coverage");
        std::sort(warped_errors.begin(), warped_errors.end());
        expect(warped_errors[warped_errors.size() / 2] < 0.04f,
               "Different intrinsics, rotations and distortion reconstruct the same plane");

        c = config();
        f.textured();
        for (int y = 0; y < height; ++y)
            std::fill_n(f.luma_right.begin() + y * width + 40, 24, 128);
        f.run(c);
        int rejected = 0, occluded = 0;
        for (int y = 8; y < height - 8; ++y)
            for (int x = 53; x <= 65; ++x) {
                ++occluded;
                rejected += f.output[y * width + x].valid == 0;
            }
        expect(rejected > occluded * 0.95, "Occluded and inconsistent correspondences rejected");

        std::fill(f.luma_left.begin(), f.luma_left.end(), 128);
        std::fill(f.luma_right.begin(), f.luma_right.end(), 128);
        f.run(c);
        expect(std::all_of(f.output.begin(), f.output.end(),
                           [](const auto& p) {
                               return p.valid == 0 && p.a == 0 && p.x == 0 && p.y == 0 && p.z == 0;
                           }),
               "Textureless images must not invent surfaces");
        auto wrong = f.left;
        wrong.width /= 2;
        expect(f.workspace.enqueue(wrong, f.right, c, f.device_points, f.stream) ==
                   cudaErrorInvalidValue,
               "Uncalibrated image dimensions rejected");
        c.max_disparity = 1024;
        expect(f.workspace.enqueue(f.left, f.right, c, f.device_points, f.stream) ==
                   cudaErrorInvalidValue,
               "Unbounded disparity search rejected");
        c = config();
        c.fx = std::numeric_limits<float>::quiet_NaN();
        expect(f.workspace.enqueue(f.left, f.right, c, f.device_points, f.stream) ==
                   cudaErrorInvalidValue,
               "Nonfinite GPU configuration rejected");
        f.textured();
        c = config();
        f.run(c);
        c.width = 320;
        c.height = 240;
        c.fx = c.fy = 300;
        c.cx = 159.5f;
        c.cy = 119.5f;
        c.max_disparity = ceres::stereo_max_disparity;
        ceres::StereoGpuWorkspace timed(c.width, c.height);
        ceres::StereoPoint* timed_output = nullptr;
        check(cudaMalloc(&timed_output, size_t(c.width) * c.height * sizeof(ceres::StereoPoint)));
        cudaEvent_t begin = nullptr, end = nullptr;
        check(cudaEventCreate(&begin));
        check(cudaEventCreate(&end));
        std::vector<float> milliseconds;
        for (int sample = 0; sample < 23; ++sample) {
            check(cudaEventRecord(begin, f.stream));
            check(timed.enqueue(f.left, f.right, c, timed_output, f.stream));
            check(cudaEventRecord(end, f.stream));
            check(cudaEventSynchronize(end));
            float elapsed = 0;
            check(cudaEventElapsedTime(&elapsed, begin, end));
            if (sample >= 3)
                milliseconds.push_back(elapsed);
        }
        std::sort(milliseconds.begin(), milliseconds.end());
        std::cout << "CUDA stereo 320x240/96 disparities p95 " << milliseconds[18]
                  << " ms, scratch " << timed.scratch_bytes() << " bytes\n";
        check(cudaEventDestroy(begin));
        check(cudaEventDestroy(end));
        check(cudaFree(timed_output));
        std::cout << "CUDA stereo depth, colour, flips, transforms and rejection tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
