#include "ceres/app.hpp"
#include <cmath>
#include <iostream>
#include <stdexcept>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif
namespace {
void report_error(const char* message) {
    std::cerr << "Ceres viewer: " << message << '\n';
#ifdef _WIN32
    const auto standard_error = GetStdHandle(STD_ERROR_HANDLE);
    bool missing_output = standard_error == nullptr || standard_error == INVALID_HANDLE_VALUE;
    if (!missing_output) {
        SetLastError(NO_ERROR);
        missing_output =
            GetFileType(standard_error) == FILE_TYPE_UNKNOWN && GetLastError() != NO_ERROR;
    }
    if (missing_output)
        MessageBoxA(nullptr, message, "Ceres viewer", MB_OK | MB_ICONERROR | MB_TASKMODAL);
#endif
}
} // namespace
int main(int argc, char** argv) {
    try {
        ceres::AppOptions options;
        for (int i = 1; i < argc; ++i) {
            std::string a = argv[i];
            auto value = [&]() -> std::string {
                if (++i >= argc)
                    throw std::runtime_error("Missing value for " + a);
                return argv[i];
            };
            if (a == "--fixture")
                options.fixture = true;
            else if (a == "--fixture-depth")
                options.fixture_depth = true;
            else if (a == "--no-connect")
                options.connect = false;
            else if (a == "--no-vsync")
                options.vsync = false;
            else if (a == "--borderless")
                options.borderless = true;
            else if (a == "--hidden")
                options.hidden = true;
            else if (a == "--replay")
                options.replay = value();
            else if (a == "--record")
                options.record = value();
            else if (a == "--fixture-video")
                options.fixture_video = value();
            else if (a == "--screenshot")
                options.screenshot = value();
            else if (a == "--metrics")
                options.metrics = value();
            else if (a == "--config-dir")
                options.config = value();
            else if (a == "--map-directory")
                options.map_directory = value();
            else if (a == "--load-map")
                options.map_load = value();
            else if (a == "--freeze-map-after")
                options.freeze_map_after = std::stod(value());
            else if (a == "--task-spec")
                options.task_specification = value();
            else if (a == "--export-helper")
                options.helper = value();
            else if (a == "--ffmpeg")
                options.ffmpeg = value();
            else if (a == "--origin")
                options.origin = value();
            else if (a == "--ca-cert")
                options.ca_certificate = value();
            else if (a == "--seconds")
                options.seconds = std::stod(value());
            else if (a == "--fps")
                options.fps = std::stod(value());
            else if (a == "--version") {
            std::cout << "Ceres viewer " CERES_VIEWER_VERSION << '\n';
                return 0;
            }
            else if (a == "--width")
                options.width = std::stoi(value());
            else if (a == "--height")
                options.height = std::stoi(value());
            else if (a == "--help") {
                std::cout
                    << "Ceres viewer\n  --origin URL --replay FILE --record FILE\n  --fixture "
                       "[--fixture-depth] [--fixture-video H264] --seconds N\n  --width N --height N --no-vsync "
                       "--fps N --no-connect --borderless --hidden\n  --screenshot FILE.ppm --metrics "
                       "FILE.json --config-dir DIRECTORY\n  --task-spec FILE.json-or-URL\n"
                       "  --map-directory DIRECTORY --load-map FILE.cmap --freeze-map-after SECONDS\n"
                       "  --export-helper FILE --ffmpeg FILE\n"
                       "  --ca-cert FILE.pem (overrides SSL_CERT_FILE for Bridge TLS)\n";
                return 0;
            } else
                throw std::runtime_error("Unknown argument: " + a);
        }
        if (options.fixture_depth && !options.fixture)
            throw std::runtime_error("--fixture-depth requires --fixture");
        if (options.width < 320 || options.height < 240 || !std::isfinite(options.seconds) ||
            options.seconds < 0 || !(options.fps >= 1 && options.fps <= 1000) ||
            !std::isfinite(options.freeze_map_after) || options.freeze_map_after < -1)
            throw std::runtime_error("Invalid window dimensions, duration or frame rate");
        return ceres::run_app(options);
    } catch (const std::exception& e) {
        report_error(e.what());
        return 1;
    }
}
