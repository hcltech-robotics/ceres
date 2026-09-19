#pragma once
#include <filesystem>
#include <string>
namespace ceres {
struct AppOptions {
    bool fixture = false, fixture_depth = false, connect = true, vsync = true,
         borderless = false, hidden = false;
    int width = 1920, height = 1080;
    double seconds = 0, fps = 120, freeze_map_after = -1;
    std::filesystem::path replay, record, fixture_video, screenshot, metrics, helper, ffmpeg,
        config, map_directory, map_load;
    std::string task_specification;
    std::string origin = "https://ceres.cam";
};
int run_app(const AppOptions& options);
} // namespace ceres
