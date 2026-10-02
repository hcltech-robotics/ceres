#include <metal_stdlib>
#include "ceres/image_conversion.hpp"
using namespace metal;

// Integer texel reads reconstruct the source bytes exactly; hardware texture
// filtering would change the CUDA contract's bilinear-luma/nearest-chroma rules.
float sample_y(texture2d<float, access::read> image, float x, float y, int w, int h) {
    x = clamp(x, 0.0f, float(w - 1));
    y = clamp(y, 0.0f, float(h - 1));
    int ix = int(x), iy = int(y), jx = min(ix + 1, w - 1), jy = min(iy + 1, h - 1);
    float dx = x - ix, dy = y - iy;
    float a = round(image.read(uint2(ix, iy)).r * 255.0f);
    float b = round(image.read(uint2(jx, iy)).r * 255.0f);
    float c = round(image.read(uint2(ix, jy)).r * 255.0f);
    float d = round(image.read(uint2(jx, jy)).r * 255.0f);
    return (1 - dy) * ((1 - dx) * a + dx * b) + dy * ((1 - dx) * c + dx * d);
}

kernel void convert_nv12(texture2d<float, access::read> luma [[texture(0)]],
                         texture2d<float, access::read> chroma [[texture(1)]],
                         texture2d<float, access::write> output [[texture(2)]],
                         constant ImageConversion& c [[buffer(0)]],
                         uint2 pixel [[thread_position_in_grid]]) {
    if (pixel.x >= uint(c.width) || pixel.y >= uint(c.height))
        return;
    float sx = float(pixel.x), sy = float(pixel.y);
    if (c.undistort) {
        float nx = (sx - c.cx) / c.fx, ny = (sy - c.cy) / c.fy, r2 = nx * nx + ny * ny;
        float k = 1 + c.distortion[0] * r2 + c.distortion[1] * r2 * r2 +
                  c.distortion[4] * r2 * r2 * r2;
        sx = c.fx * (nx * k + 2 * c.distortion[2] * nx * ny +
                     c.distortion[3] * (r2 + 2 * nx * nx)) + c.cx;
        sy = c.fy * (ny * k + c.distortion[2] * (r2 + 2 * ny * ny) +
                     2 * c.distortion[3] * nx * ny) + c.cy;
    }
    // Camera calibration is unmirrored; flip the distorted source coordinates.
    if (c.flip_x)
        sx = c.width - 1 - sx;
    if (c.flip_y)
        sy = c.height - 1 - sy;
    if (!isfinite(sx) || !isfinite(sy) || sx < 0 || sy < 0 || sx > c.width - 1 ||
        sy > c.height - 1) {
        output.write(float4(0, 0, 0, 1), pixel);
        return;
    }
    float yy = sample_y(luma, sx, sy, c.width, c.height);
    uint2 uv = uint2(min(int(sx) / 2, (c.width - 1) / 2),
                     min(int(sy) / 2, (c.height - 1) / 2));
    float2 colour = round(chroma.read(uv).rg * 255.0f) - 128;
    float u = colour.x, v = colour.y;
    float l = c.full_range ? yy : 1.16438356f * (yy - 16);
    float r = l + (c.bt709 ? 1.792741f : 1.596027f) * v;
    float g = l - (c.bt709 ? 0.213249f : 0.391762f) * u -
              (c.bt709 ? 0.532909f : 0.812968f) * v;
    float b = l + (c.bt709 ? 2.112402f : 2.017232f) * u;
    if (c.full_range) {
        r = yy + (c.bt709 ? 1.5748f : 1.402f) * v;
        g = yy - (c.bt709 ? 0.187324f : 0.344136f) * u -
                 (c.bt709 ? 0.468124f : 0.714136f) * v;
        b = yy + (c.bt709 ? 1.8556f : 1.772f) * u;
    }
    // CUDA truncates each clamped channel to a byte before writing the surface.
    output.write(float4(floor(clamp(float3(r, g, b), 0.0f, 255.0f)) / 255.0f, 1), pixel);
}
