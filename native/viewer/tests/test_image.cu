#include "ceres/image_kernel.hpp"
#include "image_cases.hpp"
#include <array>
#include <cmath>
#include <cuda_runtime.h>
#include <iostream>
#include <stdexcept>
static void check(cudaError_t result) {
    if (result != cudaSuccess)
        throw std::runtime_error(cudaGetErrorString(result));
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
        ceres::test::image_cases<uchar4>(
            [&](const auto& nv12, auto& rgba, const ImageConversion& config) {
                check(cudaMemcpy2DAsync(input, pitch, nv12.data(), width, width, height * 3 / 2,
                                        cudaMemcpyHostToDevice, stream));
                check(convert_nv12(input, pitch, surface, config, stream));
                check(cudaMemcpy2DFromArrayAsync(rgba.data(), width * 4, array, 0, 0, width * 4,
                                                 height, cudaMemcpyDeviceToHost, stream));
                check(cudaStreamSynchronize(stream));
            });
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
