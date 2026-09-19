#include "ceres/stereo.hpp"
#include <cmath>
#include <iostream>
#include <limits>
#include <stdexcept>

namespace {
void expect(bool value, const char* message) {
    if (!value)
        throw std::runtime_error(message);
}
void near(double a, double b, const char* message, double tolerance = 1e-8) {
    expect(std::abs(a - b) < tolerance, message);
}
template <typename F> void rejects(F&& f, const char* message) {
    try {
        f();
    } catch (const std::exception&) {
        return;
    }
    throw std::runtime_error(message);
}
ceres::StereoCalibration measured() {
    ceres::StereoCalibration profile;
    profile.name = "Measured test rig";
    profile.measured = true;
    for (auto* camera : {&profile.left, &profile.right}) {
        camera->width = 640;
        camera->height = 480;
        camera->fx = camera->fy = 500;
        camera->cx = 319.5;
        camera->cy = 239.5;
        camera->rotation = {0, 0, 0, 1};
        camera->translation = {camera->side == "left" ? -0.06 : 0.06, 0, 0};
    }
    return profile;
}
} // namespace
int main() {
    try {
        ceres::StereoCalibration preset;
        rejects([&] { preset.validate(); },
                "Unlabelled unmeasured geometry must not enable reconstruction");
        const auto quest = ceres::StereoCalibration::quest();
        expect(!quest.measured && quest.preset_id == "quest3-stereo-v1",
               "Quest stereo preset must retain nominal provenance");
        expect(quest.left == ceres::Calibration::quest(640, 480, "left") &&
                   quest.right == ceres::Calibration::quest(640, 480, "right"),
               "Stereo preset must reuse the existing camera parameters");
        const auto quest_json = quest.to_json();
        expect(quest_json.at("version") == 1 && quest_json.at("measured") == false &&
                   quest_json.at("provenance").at("kind") == "nominal" &&
                   quest_json.at("provenance").at("version") == 1,
               "Nominal provenance must be explicit in recordings");
        const auto restored_quest = ceres::StereoCalibration::from_json(quest_json);
        expect(restored_quest.to_json() == quest_json, "Quest preset recording/replay roundtrip");
        const auto quest_rect = ceres::make_stereo_rectification(restored_quest);
        near(quest_rect.baseline_metres, .128, "Quest preset baseline reuses the mono offsets");
        near(quest_rect.fx, 320 / 1.62, "Quest preset intrinsics reuse the mono model");
        const auto scaled_quest = ceres::make_stereo_gpu_config(quest, 320, 320, 240, 640, 480);
        expect(scaled_quest.left.width == 320 && scaled_quest.right.width == 640,
               "Each nominal camera may be uniformly downscaled independently");
        near(scaled_quest.left.fx, quest.left.fx * .5, "Nominal focal length resampling", 1e-5);
        near(scaled_quest.left.cx, 159.75, "Nominal pixel-centre resampling");
        expect(quest.to_json() == quest_json, "GPU resizing must preserve recorded preset");
        for (int change = 0; change < 10; ++change) {
            auto bad = quest_json;
            switch (change) {
            case 0:
                bad["preset_id"] = "arbitrary-v1";
                break;
            case 1:
                bad["left"]["fx"] = quest.left.fx + 1;
                break;
            case 2:
                bad["left"]["cx"] = quest.left.cx + 1;
                break;
            case 3:
                bad["left"]["distortion"][0] = .01;
                break;
            case 4:
                bad["right"]["translation"][0] = .07;
                break;
            case 5:
                bad["right"]["rotation"][0] = .01;
                break;
            case 6:
                bad["left"]["flip_x"] = true;
                break;
            case 7:
                bad["provenance"]["kind"] = "factory";
                break;
            case 8:
                bad.erase("provenance");
                break;
            case 9:
                bad["measured"] = true;
                break;
            }
            rejects([&] { ceres::StereoCalibration::from_json(bad); },
                    "Changed nominal parameters or misleading provenance must be rejected");
        }
        rejects([&] { ceres::make_stereo_gpu_config(quest, 320, 640, 360, 640, 480); },
                "Aspect-changing preset resampling must be rejected");
        rejects([&] { ceres::make_stereo_gpu_config(quest, 320, 1280, 960, 640, 480); },
                "Uncalibrated preset upscaling must be rejected");
        rejects([&] { ceres::make_stereo_gpu_config(quest, 320, 319, 240, 640, 480); },
                "Odd decoded dimensions must be rejected");
        rejects([&] { ceres::StereoCalibration::quest(31, 24); },
                "Nominal preset dimensions require valid camera geometry");
        auto profile = measured();
        profile.validate();
        const auto roundtrip = ceres::StereoCalibration::from_json(profile.to_json());
        expect(roundtrip.left == profile.left && roundtrip.right == profile.right &&
                   roundtrip.measured && roundtrip.name == profile.name,
               "Stereo calibration roundtrip");
        expect(!profile.to_json().contains("preset_id") &&
                   !profile.to_json().contains("provenance"),
               "Existing measured JSON version 1 remains unchanged");
        const auto scaled_measured =
            ceres::make_stereo_gpu_config(profile, 320, 320, 240, 320, 240);
        near(scaled_measured.left.fx, 250, "Measured focal length resampling");
        near(scaled_measured.left.cx, 159.5, "Measured pixel-centre resampling");
        near(scaled_measured.left.cy, 119.5, "Measured pixel-centre vertical resampling");
        const auto rect = ceres::make_stereo_rectification(profile);
        expect(rect.width == 320 && rect.height == 240, "Bounded reconstruction dimensions");
        near(rect.fx, 250, "Scaled focal length");
        near(rect.baseline_metres, 0.12, "Metric baseline");
        const auto p = ceres::triangulate_stereo(rect, rect.cx, rect.cy, 15);
        expect(bool(p), "Valid disparity reconstructs");
        near((*p)[0], -0.06, "Left optical origin");
        near((*p)[1], 0, "Centre ray y");
        near((*p)[2], -2, "Forward is negative Z in metres");
        const auto upper = ceres::triangulate_stereo(rect, rect.cx + 25, rect.cy - 25, 15);
        near((*upper)[0], 0.14, "Pixel right is positive X");
        near((*upper)[1], 0.2, "Pixel up is positive Y");
        expect(!ceres::triangulate_stereo(rect, 0, 0, 0), "Zero disparity must be invalid");
        expect(!ceres::triangulate_stereo(rect, 0, 0, -1), "Negative disparity must be invalid");
        expect(!ceres::triangulate_stereo(rect, 0, 0, std::numeric_limits<double>::quiet_NaN()),
               "Nonfinite disparity must be invalid");
        const auto centre = ceres::stereo_source_pixel(profile.left, rect, true, rect.cx, rect.cy);
        near((*centre)[0], 319.5, "Rectification pixel centre x");
        near((*centre)[1], 239.5, "Rectification pixel centre y");
        auto camera = profile.left;
        camera.flip_x = camera.flip_y = true;
        const auto flipped =
            ceres::stereo_source_pixel(camera, rect, true, rect.cx + 10, rect.cy - 10);
        near((*flipped)[0], 299.5, "Horizontal encoded image flip");
        near((*flipped)[1], 259.5, "Vertical encoded image flip");
        camera = profile.left;
        camera.distortion = {0.1, 0, 0.01, 0.02, 0};
        const auto distorted =
            ceres::stereo_source_pixel(camera, rect, true, rect.cx + 25, rect.cy + 25);
        near((*distorted)[0], 370.1, "Brown radial and tangential x distortion");
        near((*distorted)[1], 290.0, "Brown radial and tangential y distortion");
        expect(!ceres::stereo_source_pixel(camera, rect, true, -10000, -10000),
               "Remap outside image is invalid");

        // Toe-in optical axes rectify to one horizontal baseline without changing depth.
        const double a = 0.04;
        profile.left.rotation = {0, std::sin(a), 0, std::cos(a)};
        profile.right.rotation = {0, -std::sin(a), 0, std::cos(a)};
        const auto toed = ceres::make_stereo_rectification(profile);
        near(toed.rect_to_head[0], 1, "Toe-in rectification baseline");
        const auto lp = ceres::stereo_source_pixel(profile.left, toed, true, toed.cx, toed.cy);
        const auto rp = ceres::stereo_source_pixel(profile.right, toed, false, toed.cx, toed.cy);
        near((*lp)[0], 319.5 + 500 * std::tan(2 * a), "Left inverse camera rotation");
        near((*rp)[0], 319.5 - 500 * std::tan(2 * a), "Right inverse camera rotation");
        near((*lp)[1], (*rp)[1], "Rectified epipolar row");

        profile = measured();
        // A rig translated and rolled in head space preserves scale and rotates its axes.
        const double angle = 0.2;
        const std::array<double, 3> origin{0.1, 0.2, 0.3};
        for (auto* c : {&profile.left, &profile.right}) {
            const double x = c->translation[0];
            c->translation = {origin[0] + x * std::cos(angle), origin[1] + x * std::sin(angle),
                              origin[2]};
            c->rotation = {0, 0, std::sin(angle / 2), std::cos(angle / 2)};
        }
        const auto rolled = ceres::make_stereo_rectification(profile);
        const auto transformed = ceres::triangulate_stereo(rolled, rolled.cx, rolled.cy, 15);
        near((*transformed)[0], 0.1 - 0.06 * std::cos(angle), "Head-space camera translation x");
        near((*transformed)[1], 0.2 - 0.06 * std::sin(angle), "Head-space camera translation y");
        near((*transformed)[2], -1.7, "Head-space camera translation z");
        const auto gpu = ceres::make_stereo_gpu_config(profile);
        near(gpu.baseline_metres, 0.12, "GPU config baseline", 1e-6);
        near(gpu.rect_to_head[3], std::sin(angle), "GPU row-major rectification", 1e-6);

        for (int change = 0; change < 9; ++change) {
            auto bad = measured();
            switch (change) {
            case 0:
                bad.version = 2;
                break;
            case 1:
                bad.measured = false;
                break;
            case 2:
                bad.left.side = "right";
                break;
            case 3:
                bad.right.translation = bad.left.translation;
                break;
            case 4:
                bad.right.translation[0] = -1;
                break;
            case 5:
                bad.left.fx = -1;
                break;
            case 6:
                bad.left.width = 641;
                break;
            case 7:
                bad.right.rotation = {0, 1, 0, 0};
                break;
            case 8:
                bad.name.clear();
                break;
            }
            rejects([&] { bad.validate(); }, "Malformed measured calibration accepted");
        }
        rejects([&] { ceres::make_stereo_rectification(measured(), 4096); },
                "Unbounded reconstruction width accepted");
        std::cout << "Stereo calibration, rectification and metric geometry tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
