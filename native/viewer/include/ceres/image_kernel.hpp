#pragma once
#include <cuda_runtime.h>
struct ImageConversion {
    int width, height, full_range, bt709, undistort, flip_x, flip_y;
    float fx, fy, cx, cy;
    float distortion[5];
};
cudaError_t convert_nv12(const unsigned char* input, size_t pitch, cudaSurfaceObject_t output,
                         const ImageConversion& config, cudaStream_t stream);
