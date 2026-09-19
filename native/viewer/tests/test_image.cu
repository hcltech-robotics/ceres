#include "ceres/image_kernel.hpp"
#include <array>
#include <cmath>
#include <cuda_runtime.h>
#include <iostream>
#include <stdexcept>
static void check(cudaError_t result) {
    if (result != cudaSuccess)
        throw std::runtime_error(cudaGetErrorString(result));
}
static void expect(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}
int main() {
    try {
        constexpr int width = 8, height = 8;
        unsigned char* input = nullptr;
        size_t pitch = 0;
        check(cudaMallocPitch(&input, &pitch, width, height * 3 / 2));
        cudaChannelFormatDesc format = cudaCreateChannelDesc<uchar4>();
        cudaArray_t array = nullptr;
        check(cudaMallocArray(&array, &format, width, height, cudaArraySurfaceLoadStore));
        cudaResourceDesc resource{};
        resource.resType = cudaResourceTypeArray;
        resource.res.array.array = array;
        cudaSurfaceObject_t surface = 0;
        check(cudaCreateSurfaceObject(&surface, &resource));
        cudaStream_t stream;
        check(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking));
        std::array<unsigned char, width * height * 3 / 2> nv12;
        std::array<uchar4, width * height> rgba;
        ImageConversion config{};
        config.width = width;
        config.height = height;
        config.fx = config.fy = 8;
        config.cx = config.cy = 4;
        auto run = [&] {
            check(cudaMemcpy2DAsync(input, pitch, nv12.data(), width, width, height * 3 / 2,
                                    cudaMemcpyHostToDevice, stream));
            check(convert_nv12(input, pitch, surface, config, stream));
            check(cudaMemcpy2DFromArrayAsync(rgba.data(), width * 4, array, 0, 0, width * 4, height,
                                             cudaMemcpyDeviceToHost, stream));
            check(cudaStreamSynchronize(stream));
        };
        nv12.fill(128);
        std::fill_n(nv12.begin(), width * height, 16);
        run();
        expect(rgba[0].x == 0 && rgba[0].y == 0 && rgba[0].z == 0 && rgba[0].w == 255,
               "Limited black conversion");
        std::fill_n(nv12.begin(), width * height, 235);
        run();
        expect(rgba[0].x >= 254 && rgba[0].y >= 254 && rgba[0].z >= 254,
               "Limited white conversion");
        config.full_range = true;
        for (int y = 0; y < height; ++y)
            for (int x = 0; x < width; ++x)
                nv12[y * width + x] = static_cast<unsigned char>(y * 20 + x * 3);
        run();
        expect(rgba[0].x == 0 && rgba[63].x == 161, "Full range gradient");
        config.flip_x = true;
        config.flip_y = true;
        run();
        expect(rgba[0].x == 161 && rgba[63].x == 0, "Image axes and flips");
        config.flip_x = config.flip_y = false;
        config.undistort = true;
        run();
        expect(rgba[0].x == 0 && rgba[63].x == 161, "Zero distortion identity");
        config.distortion[0] = 2;
        run();
        expect(rgba[0].x == 0 && rgba[0].y == 0 && rgba[0].z == 0,
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
            expect(std::abs(int(rgba[pixel].x) - int(unmirrored[pixel].x)) <= 1 &&
                       std::abs(int(rgba[pixel].y) - int(unmirrored[pixel].y)) <= 1 &&
                       std::abs(int(rgba[pixel].z) - int(unmirrored[pixel].z)) <= 1,
                   "Source flips preserve calibrated radial/tangential undistortion");
        check(cudaStreamDestroy(stream));
        check(cudaDestroySurfaceObject(surface));
        check(cudaFreeArray(array));
        check(cudaFree(input));
        std::cout << "CUDA colour, image orientation and distortion tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
