#pragma once
#include <cuda_runtime.h>
#include "image_conversion.hpp"
cudaError_t convert_nv12(const unsigned char* input, size_t pitch, cudaSurfaceObject_t output,
                         const ImageConversion& config, cudaStream_t stream);
