#include "ceres/calibration.hpp"
#include <cmath>
#include <iostream>
#include <stdexcept>
static void check(bool v) {
    if (!v)
        throw std::runtime_error("Geometry test failed");
}
int main() {
    try {
        auto l = ceres::Calibration::quest(640, 480, "left"),
             r = ceres::Calibration::quest(640, 480, "right");
        check(l.translation[0] == -r.translation[0]);
        check(l.rotation[1] == -r.rotation[1]);
        check(std::abs((640 - l.cx) / l.fx - 0.81) < 1e-9);
        auto b = ceres::Calibration::from_json(l.to_json());
        check(b.translation == l.translation);
        auto j = l.to_json();
        j["fx"] = 0;
        bool rejected = false;
        try {
            ceres::Calibration::from_json(j);
        } catch (...) {
            rejected = true;
        }
        check(rejected);
        check(ceres::joint_parents[24] == 23 && ceres::joint_parents[0] == -1);
        std::cout << "Geometry tests passed\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
