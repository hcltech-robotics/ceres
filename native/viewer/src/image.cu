#include "ceres/image_kernel.hpp"
__device__ float sample_y(const unsigned char* p, size_t pitch, float x, float y, int w, int h) {
    x = fminf(fmaxf(x, 0), float(w - 1));
    y = fminf(fmaxf(y, 0), float(h - 1));
    int ix = int(x), iy = int(y), jx = min(ix + 1, w - 1), jy = min(iy + 1, h - 1);
    float dx = x - ix, dy = y - iy;
    return (1 - dy) * ((1 - dx) * p[iy * pitch + ix] + dx * p[iy * pitch + jx]) +
           dy * ((1 - dx) * p[jy * pitch + ix] + dx * p[jy * pitch + jx]);
}
__global__ void colour(const unsigned char* p, size_t pitch, cudaSurfaceObject_t out,
                       ImageConversion c) {
    int x = int(blockIdx.x * blockDim.x + threadIdx.x),
        y = int(blockIdx.y * blockDim.y + threadIdx.y);
    if (x >= c.width || y >= c.height)
        return;
    float sx = float(x), sy = float(y);
    if (c.undistort) {
        float nx = (sx - c.cx) / c.fx, ny = (sy - c.cy) / c.fy, r2 = nx * nx + ny * ny;
        float k =
            1 + c.distortion[0] * r2 + c.distortion[1] * r2 * r2 + c.distortion[4] * r2 * r2 * r2;
        sx =
            c.fx * (nx * k + 2 * c.distortion[2] * nx * ny + c.distortion[3] * (r2 + 2 * nx * nx)) +
            c.cx;
        sy =
            c.fy * (ny * k + c.distortion[2] * (r2 + 2 * ny * ny) + 2 * c.distortion[3] * nx * ny) +
            c.cy;
    }
    // Intrinsics/distortion describe the unmirrored camera. Encoded-image flips
    // transform the distorted source coordinate immediately before sampling.
    if (c.flip_x)
        sx = c.width - 1 - sx;
    if (c.flip_y)
        sy = c.height - 1 - sy;
    if (!isfinite(sx) || !isfinite(sy) || sx < 0 || sy < 0 || sx > c.width - 1 ||
        sy > c.height - 1) {
        surf2Dwrite(make_uchar4(0, 0, 0, 255), out, x * 4, y);
        return;
    }
    float yy = sample_y(p, pitch, sx, sy, c.width, c.height);
    int ux = min(int(sx) / 2, (c.width - 1) / 2) * 2, uy = min(int(sy) / 2, (c.height - 1) / 2);
    const unsigned char* uv = p + pitch * c.height;
    float u = float(uv[uy * pitch + ux]) - 128, v = float(uv[uy * pitch + ux + 1]) - 128;
    float l = c.full_range ? yy : 1.16438356f * (yy - 16);
    float r = l + (c.bt709 ? 1.792741f : 1.596027f) * v;
    float g = l - (c.bt709 ? 0.213249f : 0.391762f) * u - (c.bt709 ? 0.532909f : 0.812968f) * v;
    float b = l + (c.bt709 ? 2.112402f : 2.017232f) * u;
    if (c.full_range) {
        r = yy + (c.bt709 ? 1.5748f : 1.402f) * v;
        g = yy - (c.bt709 ? 0.187324f : 0.344136f) * u - (c.bt709 ? 0.468124f : 0.714136f) * v;
        b = yy + (c.bt709 ? 1.8556f : 1.772f) * u;
    }
    surf2Dwrite(make_uchar4((unsigned char)fminf(255, fmaxf(0, r)),
                            (unsigned char)fminf(255, fmaxf(0, g)),
                            (unsigned char)fminf(255, fmaxf(0, b)), 255),
                out, x * 4, y);
}
cudaError_t convert_nv12(const unsigned char* p, size_t pitch, cudaSurfaceObject_t out,
                         const ImageConversion& config, cudaStream_t stream) {
    colour<<<dim3((config.width + 15) / 16, (config.height + 15) / 16), dim3(16, 16), 0, stream>>>(
        p, pitch, out, config);
    return cudaGetLastError();
}
