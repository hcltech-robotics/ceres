#include "ceres/calibration.hpp"
#include <cmath>
#include <fstream>
#include <stdexcept>
namespace ceres {
Calibration Calibration::quest(int w, int h, const std::string& s) {
    Calibration c;
    c.width = w;
    c.height = h;
    c.side = s;
    c.fx = c.fy = w / 1.62;
    c.cx = w / 2.0;
    c.cy = h / 2.0;
    c.translation[0] = s == "left" ? -0.064 : 0.064;
    c.rotation[1] = std::sin((s == "left" ? -1.0 : 1.0) * 3.0 * 3.141592653589793 / 180.0);
    c.validate();
    return c;
}
void Calibration::validate() const {
    if (width <= 0 || height <= 0 || width > 8192 || height > 8192 || !std::isfinite(fx) ||
        !std::isfinite(fy) || fx <= 0 || fy <= 0 || !std::isfinite(cx) || !std::isfinite(cy))
        throw std::runtime_error("Invalid camera intrinsics");
    if (side != "left" && side != "right" && side != "unknown")
        throw std::runtime_error("Invalid camera side");
    for (auto x : distortion)
        if (!std::isfinite(x))
            throw std::runtime_error("Invalid distortion coefficient");
    for (auto x : translation)
        if (!std::isfinite(x))
            throw std::runtime_error("Invalid camera translation");
    double norm = 0;
    for (auto x : rotation) {
        if (!std::isfinite(x))
            throw std::runtime_error("Invalid camera rotation");
        norm += x * x;
    }
    if (std::abs(norm - 1.0) > 0.01)
        throw std::runtime_error("Camera rotation must be a unit XYZW quaternion");
}
Json Calibration::to_json() const {
    return {{"version", 1},
            {"name", name},
            {"side", side},
            {"width", width},
            {"height", height},
            {"fx", fx},
            {"fy", fy},
            {"cx", cx},
            {"cy", cy},
            {"distortion", distortion},
            {"translation", translation},
            {"rotation", rotation},
            {"flip_x", flip_x},
            {"flip_y", flip_y}};
}
Calibration Calibration::from_json(const Json& j) {
    if (j.at("version").get<int>() != 1)
        throw std::runtime_error("Unsupported calibration version");
    Calibration c;
    c.name = j.at("name");
    c.side = j.at("side");
    c.width = j.at("width");
    c.height = j.at("height");
    c.fx = j.at("fx");
    c.fy = j.at("fy");
    c.cx = j.at("cx");
    c.cy = j.at("cy");
    c.distortion = j.value("distortion", c.distortion);
    c.translation = j.at("translation").get<std::array<double, 3>>();
    c.rotation = j.at("rotation").get<std::array<double, 4>>();
    c.flip_x = j.value("flip_x", false);
    c.flip_y = j.value("flip_y", false);
    c.validate();
    return c;
}
Calibration Calibration::load(const std::filesystem::path& path) {
    std::ifstream f(path);
    if (!f)
        throw std::runtime_error("Cannot open calibration profile");
    Json j;
    f >> j;
    return from_json(j);
}
} // namespace ceres
