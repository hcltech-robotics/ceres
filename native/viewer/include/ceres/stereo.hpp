#pragma once
#include "calibration.hpp"
#include "stereo_config.hpp"
#include <optional>

namespace ceres {
struct StereoCalibration {
    int version = 1;
    std::string name;
    bool measured = false;
    std::string preset_id;
    Calibration left = Calibration::quest(640, 480, "left");
    Calibration right = Calibration::quest(640, 480, "right");
    void validate() const;
    Json to_json() const;
    static StereoCalibration quest(int width = 640, int height = 480);
    static StereoCalibration from_json(const Json& value);
    static StereoCalibration load(const std::filesystem::path& path);
};

struct StereoRectification {
    int width = 0, height = 0;
    double fx = 0, fy = 0, cx = 0, cy = 0, baseline_metres = 0;
    // All matrices are row-major. The origin is the left camera optical centre.
    std::array<double, 9> rect_to_head{}, left_ray_to_camera{}, right_ray_to_camera{};
    std::array<double, 3> left_origin{};
};

StereoRectification make_stereo_rectification(const StereoCalibration& profile,
                                              int target_width = 320);
StereoGpuConfig make_stereo_gpu_config(const StereoCalibration& profile, int target_width = 320);
StereoGpuConfig make_stereo_gpu_config(const StereoCalibration& profile, int target_width,
                                       int left_width, int left_height, int right_width,
                                       int right_height);
std::optional<std::array<double, 3>> triangulate_stereo(const StereoRectification& rect, double u,
                                                        double v, double disparity);
// Source pixel coordinates before sampling. Missing means outside the calibrated image.
std::optional<std::array<double, 2>> stereo_source_pixel(const Calibration& camera,
                                                         const StereoRectification& rect, bool left,
                                                         double u, double v);
} // namespace ceres
