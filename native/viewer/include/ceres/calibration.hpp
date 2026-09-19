#pragma once
#include "types.hpp"
#include <array>
#include <filesystem>
namespace ceres {
struct Calibration {
    std::string name = "Quest 3 preset", side = "right";
    int width = 640, height = 480;
    double fx = 640.0 / 1.62, fy = 640.0 / 1.62, cx = 320, cy = 240;
    std::array<double, 5> distortion{};
    std::array<double, 3> translation{0.064, -0.03, -0.035};
    std::array<double, 4> rotation{0, 0.052335956, 0, 0.998629535};
    bool flip_x = false, flip_y = false;
    bool operator==(const Calibration&) const = default;
    static Calibration quest(int width, int height, const std::string& side);
    static Calibration from_json(const Json& value);
    Json to_json() const;
    static Calibration load(const std::filesystem::path& path);
    void validate() const;
};
} // namespace ceres
