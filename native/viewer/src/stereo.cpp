#include "ceres/stereo.hpp"
#include <algorithm>
#include <cmath>
#include <fstream>
#include <stdexcept>

namespace ceres {
namespace {
using V3 = std::array<double, 3>;
using M3 = std::array<double, 9>;
double dot(const V3& a, const V3& b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
V3 cross(const V3& a, const V3& b) {
    return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
}
V3 normalise(V3 v) {
    const double length = std::sqrt(dot(v, v));
    if (!std::isfinite(length) || length < 1e-8)
        throw std::runtime_error("Stereo camera geometry is degenerate");
    for (auto& value : v)
        value /= length;
    return v;
}
M3 rotation(const Calibration& c) {
    double x = c.rotation[0], y = c.rotation[1], z = c.rotation[2], w = c.rotation[3];
    const double n = std::sqrt(x * x + y * y + z * z + w * w);
    x /= n;
    y /= n;
    z /= n;
    w /= n;
    return {1 - 2 * (y * y + z * z), 2 * (x * y - z * w),     2 * (x * z + y * w),
            2 * (x * y + z * w),     1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
            2 * (x * z - y * w),     2 * (y * z + x * w),     1 - 2 * (x * x + y * y)};
}
V3 multiply(const M3& m, const V3& v) {
    return {m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
            m[6] * v[0] + m[7] * v[1] + m[8] * v[2]};
}
M3 transpose_multiply(const M3& a, const M3& b) {
    M3 result{};
    for (int row = 0; row < 3; ++row)
        for (int col = 0; col < 3; ++col)
            for (int k = 0; k < 3; ++k)
                result[row * 3 + col] += a[k * 3 + row] * b[k * 3 + col];
    return result;
}
void validate_camera(const Calibration& c, const char* side) {
    c.validate();
    if (c.side != side || c.width < 32 || c.height < 32 || c.width % 2 || c.height % 2)
        throw std::runtime_error("Stereo calibration requires labelled left/right NV12 dimensions");
    if (c.fx < c.width * 0.1 || c.fx > c.width * 8 || c.fy < c.height * 0.1 ||
        c.fy > c.height * 8 || c.cx < -0.25 * c.width || c.cx > 1.25 * c.width ||
        c.cy < -0.25 * c.height || c.cy > 1.25 * c.height)
        throw std::runtime_error("Stereo calibration has implausible intrinsics");
    if (dot(c.translation, c.translation) > 1)
        throw std::runtime_error("Stereo optical centres must be within one metre of the head");
    for (double coefficient : c.distortion)
        if (std::abs(coefficient) > 100)
            throw std::runtime_error("Stereo calibration has implausible distortion");
}
StereoGpuCamera gpu_camera(const Calibration& c, const M3& transform) {
    StereoGpuCamera out{};
    out.width = c.width;
    out.height = c.height;
    out.fx = float(c.fx);
    out.fy = float(c.fy);
    out.cx = float(c.cx);
    out.cy = float(c.cy);
    out.flip_x = c.flip_x;
    out.flip_y = c.flip_y;
    std::transform(c.distortion.begin(), c.distortion.end(), out.distortion,
                   [](double x) { return float(x); });
    std::transform(transform.begin(), transform.end(), out.ray_to_camera,
                   [](double x) { return float(x); });
    return out;
}
bool quest_geometry(const Calibration& camera) {
    const auto expected = Calibration::quest(camera.width, camera.height, camera.side);
    const auto same = [](double a, double b) {
        return std::abs(a - b) <= 1e-10 * std::max({1.0, std::abs(a), std::abs(b)});
    };
    if (camera.flip_x != expected.flip_x || camera.flip_y != expected.flip_y ||
        !same(camera.fx, expected.fx) || !same(camera.fy, expected.fy) ||
        !same(camera.cx, expected.cx) || !same(camera.cy, expected.cy))
        return false;
    for (size_t i = 0; i < camera.distortion.size(); ++i)
        if (!same(camera.distortion[i], expected.distortion[i]))
            return false;
    for (size_t i = 0; i < camera.translation.size(); ++i)
        if (!same(camera.translation[i], expected.translation[i]))
            return false;
    for (size_t i = 0; i < camera.rotation.size(); ++i)
        if (!same(camera.rotation[i], expected.rotation[i]))
            return false;
    return true;
}
Json quest_provenance() {
    return {{"kind", "nominal"}, {"version", 1}, {"source", "ceres-viewer/Calibration::quest"}};
}
void scale_camera(StereoGpuCamera& output, const Calibration& camera, int width, int height) {
    if (width < 32 || height < 32 || width % 2 || height % 2 || width > camera.width ||
        height > camera.height)
        throw std::runtime_error("Stereo " + camera.side +
                                 " camera requires even decoded dimensions within its calibration");
    const double sx = double(width) / camera.width, sy = double(height) / camera.height;
    if (std::abs(width - camera.width * sy) > 1 || std::abs(height - camera.height * sx) > 1)
        throw std::runtime_error("Stereo " + camera.side +
                                 " image aspect ratio changed. Load matching calibration");
    output.width = width;
    output.height = height;
    output.fx = float(camera.fx * sx);
    output.fy = float(camera.fy * sy);
    output.cx = float((camera.cx + .5) * sx - .5);
    output.cy = float((camera.cy + .5) * sy - .5);
}
} // namespace

StereoCalibration StereoCalibration::quest(int width, int height) {
    StereoCalibration profile;
    profile.name = "Quest 3 stereo preset";
    profile.preset_id = "quest3-stereo-v1";
    profile.left = Calibration::quest(width, height, "left");
    profile.right = Calibration::quest(width, height, "right");
    profile.validate();
    return profile;
}
void StereoCalibration::validate() const {
    if (version != 1)
        throw std::runtime_error("Unsupported stereo calibration version");
    if (name.empty() || name.size() > 128)
        throw std::runtime_error("Stereo calibration requires a name");
    validate_camera(left, "left");
    validate_camera(right, "right");
    if (!measured &&
        (preset_id != "quest3-stereo-v1" || !quest_geometry(left) || !quest_geometry(right)))
        throw std::runtime_error("Use the Quest stereo preset or measured stereo calibration");
    if (measured && !preset_id.empty())
        throw std::runtime_error("A nominal stereo preset cannot be marked measured");
    V3 baseline{};
    for (int i = 0; i < 3; ++i)
        baseline[i] = right.translation[i] - left.translation[i];
    const double length = std::sqrt(dot(baseline, baseline));
    if (length < 0.01 || length > 0.4 || baseline[0] / length < 0.5)
        throw std::runtime_error("Stereo baseline must be 0.01 to 0.4 metres from left to right");
    const auto lf = multiply(rotation(left), {0, 0, -1});
    const auto rf = multiply(rotation(right), {0, 0, -1});
    const auto forward = normalise({lf[0] + rf[0], lf[1] + rf[1], lf[2] + rf[2]});
    if (dot(lf, rf) < 0.5 || std::abs(dot(normalise(baseline), forward)) > 0.25)
        throw std::runtime_error("Stereo cameras require overlapping forward views");
}
Json StereoCalibration::to_json() const {
    Json value{{"version", version},
               {"name", name},
               {"measured", measured},
               {"left", left.to_json()},
               {"right", right.to_json()}};
    if (!preset_id.empty()) {
        value["preset_id"] = preset_id;
        value["provenance"] = quest_provenance();
    }
    return value;
}
StereoCalibration StereoCalibration::from_json(const Json& value) {
    StereoCalibration profile;
    profile.version = value.at("version").get<int>();
    profile.name = value.at("name").get<std::string>();
    profile.measured = value.value("measured", false);
    profile.preset_id = value.value("preset_id", std::string{});
    if (!profile.preset_id.empty() && value.value("provenance", Json()) != quest_provenance())
        throw std::runtime_error("Invalid nominal stereo preset provenance");
    profile.left = Calibration::from_json(value.at("left"));
    profile.right = Calibration::from_json(value.at("right"));
    profile.validate();
    return profile;
}
StereoCalibration StereoCalibration::load(const std::filesystem::path& path) {
    std::ifstream file(path);
    if (!file)
        throw std::runtime_error("Cannot open stereo calibration profile");
    Json value;
    file >> value;
    return from_json(value);
}

StereoRectification make_stereo_rectification(const StereoCalibration& profile, int target_width) {
    profile.validate();
    if (target_width < 64 || target_width > stereo_max_width)
        throw std::runtime_error("Stereo reconstruction width must be 64 to 384 pixels");
    StereoRectification out;
    const auto left_r = rotation(profile.left), right_r = rotation(profile.right);
    V3 baseline{};
    for (int i = 0; i < 3; ++i)
        baseline[i] = profile.right.translation[i] - profile.left.translation[i];
    out.baseline_metres = std::sqrt(dot(baseline, baseline));
    const auto x = normalise(baseline);
    const auto lf = multiply(left_r, {0, 0, -1}), rf = multiply(right_r, {0, 0, -1});
    V3 z{-lf[0] - rf[0], -lf[1] - rf[1], -lf[2] - rf[2]};
    const double along_baseline = dot(z, x);
    for (int i = 0; i < 3; ++i)
        z[i] -= along_baseline * x[i];
    z = normalise(z);
    const auto y = normalise(cross(z, x));
    out.rect_to_head = {x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]};
    out.left_ray_to_camera = transpose_multiply(left_r, out.rect_to_head);
    out.right_ray_to_camera = transpose_multiply(right_r, out.rect_to_head);
    out.left_origin = profile.left.translation;
    const double scale = std::min(double(target_width) / profile.left.width,
                                  double(stereo_max_height) / profile.left.height);
    out.width = std::max(32, int(profile.left.width * scale) / 2 * 2);
    out.height = std::max(32, int(profile.left.height * scale) / 2 * 2);
    out.fx = std::min(profile.left.fx * out.width / profile.left.width,
                      profile.right.fx * out.width / profile.right.width);
    out.fy = std::min(profile.left.fy * out.height / profile.left.height,
                      profile.right.fy * out.height / profile.right.height);
    out.cx = (out.width - 1) * 0.5;
    out.cy = (out.height - 1) * 0.5;
    return out;
}

StereoGpuConfig make_stereo_gpu_config(const StereoCalibration& profile, int target_width) {
    const auto rect = make_stereo_rectification(profile, target_width);
    StereoGpuConfig out;
    out.width = rect.width;
    out.height = rect.height;
    out.fx = float(rect.fx);
    out.fy = float(rect.fy);
    out.cx = float(rect.cx);
    out.cy = float(rect.cy);
    out.baseline_metres = float(rect.baseline_metres);
    std::transform(rect.rect_to_head.begin(), rect.rect_to_head.end(), out.rect_to_head,
                   [](double x) { return float(x); });
    std::transform(rect.left_origin.begin(), rect.left_origin.end(), out.left_origin,
                   [](double x) { return float(x); });
    out.left = gpu_camera(profile.left, rect.left_ray_to_camera);
    out.right = gpu_camera(profile.right, rect.right_ray_to_camera);
    return out;
}
StereoGpuConfig make_stereo_gpu_config(const StereoCalibration& profile, int target_width,
                                       int left_width, int left_height, int right_width,
                                       int right_height) {
    auto config = make_stereo_gpu_config(profile, target_width);
    scale_camera(config.left, profile.left, left_width, left_height);
    scale_camera(config.right, profile.right, right_width, right_height);
    return config;
}

std::optional<std::array<double, 3>> triangulate_stereo(const StereoRectification& rect, double u,
                                                        double v, double disparity) {
    if (!std::isfinite(u) || !std::isfinite(v) || !std::isfinite(disparity) || disparity <= 0 ||
        rect.fx <= 0 || rect.fy <= 0 || rect.baseline_metres <= 0)
        return std::nullopt;
    const double depth = rect.fx * rect.baseline_metres / disparity;
    auto point = multiply(rect.rect_to_head, {(u - rect.cx) * depth / rect.fx,
                                              -(v - rect.cy) * depth / rect.fy, -depth});
    for (int i = 0; i < 3; ++i) {
        point[i] += rect.left_origin[i];
        if (!std::isfinite(point[i]))
            return std::nullopt;
    }
    return point;
}

std::optional<std::array<double, 2>> stereo_source_pixel(const Calibration& camera,
                                                         const StereoRectification& rect, bool left,
                                                         double u, double v) {
    const auto ray = multiply(left ? rect.left_ray_to_camera : rect.right_ray_to_camera,
                              {(u - rect.cx) / rect.fx, -(v - rect.cy) / rect.fy, -1});
    if (!std::isfinite(ray[2]) || ray[2] >= -1e-8)
        return std::nullopt;
    const double x = -ray[0] / ray[2], y = ray[1] / ray[2], r2 = x * x + y * y;
    const auto& d = camera.distortion;
    const double k = 1 + d[0] * r2 + d[1] * r2 * r2 + d[4] * r2 * r2 * r2;
    double sx = camera.fx * (x * k + 2 * d[2] * x * y + d[3] * (r2 + 2 * x * x)) + camera.cx;
    double sy = camera.fy * (y * k + d[2] * (r2 + 2 * y * y) + 2 * d[3] * x * y) + camera.cy;
    if (camera.flip_x)
        sx = camera.width - 1 - sx;
    if (camera.flip_y)
        sy = camera.height - 1 - sy;
    if (!std::isfinite(sx) || !std::isfinite(sy) || sx < 0 || sy < 0 || sx > camera.width - 1 ||
        sy > camera.height - 1)
        return std::nullopt;
    return std::array<double, 2>{sx, sy};
}
} // namespace ceres
