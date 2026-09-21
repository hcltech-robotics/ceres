#include "ceres/app.hpp"
#include "ceres/depth_display.hpp"
#include "ceres/depth.hpp"
#include "ceres/hand_mask.hpp"
#include "ceres/bridge.hpp"
#include "ceres/detail/accordion_motion.hpp"
#include "ceres/detail/hand_presentation.hpp"
#include "ceres/detail/recording_bar.hpp"
#include "ceres/detail/stereo_cadence.hpp"
#include "ceres/detail/stereo_pairing.hpp"
#include "ceres/stereo.hpp"
#include "ceres/export_job.hpp"
#include "ceres/hugging_face.hpp"
#include "ceres/mesh.hpp"
#include "ceres/protocol.hpp"
#include "ceres/renderer.hpp"
#include "ceres/session.hpp"
#include "ceres/spatial_map.hpp"
#include "ceres/voxel_config.hpp"
#include "ceres/task_specification.hpp"
#include "ceres/replay_task.hpp"
#include "ceres/ui.hpp"
#include <GLFW/glfw3.h>
#include <algorithm>
#include <atomic>
#include <bit>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <fstream>
#include <future>
#include <glad/gl.h>
#include <glm/gtc/matrix_transform.hpp>
#include <glm/gtx/euler_angles.hpp>
#include <imgui.h>
#include <imgui_impl_glfw.h>
#include <imgui_impl_opengl3.h>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <mutex>
#include <optional>
#include <qrcodegen.hpp>
#include <sstream>
#include <thread>
#include <tuple>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace ceres {
namespace {
bool recording_marker(const SessionEvent& event) {
    if (event.kind != EventKind::Epoch)
        return false;
    const auto reason = event.attributes.find("reason");
    return reason != event.attributes.end() && reason->is_string() &&
           (*reason == "record-start" || *reason == "record-pause" || *reason == "record-resume");
}
std::filesystem::path config_directory() {
#ifdef _WIN32
    const char* base = std::getenv("LOCALAPPDATA");
    auto p = (base ? std::filesystem::path(base) : std::filesystem::temp_directory_path()) /
             "Ceres viewer";
#else
    const char *xdg = std::getenv("XDG_CONFIG_HOME"), *home = std::getenv("HOME");
    auto p =
        (xdg ? std::filesystem::path(xdg) : std::filesystem::path(home ? home : ".") / ".config") /
        "ceres-viewer";
#endif
    std::filesystem::create_directories(p);
    return p;
}
std::filesystem::path data_directory() {
#ifdef _WIN32
    return "D:/data/ceres-viewer";
#else
    const char* home = std::getenv("HOME");
    return std::filesystem::path(home ? home : ".") / "ceres-viewer";
#endif
}
std::filesystem::path application_directory() {
#ifdef _WIN32
    std::wstring path(32768, L'\0');
    auto size = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
    if (size && size < path.size()) {
        path.resize(size);
        return std::filesystem::path(path).parent_path();
    }
#else
    std::string path(4096, '\0');
    auto size = readlink("/proc/self/exe", path.data(), path.size());
    if (size > 0 && static_cast<size_t>(size) < path.size()) {
        path.resize(static_cast<size_t>(size));
        return std::filesystem::path(path).parent_path();
    }
#endif
    return std::filesystem::current_path();
}
enum class PaneSection { none = -1, connection, hands, depth, task, recording, replay, publish, telemetry, calibration, scene };
enum class ReplayLocation { hugging_face, local_file };
struct Preferences {
    Calibration calibration = Calibration::quest(640, 480, "right");
    ViewOptions view;
    std::optional<StereoCalibration> stereo = StereoCalibration::quest(640, 480);
    std::string stereo_path;
    bool custom_calibration = false, panels = true, preview = false;
    PaneSection section = PaneSection::connection;
    std::string profile_path;
    std::filesystem::path data_path = data_directory();
    std::filesystem::path recording_destination = data_path / "sessions";
    std::filesystem::path map_directory, last_map;
    std::uint64_t map_max_bytes = spatial_map_default_max_bytes;
    std::string task_description, task_specification_path;
    std::string hf_organisation, hf_repository, hf_folder;
    ReplayLocation replay_location = ReplayLocation::hugging_face;
    std::string replay_repository = "hf:chrisvoncsefalvay/ceres-demos";
    std::optional<TaskSpecification> task_specification;
    Json to_json() const {
        return {
            {"schema", "ceres-viewer-preferences"},
            {"version", 1},
            {"data_directory", data_path.string()},
            {"recording_destination", recording_destination.string()},
            {"spatial_map", {{"directory", map_directory.string()}, {"last_file", last_map.string()},
                              {"max_bytes", map_max_bytes}}},
            {"hugging_face", {{"organisation", hf_organisation}, {"repository", hf_repository},
                              {"folder", hf_folder}}},
            {"replay", {{"source", replay_location == ReplayLocation::hugging_face ? "hugging_face" : "local_file"},
                         {"repository", replay_repository}}},
            {"task",
             {{"description", task_description},
              {"path", task_specification_path},
              {"specification", task_specification ? task_specification->to_json() : Json()}}},
            {"stereo", {{"profile", stereo ? stereo->to_json() : Json()}, {"path", stereo_path}}},
            {"sections",
             {{"connection", section == PaneSection::connection},
               {"hands", section == PaneSection::hands},
               {"depth", section == PaneSection::depth},
               {"scene", section == PaneSection::scene},
              {"task", section == PaneSection::task},
               {"recording", section == PaneSection::recording},
               {"replay", section == PaneSection::replay},
               {"publish", section == PaneSection::publish},
              {"telemetry", section == PaneSection::telemetry},
              {"calibration", section == PaneSection::calibration}}},
            {"calibration",
             {{"custom", custom_calibration},
              {"profile_path", profile_path},
              {"profile", calibration.to_json()}}},
            {"view",
             {{"hands_visible", view.hands},
               {"trails_visible", view.trails},
               {"hand_level", static_cast<int>(view.hand_level)},
              {"hand_colour", static_cast<int>(view.hand_colour)},
              {"trail_mode", static_cast<int>(view.trail_mode)},
              {"trail_colour", static_cast<int>(view.trail_colour)},
              {"depth", view.depth},
              {"depth_source", view.depth_source},
              {"stereo_skew_ms", view.stereo_skew_ms},
              {"stereo_update_hz", view.stereo_update_hz},
              {"voxel_size", view.voxel_size},
                {"depth_lod", view.depth_lod},
                {"mask_hands", view.mask_hands},
               {"depth_opacity", view.depth_opacity},
               {"recorded_map_visible", view.recorded_map_visible},
               {"saved_map_visible", view.saved_map_visible},
               {"recorded_map_opacity", view.recorded_map_opacity},
               {"saved_map_opacity", view.saved_map_opacity},
              {"depth_min", view.depth_min},
              {"depth_max", view.depth_max},
               {"point_size", view.point_size},
                {"map_shader", static_cast<int>(view.map_shader)},
                {"map_gradient", static_cast<int>(view.map_gradient)},
               {"map_style", static_cast<int>(view.map_style)},
               {"map_relief_strength", view.map_relief_strength},
               {"map_density", view.map_density},
               {"map_recency_seconds", view.map_recency_seconds},
               {"map_frozen", view.map_frozen},
              {"trail_seconds", view.trail_seconds},
              {"grid", view.grid},
              {"frusta", view.frusta},
              {"headset", view.headset},
              {"projection", view.projection},
              {"undistort", view.undistort},
              {"pose_time_offset_ms", view.pose_time_offset_ms},
              {"plane_distance", view.plane_distance},
              {"plane_opacity", view.plane_opacity},
              {"panels", panels},
              {"preview", preview}}}};
    }
};
Preferences load_preferences(const std::filesystem::path& path) {
    Preferences result;
    std::ifstream file(path);
    if (!file)
        return result;
    Json json;
    file >> json;
    if (json.value("schema", std::string{}) != "ceres-viewer-preferences" ||
        json.value("version", 0) != 1)
        throw std::runtime_error("Unsupported preferences file");
    auto& calibration = json.at("calibration");
    result.calibration = Calibration::from_json(calibration.at("profile"));
    result.custom_calibration = calibration.value("custom", false);
    result.profile_path = calibration.value("profile_path", std::string{});
    auto data = json.value("data_directory", result.data_path.string());
    if (data.empty() || data.size() > 2047 || result.profile_path.size() > 2047)
        throw std::runtime_error("Invalid preferences path");
    result.data_path = data;
    result.recording_destination =
        json.value("recording_destination", (result.data_path / "sessions").string());
    if (json.contains("spatial_map")) {
        const auto& map = json.at("spatial_map");
        result.map_directory = map.value("directory", std::string{});
        result.last_map = map.value("last_file", std::string{});
        result.map_max_bytes = std::clamp<std::uint64_t>(
            map.value("max_bytes", spatial_map_default_max_bytes), 1024ull * 1024,
            spatial_map_hard_max_bytes);
        if (result.map_directory.string().size() > 2047 || result.last_map.string().size() > 2047)
            throw std::runtime_error("Invalid spatial map path");
    }
    if (json.contains("hugging_face")) {
        const auto& hf = json.at("hugging_face");
        result.hf_organisation = hf.value("organisation", std::string{});
        result.hf_repository = hf.value("repository", std::string{});
        result.hf_folder = hf.value("folder", std::string{});
        if (result.hf_organisation.size() > 127 || result.hf_repository.size() > 127 ||
            result.hf_folder.size() > 511)
            throw std::runtime_error("Invalid Hugging Face destination settings");
    }
    if (json.contains("replay")) {
        const auto& replay = json.at("replay");
        result.replay_location = replay.value("source", std::string{}) == "local_file"
                                     ? ReplayLocation::local_file : ReplayLocation::hugging_face;
        result.replay_repository = replay.value("repository", result.replay_repository);
        if (result.replay_repository.size() > 1023)
            throw std::runtime_error("Invalid replay repository");
    } else if (!result.hf_organisation.empty() && !result.hf_repository.empty()) {
        result.replay_repository = result.hf_organisation + "/" + result.hf_repository;
    }
    if (result.recording_destination.empty() || result.recording_destination.string().size() > 2047)
        throw std::runtime_error("Invalid recording destination");
    if (json.contains("task")) {
        const auto& task = json.at("task");
        result.task_description = task.value("description", std::string{});
        result.task_specification_path = task.value("path", std::string{});
        if (result.task_description.size() > 511 || result.task_specification_path.size() > 2047)
            throw std::runtime_error("Invalid task settings");
        if (task.contains("specification") && !task.at("specification").is_null())
            result.task_specification = parse_task_specification(task.at("specification"));
    }
    if (json.contains("stereo")) {
        const auto& stereo = json.at("stereo");
        result.stereo_path = stereo.value("path", std::string{});
        if (result.stereo_path.size() > 2047)
            throw std::runtime_error("Invalid stereo profile path");
        if (stereo.contains("profile") && !stereo.at("profile").is_null())
            result.stereo = StereoCalibration::from_json(stereo.at("profile"));
    }
    auto& view = json.at("view");
    auto& v = result.view;
    const int legacy_level = view.value("hands", true)     ? 3
                             : view.value("bones", false)  ? 2
                             : view.value("joints", false) ? 1
                                                           : 0;
    v.hand_level = static_cast<HandLevel>(std::clamp(view.value("hand_level", legacy_level), 0, 3));
    v.hand_colour = static_cast<HandColour>(std::clamp(view.value("hand_colour", 0), 0, 3));
    v.trail_mode = static_cast<TrailMode>(
        std::clamp(view.value("trail_mode", view.value("trails", false) ? 4 : 0), 0, 4));
    v.hands = view.value("hands_visible", true);
    v.trails = view.value("trails_visible", v.trail_mode != TrailMode::off);
    if (v.trail_mode == TrailMode::off)
        v.trail_mode = TrailMode::fingertips;
    v.trail_colour = static_cast<HandColour>(std::clamp(view.value("trail_colour", 0), 0, 3));
    v.depth = view.value("depth", false);
    v.stereo_skew_ms = view.value("stereo_skew_ms", 8.f);
    v.stereo_update_hz = view.value("stereo_update_hz", 2.f);
    v.depth_source = std::clamp(view.value("depth_source", 0), 0, 2);
    v.voxel_size = view.value("voxel_size", .03f);
    v.depth_lod = view.value("depth_lod", true);
    v.mask_hands = view.value("mask_hands", true);
    v.depth_opacity = view.value("depth_opacity", .85f);
    v.recorded_map_visible = view.value("recorded_map_visible", true);
    v.saved_map_visible = view.value("saved_map_visible", true);
    v.recorded_map_opacity = view.value("recorded_map_opacity", 1.f);
    v.saved_map_opacity = view.value("saved_map_opacity", 1.f);
    if (!std::isfinite(v.recorded_map_opacity) || !std::isfinite(v.saved_map_opacity))
        throw std::runtime_error("Invalid spatial layer opacity");
    v.recorded_map_opacity = std::clamp(v.recorded_map_opacity, 0.f, 1.f);
    v.saved_map_opacity = std::clamp(v.saved_map_opacity, 0.f, 1.f);
    v.depth_min = view.value("depth_min", .2f);
    v.depth_max = view.value("depth_max", 5.f);
    v.point_size = view.value("point_size", 2.f);
    v.map_shader = static_cast<SpatialMapShader>(std::clamp(view.value("map_shader", 0), 0, 3));
    v.map_gradient = static_cast<DepthGradient>(std::clamp(view.value("map_gradient", 0), 0, 4));
    v.map_style = static_cast<SpatialMapStyle>(std::clamp(view.value("map_style", 1), 0, 1));
    v.map_relief_strength = view.value("map_relief_strength", 1.f);
    v.map_density = view.value("map_density", 1.f);
    v.map_recency_seconds = view.value("map_recency_seconds", 30.f);
    v.map_frozen = view.value("map_frozen", false);
    if (!std::isfinite(v.stereo_skew_ms) || !std::isfinite(v.depth_min) ||
        !std::isfinite(v.depth_max) || !std::isfinite(v.point_size) ||
        !std::isfinite(v.stereo_update_hz) || !std::isfinite(v.voxel_size) ||
        !std::isfinite(v.depth_opacity) || !std::isfinite(v.map_density) ||
        !std::isfinite(v.map_recency_seconds) || !std::isfinite(v.map_relief_strength))
        throw std::runtime_error("Invalid stereo settings");
    v.stereo_skew_ms = std::clamp(v.stereo_skew_ms, 1.f, 20.f);
    v.stereo_update_hz = std::clamp(v.stereo_update_hz, .2f, 5.f);
    v.voxel_size = std::clamp(v.voxel_size, .01f, .1f);
    v.depth_opacity = std::clamp(v.depth_opacity, .1f, 1.f);
    v.depth_min = std::clamp(v.depth_min, .1f, 2.f);
    v.depth_max = std::clamp(v.depth_max, v.depth_min + .1f, 10.f);
    v.point_size = std::clamp(v.point_size, 1.f, 5.f);
    v.map_density = std::clamp(v.map_density, .01f, 1.f);
    v.map_recency_seconds = std::clamp(v.map_recency_seconds, 1.f, 600.f);
    v.map_relief_strength = std::clamp(v.map_relief_strength, 0.f, 3.f);
    v.trail_seconds = view.value("trail_seconds", v.trail_seconds);
    v.grid = view.value("grid", v.grid);
    v.frusta = view.value("frusta", v.frusta);
    v.headset = view.value("headset", v.headset);
    v.projection = view.value("projection", v.projection);
    v.undistort = view.value("undistort", v.undistort);
    v.plane_distance = view.value("plane_distance", v.plane_distance);
    v.plane_opacity = view.value("plane_opacity", v.plane_opacity);
    v.pose_time_offset_ms = view.value("pose_time_offset_ms", 0.f);
    if (!std::isfinite(v.plane_distance) || !std::isfinite(v.plane_opacity) ||
        !std::isfinite(v.pose_time_offset_ms) || !std::isfinite(v.trail_seconds))
        throw std::runtime_error("Invalid preferences view settings");
    v.plane_distance = std::clamp(v.plane_distance, .2f, 3.f);
    v.plane_opacity = std::clamp(v.plane_opacity, .1f, 1.f);
    v.pose_time_offset_ms = std::clamp(v.pose_time_offset_ms, -500.f, 500.f);
    v.trail_seconds = std::clamp(v.trail_seconds, .25f, 5.f);
    result.panels = view.value("panels", true);
    result.preview = view.value("preview", false);
    if (json.contains("sections")) {
        const auto& sections = json.at("sections");
        // Older preferences allowed several sections to be open. Keep the first one.
        result.section = sections.value("connection", false)    ? PaneSection::connection
                         : sections.value("hands", !sections.contains("depth") &&
                                                       sections.value("view", false)) ? PaneSection::hands
                         : sections.value("depth", false)       ? PaneSection::depth
                         : sections.value("scene", false)       ? PaneSection::scene
                         : sections.value("task", false)        ? PaneSection::task
                         : sections.value("recording", false)   ? PaneSection::recording
                         : sections.value("replay", false)      ? PaneSection::replay
                         : sections.value("publish", false)     ? PaneSection::publish
                         : sections.value("telemetry", false)   ? PaneSection::telemetry
                         : sections.value("calibration", false) ? PaneSection::calibration
                                                                : PaneSection::none;
    }
    return result;
}
void save_preferences(const std::filesystem::path& path, const Json& json) {
    auto temporary = path;
    temporary += ".tmp";
    {
        std::ofstream file(temporary, std::ios::binary | std::ios::trunc);
        file << json.dump(2) << '\n';
        file.flush();
        if (!file)
            throw std::runtime_error("Cannot write viewer preferences");
    }
#ifdef _WIN32
    if (!MoveFileExW(temporary.c_str(), path.c_str(),
                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        throw std::runtime_error("Cannot replace viewer preferences");
#else
    std::filesystem::rename(temporary, path);
#endif
}
class Histogram {
  public:
    Histogram() : bins_(100001, 0) {}
    void add(double milliseconds) {
        if (!std::isfinite(milliseconds) || milliseconds < 0)
            return;
        size_t bucket =
            milliseconds >= 1000 ? bins_.size() - 1 : static_cast<size_t>(milliseconds * 100);
        ++bins_[bucket];
        ++count_;
        maximum_ = std::max(maximum_, milliseconds);
    }
    double percentile(double quantile) const {
        if (!count_)
            return 0;
        auto rank =
            static_cast<uint64_t>(std::clamp(quantile, 0., 1.) * static_cast<double>(count_ - 1));
        uint64_t total = 0;
        for (size_t i = 0; i < bins_.size(); ++i) {
            total += bins_[i];
            if (total > rank)
                return i == bins_.size() - 1 ? maximum_ : (static_cast<double>(i) + .5) / 100.;
        }
        return maximum_;
    }

  private:
    std::vector<uint64_t> bins_;
    uint64_t count_ = 0;
    double maximum_ = 0;
};
class FramePacer {
  public:
#ifdef _WIN32
    FramePacer() : timer_(CreateWaitableTimerExW(nullptr, nullptr, 0x00000002, TIMER_ALL_ACCESS)) {}
    ~FramePacer() {
        if (timer_)
            CloseHandle(timer_);
    }
#endif
    void wait_until(std::chrono::steady_clock::time_point deadline) {
#ifdef _WIN32
        auto remaining = std::chrono::duration_cast<std::chrono::nanoseconds>(
                             deadline - std::chrono::steady_clock::now())
                             .count();
        if (remaining <= 0)
            return;
        LARGE_INTEGER due;
        due.QuadPart = -std::max<int64_t>(1, remaining / 100);
        if (timer_ && SetWaitableTimer(timer_, &due, 0, nullptr, nullptr, FALSE)) {
            used_timer_ = true;
            WaitForSingleObject(timer_, INFINITE);
            return;
        }
#endif
        std::this_thread::sleep_until(deadline);
    }
    bool high_resolution_active() const {
#ifdef _WIN32
        return used_timer_;
#else
        return false;
#endif
    }

  private:
#ifdef _WIN32
    HANDLE timer_ = nullptr;
    bool used_timer_ = false;
#endif
};
GLFWmonitor* window_monitor(GLFWwindow* window) {
    int x, y, width, height, count = 0;
    glfwGetWindowPos(window, &x, &y);
    glfwGetWindowSize(window, &width, &height);
    auto** monitors = glfwGetMonitors(&count);
    auto* selected = glfwGetPrimaryMonitor();
    int64_t largest = -1;
    for (int i = 0; i < count; ++i) {
        int mx, my;
        glfwGetMonitorPos(monitors[i], &mx, &my);
        auto* mode = glfwGetVideoMode(monitors[i]);
        if (!mode)
            continue;
        auto overlap =
            int64_t(std::max(0, std::min(x + width, mx + mode->width) - std::max(x, mx))) *
            std::max(0, std::min(y + height, my + mode->height) - std::max(y, my));
        if (overlap > largest) {
            largest = overlap;
            selected = monitors[i];
        }
    }
    return selected;
}
struct SceneNavigationState {
    detail::HoldPress reference_press;
    bool keyboard_gesture = false;
    unsigned popup_count = 0;
};
struct MapPlacement {
    glm::vec3 position{}, rotation{}, scale{1.f};
    glm::mat4 base{1.f};

    glm::mat4 transform(const glm::mat4& headset) const {
        return glm::translate(headset, position) *
            glm::yawPitchRoll(glm::radians(rotation.x), glm::radians(rotation.y),
                              glm::radians(rotation.z)) *
            base * glm::scale(glm::mat4(1.f), scale);
    }
};
void map_placement_adjuster(MapPlacement& placement, Json* controls) {
    const char* labels[] = {"X", "Y", "Z", "Yaw", "Pitch", "Roll", "Scale X", "Scale Y", "Scale Z"};
    const char* names[] = {"x", "y", "z", "yaw", "pitch", "roll", "scale_x", "scale_y", "scale_z"};
    float* values[] = {&placement.position.x, &placement.position.y, &placement.position.z,
                       &placement.rotation.x, &placement.rotation.y, &placement.rotation.z,
                       &placement.scale.x, &placement.scale.y, &placement.scale.z};
    if (ImGui::BeginTable("Placement", 3, ImGuiTableFlags_SizingStretchSame)) {
        for (int group = 0; group < 3; ++group) {
            ImGui::TableNextRow();
            for (int axis = 0; axis < 3; ++axis) {
                ImGui::TableSetColumnIndex(axis);
                ImGui::TextUnformatted(labels[group * 3 + axis]);
            }
            ImGui::TableNextRow();
            for (int axis = 0; axis < 3; ++axis) {
                const int index = group * 3 + axis;
                ImGui::TableSetColumnIndex(axis);
                ImGui::PushID(index);
                ImGui::SetNextItemWidth(-1);
                const bool scale = group == 2;
                ImGui::DragFloat("##Value", values[index], group == 1 ? .5f : .01f,
                                 scale ? .01f : -10000.f, scale ? 100.f : 10000.f,
                                 group == 1 ? "%.1f" : "%.2f", ImGuiSliderFlags_AlwaysClamp);
                if (!std::isfinite(*values[index])) *values[index] = scale ? 1.f : 0.f;
                if (controls) {
                    const auto minimum = ImGui::GetItemRectMin(), maximum = ImGui::GetItemRectMax();
                    (*controls)[names[index]] = {{minimum.x, minimum.y}, {maximum.x, maximum.y}};
                }
                ImGui::PopID();
            }
        }
        ImGui::EndTable();
    }
}
bool scene_navigation(Renderer& renderer, SceneNavigationState& gesture, float top, float dpi,
                      Json* metrics) {
    ImGui::SetNextWindowPos({12.f * dpi, top + 12.f * dpi});
    ImGui::SetNextWindowBgAlpha(.9f);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(4.f * dpi, 4.f * dpi));
    ImGui::PushStyleVar(ImGuiStyleVar_ItemSpacing, ImVec2(4.f * dpi, 4.f * dpi));
    const auto flags = ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize |
        ImGuiWindowFlags_NoMove | ImGuiWindowFlags_AlwaysAutoResize |
        ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoFocusOnAppearing | ImGuiWindowFlags_NoDocking;
    const bool visible = ImGui::Begin("Scene navigation", nullptr, flags);
    bool captures_mouse = false;
    if (visible) {
        const float size = std::max(34.f * dpi, ImGui::CalcTextSize("Left").x + 8.f * dpi);
        const auto button = [&](const char* label, bool selected, bool available) {
            ImGui::BeginDisabled(!available);
            ImGui::PushStyleColor(ImGuiCol_Button, selected ? ui::colour::overlay : ui::colour::surface);
            ImGui::PushStyleColor(ImGuiCol_Text, selected ? ui::colour::amber : ui::colour::text);
            const bool pressed = ImGui::Button(label, {size, size});
            ImGui::PopStyleColor(2);
            ImGui::EndDisabled();
            return pressed;
        };
        const char* references[] = {"W", "M", "H", "C"};
        const char* meanings[] = {"World", "Total model", "Hands", "Camera"};
        const auto state = renderer.scene_camera();
        const auto reference_index = static_cast<int>(state.reference);
        const auto label = std::string(references[reference_index]) + "###CycleReference";
        const bool pressed = button(label.c_str(), true, true);
        const auto reference_first = ImGui::GetItemRectMin(), reference_last = ImGui::GetItemRectMax();
        Json buttons = Json::array();
        if (metrics)
            buttons.push_back({{"label", references[reference_index]},
                {"bounds", {{reference_first.x, reference_first.y}, {reference_last.x, reference_last.y}}}});
        if (ImGui::IsItemActivated())
            gesture.keyboard_gesture = pressed;
        const auto& io = ImGui::GetIO();
        const bool menu_key = ImGui::IsItemFocused() && io.KeyShift &&
                              ImGui::IsKeyPressed(ImGuiKey_F10, false);
        const auto action = gesture.reference_press.update(
            {ImGui::GetTime(), pressed, ImGui::IsItemActive(),
             gesture.keyboard_gesture ? ImGui::IsItemFocused()
                 : ImGui::IsItemHovered(ImGuiHoveredFlags_NoNavOverride), true, true,
             ImGui::IsKeyPressed(ImGuiKey_Escape, false) || io.AppFocusLost ||
                 !ImGui::IsWindowFocused(ImGuiFocusedFlags_RootAndChildWindows)});
        if (gesture.reference_press.progress() > 0)
            ImGui::GetWindowDrawList()->AddRectFilled(
                {reference_first.x, reference_last.y - 3.f * dpi},
                {reference_first.x + size * gesture.reference_press.progress(), reference_last.y},
                ImGui::GetColorU32(ui::colour::amber));
        if (action == detail::HoldPress::Action::Primary) {
            for (int offset = 1; offset <= 4; ++offset)
                if (renderer.select_scene_reference(static_cast<SceneReference>((reference_index + offset) % 4)))
                    break;
        }
        if (action == detail::HoldPress::Action::Stop || menu_key) {
            ImGui::OpenPopup("Reference choices");
            ++gesture.popup_count;
        }
        if (ImGui::IsItemHovered())
            ImGui::SetTooltip("%s reference\nClick to cycle. Hold to choose.\nShift+F10 opens the choices.",
                              meanings[reference_index]);
        ImGui::SetNextWindowPos({reference_last.x + 6.f * dpi, reference_first.y}, ImGuiCond_Appearing);
        if (ImGui::BeginPopup("Reference choices")) {
            for (int index = 0; index < 4; ++index) {
                if (index) ImGui::SameLine();
                const auto reference = static_cast<SceneReference>(index);
                const bool available = renderer.scene_reference_available(reference);
                if (button(references[index], renderer.scene_camera().reference == reference, available)) {
                    renderer.select_scene_reference(reference);
                    ImGui::CloseCurrentPopup();
                }
                if (ImGui::IsItemHovered(ImGuiHoveredFlags_AllowWhenDisabled))
                    ImGui::SetTooltip("%s%s", meanings[index], available ? "" : " unavailable");
            }
            captures_mouse = ImGui::IsWindowHovered(ImGuiHoveredFlags_AllowWhenBlockedByActiveItem);
            ImGui::EndPopup();
        }
        const char* views[] = {"Top", "Left", "Iso"};
        const SceneView presets[] = {SceneView::top, SceneView::left, SceneView::iso};
        for (int index = 0; index < 3; ++index) {
            const auto view = presets[index];
            const bool available = renderer.scene_view_available(view);
            if (button(views[index], state.view == view, available))
                renderer.select_scene_view(view);
            if (metrics) {
                const auto first = ImGui::GetItemRectMin(), last = ImGui::GetItemRectMax();
                buttons.push_back({{"label", views[index]}, {"bounds", {{first.x, first.y}, {last.x, last.y}}}});
            }
            if (ImGui::IsItemHovered(ImGuiHoveredFlags_AllowWhenDisabled))
                ImGui::SetTooltip("%s", available ? views[index] : "The selected reference is unavailable");
        }
        if (metrics) {
            const auto current = renderer.scene_camera();
            *metrics = {{"reference", references[static_cast<int>(current.reference)]},
                        {"view", static_cast<int>(current.view)}, {"button_size", size},
                        {"button_count", 4}, {"vertical", true},
                        {"buttons", std::move(buttons)},
                        {"reference_bounds", {{reference_first.x, reference_first.y}, {reference_last.x, reference_last.y}}},
                        {"popup_open", ImGui::IsPopupOpen("Reference choices")},
                        {"popup_count", gesture.popup_count}};
        }
    }
    captures_mouse = captures_mouse || ImGui::IsWindowHovered(ImGuiHoveredFlags_AllowWhenBlockedByActiveItem);
    ImGui::End();
    ImGui::PopStyleVar(2);
    return captures_mouse;
}
void same_line_if_room(const char* label, bool checkbox = false) {
    const auto& style = ImGui::GetStyle();
    const float width =
        ImGui::CalcTextSize(label).x +
        (checkbox ? ImGui::GetFrameHeight() + style.ItemInnerSpacing.x : style.FramePadding.x * 2);
    if (ImGui::GetItemRectMax().x + style.ItemSpacing.x + width <=
        ImGui::GetCursorScreenPos().x + ImGui::GetContentRegionAvail().x)
        ImGui::SameLine();
}
bool pane_text_input(const char* label, char* value, size_t capacity, const char* hint = "") {
    ImGui::PushID(label);
    ui::field_label(label);
    ImGui::SetNextItemWidth(-1);
    const bool changed = ImGui::InputTextWithHint("##value", hint, value, capacity);
    ImGui::PopID();
    return changed;
}
bool pane_slider(const char* label, float* value, float minimum, float maximum,
                 const char* format = "%.3f") {
    bool changed = false;
    if (ui::begin_field(label)) {
        changed = ImGui::SliderFloat("##value", value, minimum, maximum, format);
        ui::end_field();
    }
    return changed;
}
template <typename Mode, size_t N>
void pane_selector(const char* label, Mode& mode, const char* const (&choices)[N]) {
    if (!ui::begin_field(label))
        return;
    const int selected = static_cast<int>(mode);
    std::string preview = choices[selected];
    const float available = ImGui::GetContentRegionAvail().x - ImGui::GetFrameHeight() -
                            ImGui::GetStyle().FramePadding.x * 2.f;
    const auto qualifier = preview.find(" (");
    if (qualifier != std::string::npos && ImGui::CalcTextSize(preview.c_str()).x > available)
        preview.resize(qualifier);
    const bool open = ImGui::BeginCombo("##value", preview.c_str());
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("%s", choices[selected]);
    if (open) {
        for (size_t index = 0; index < N; ++index) {
            const bool current = index == static_cast<size_t>(selected);
            if (ImGui::Selectable(choices[index], current))
                mode = static_cast<Mode>(index);
            if (current && ImGui::IsWindowAppearing())
                ImGui::SetItemDefaultFocus();
        }
        ImGui::EndCombo();
    }
    ui::end_field();
}
void metric_value(const char* label, double value, const char* unit, int decimals = 1) {
    char text[48];
    if (std::isfinite(value)) {
        if (std::abs(value) < .5 * std::pow(10., -decimals))
            value = 0.;
        std::snprintf(text, sizeof(text), "%.*f", decimals, value);
    } else
        std::snprintf(text, sizeof(text), "--");
    ui::metric(label, text, unit);
}
std::string time_name() {
    auto t = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    std::tm tm{};
#ifdef _WIN32
    localtime_s(&tm, &t);
#else
    localtime_r(&t, &tm);
#endif
    std::ostringstream s;
    s << std::put_time(&tm, "%Y%m%d-%H%M%S");
    return s.str();
}
std::string elapsed_label(int64_t microseconds) {
    const auto seconds = std::max<int64_t>(0, microseconds) / 1000000;
    std::ostringstream text;
    text << std::setfill('0') << std::setw(2) << seconds / 3600 << ':' << std::setw(2)
         << seconds / 60 % 60 << ':' << std::setw(2) << seconds % 60;
    return text.str();
}
std::array<std::string, 2> clock_labels() {
    const auto now = std::time(nullptr);
    std::tm local{}, universal{};
#ifdef _WIN32
    localtime_s(&local, &now);
    gmtime_s(&universal, &now);
#else
    localtime_r(&now, &local);
    gmtime_r(&now, &universal);
#endif
    std::array<std::string, 2> labels;
    for (size_t i = 0; i < labels.size(); ++i) {
        std::ostringstream text;
        text << (i == 0 ? "LOCT " : "UTC  ")
             << std::put_time(i == 0 ? &local : &universal, "%H:%M:%S");
        labels[i] = text.str();
    }
    return labels;
}
template <size_t N> void text_buffer(char (&buffer)[N], const std::string& text) {
    std::memset(buffer, 0, N);
    std::memcpy(buffer, text.data(), std::min(N - 1, text.size()));
}
SessionEvent pose_event(const PoseSample& p) {
    SessionEvent e;
    e.kind = EventKind::Pose;
    e.receive_us = p.received_us;
    e.time_us = p.observed_us;
    e.epoch = p.epoch;
    e.space_epoch = p.space_epoch;
    e.sequence = p.sequence;
    e.stream = p.kind == 1 ? "head" : p.kind == 2 ? "left" : "right";
    auto u = [&](uint64_t v, int n) {
        for (int i = 0; i < n; ++i)
            e.payload.push_back(uint8_t(v >> (i * 8)));
    };
    e.payload = {'C', 'B', 'R', '1'};
    u(1, 1);
    u(p.kind, 1);
    u(p.valid ? 1 : 0, 2);
    u(p.epoch, 4);
    u(p.space_epoch, 4);
    u(p.sequence, 4);
    u(p.kind == 1 ? 28 : 804, 4);
    u(p.observed_us, 8);
    u(p.target_us, 8);
    if (p.kind != 1)
        u(p.joint_mask, 4);
    for (int i = 0; i < (p.kind == 1 ? 7 : 200); ++i)
        u(std::bit_cast<uint32_t>(p.values[i]), 4);
    return e;
}
std::vector<std::vector<uint8_t>> read_access_units(const std::filesystem::path& path) {
    if (path.empty())
        return {};
    std::ifstream f(path, std::ios::binary);
    if (!f)
        throw std::runtime_error("Cannot open H.264 fixture");
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)), {});
    std::vector<size_t> starts;
    for (size_t i = 0; i + 4 < bytes.size(); ++i) {
        size_t n =
            bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 1
                ? 3
                : (bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 0 && bytes[i + 3] == 1
                       ? 4
                       : 0);
        if (n) {
            if ((bytes[i + n] & 31) == 9)
                starts.push_back(i);
            i += n;
        }
    }
    if (starts.empty())
        throw std::runtime_error("H.264 fixture requires access-unit delimiters");
    starts[0] = 0;
    starts.push_back(bytes.size());
    std::vector<std::vector<uint8_t>> result;
    for (size_t i = 0; i + 1 < starts.size(); ++i)
        result.emplace_back(bytes.begin() + static_cast<ptrdiff_t>(starts[i]),
                            bytes.begin() + static_cast<ptrdiff_t>(starts[i + 1]));
    return result;
}
bool is_idr(const std::vector<uint8_t>& b) {
    for (size_t i = 0; i + 4 < b.size(); ++i) {
        size_t n = b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1
                       ? 3
                       : (b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 0 && b[i + 3] == 1 ? 4 : 0);
        if (n && (b[i + n] & 31) == 5)
            return true;
    }
    return false;
}
void qr_code(const std::string& url, float size) {
    using qrcodegen::QrCode;
    static std::string cached_url;
    static std::optional<QrCode> cached;
    if (!cached || cached_url != url) {
        cached = QrCode::encodeText(url.c_str(), QrCode::Ecc::MEDIUM);
        cached_url = url;
    }
    const auto& qr = *cached;
    auto start = ImGui::GetCursorScreenPos();
    auto* draw = ImGui::GetWindowDrawList();
    draw->AddRectFilled(start, {start.x + size, start.y + size}, IM_COL32(242, 246, 250, 255), 3);
    float cell = size / (qr.getSize() + 8);
    for (int y = 0; y < qr.getSize(); ++y)
        for (int x = 0; x < qr.getSize(); ++x)
            if (qr.getModule(x, y))
                draw->AddRectFilled({start.x + (x + 4) * cell, start.y + (y + 4) * cell},
                                    {start.x + (x + 5) * cell, start.y + (y + 5) * cell},
                                    IM_COL32(16, 23, 30, 255));
    ImGui::Dummy({size, size});
}
struct Episode {
    int64_t start_us = 0, end_us = 0;
    std::string task;
    Json attributes = Json::object();
};
std::filesystem::path episode_sidecar(const std::filesystem::path& session) {
    auto path = session;
    path += ".episodes.json";
    return path;
}
struct EpisodeSelection {
    std::vector<Episode> episodes;
    ReplayTaskTimeline tasks;
    std::string error;
};
struct TimedPose {
    PoseSample sample;
    int64_t time_us = 0;
    int64_t map_time_us = 0;
};
struct PoseHistory {
    int64_t start_us = 0, end_us = 0;
    std::vector<SessionEvent> samples;
};
EpisodeSelection load_episodes(const ReplaySource& replay) {
    EpisodeSelection result;
    const auto recorded_episodes = replay.episodes();
    result.tasks = ReplayTaskTimeline::from_events(recorded_episodes, replay.task_specification());
    for (const auto& event : recorded_episodes) {
        const auto& a = event.attributes;
        try {
            if (a.is_object() && a.value("action", Json{}) == "stop" &&
                a.contains("start_us") && a.at("start_us").is_number_integer() &&
                a.contains("end_us") && a.at("end_us").is_number_integer()) {
                Episode episode{a.at("start_us").get<int64_t>(), a.at("end_us").get<int64_t>(),
                                a.value("name", Json{}).is_string() ? a.at("name").get<std::string>() : "", a};
                if (episode.start_us >= 0 && episode.end_us > episode.start_us)
                    result.episodes.push_back(std::move(episode));
            }
        } catch (const Json::exception&) {
            // Optional annotations must not discard valid intervals from the recording.
        }
    }
    try {
        std::ifstream file(episode_sidecar(replay.path()));
        if (!file)
            return result;
        Json json;
        file >> json;
        if (json.value("schema", std::string{}) != "ceres-viewer-episodes" ||
            json.value("version", 0) != 1 ||
            json.at("session_size").get<uintmax_t>() != std::filesystem::file_size(replay.path()))
            throw std::runtime_error("Episode sidecar does not match this recording");
        std::vector<Episode> episodes;
        for (const auto& item : json.at("episodes")) {
            Episode episode{item.at("start_us").get<int64_t>(), item.at("end_us").get<int64_t>(),
                            item.at("task").get<std::string>(), item.value("attributes", Json::object())};
            if (episode.start_us < 0 || episode.end_us <= episode.start_us ||
                episode.end_us > replay.duration_us() || !episode.attributes.is_object())
                throw std::runtime_error("Episode sidecar contains an invalid range");
            episodes.push_back(std::move(episode));
        }
        result.episodes = std::move(episodes);
    } catch (const std::exception& error) {
        result.error = error.what();
    }
    return result;
}
std::string replay_timestamp(int64_t time_us) {
    const auto milliseconds = std::max<int64_t>(0, time_us) / 1000;
    char text[64];
    std::snprintf(text, sizeof(text), "%02lld:%02lld.%03lld",
                  static_cast<long long>(milliseconds / 60000),
                  static_cast<long long>((milliseconds / 1000) % 60),
                  static_cast<long long>(milliseconds % 1000));
    return text;
}
std::string replay_task_counters(const ReplayTask* task) {
    if (!task) return "C-- T-- R--";
    const auto counter = [](const char* prefix, const std::optional<uint64_t>& value,
                            const std::optional<uint64_t>& total) {
        return std::string(prefix) + (value ? std::to_string(*value) : "--") +
               (total ? "/" + std::to_string(*total) : "");
    };
    return counter("C", task->cycle, task->cycle_count) + " " +
           counter("T", task->task_number, task->task_count) + " " +
           counter("R", task->repetition, task->repeat_count);
}
void replay_task_details(const ReplayTaskTimeline& timeline, int64_t position_us, bool loading) {
    ui::muted("Current task");
    const auto* task = timeline.at(position_us);
    if (!task) {
        ui::muted(loading ? "Loading task details..."
                         : timeline.tasks().empty() ? "No recorded task details"
                         : position_us >= timeline.tasks().back().end_us ? "Recorded tasks complete"
                                                    : "Between recorded tasks");
        return;
    }
    ImGui::TextWrapped("%s", task->title.c_str());
    if (!task->description.empty())
        ImGui::TextWrapped("%s", task->description.c_str());
    ImGui::TextUnformatted(replay_task_counters(task).c_str());
    if (task->take)
        ImGui::Text("Take %llu", static_cast<unsigned long long>(*task->take));
    ImGui::Text("%s to %s", replay_timestamp(task->start_us).c_str(),
                replay_timestamp(task->end_us).c_str());
    ImGui::Text("%s elapsed", replay_timestamp(position_us - task->start_us).c_str());
    ImGui::Text("%s remaining", replay_timestamp(task->end_us - position_us).c_str());
}
bool scene_task_overlay(const ReplayTask* task, float scene_width, float top, float bottom,
                        float dpi, Json* metrics) {
    if (metrics) *metrics = Json();
    if (!task || (task->title.empty() && task->description.empty())) return false;
    const float width = std::min(350.f * dpi, std::max(120.f * dpi, scene_width - 88.f * dpi));
    const float height = std::max(80.f * dpi, ImGui::GetIO().DisplaySize.y - top - bottom - 24.f * dpi);
    ImGui::SetNextWindowPos({scene_width - 12.f * dpi, top + 12.f * dpi}, ImGuiCond_Always, {1, 0});
    ImGui::SetNextWindowSizeConstraints({width, 0}, {width, height * .55f});
    ImGui::SetNextWindowBgAlpha(.84f);
    const bool visible = ImGui::Begin("Current scene task", nullptr,
        ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoMove |
        ImGuiWindowFlags_AlwaysAutoResize | ImGuiWindowFlags_NoSavedSettings |
        ImGuiWindowFlags_NoFocusOnAppearing | ImGuiWindowFlags_NoDocking);
    if (visible) {
        if (!task->title.empty()) ImGui::TextWrapped("%s", task->title.c_str());
        if (!task->description.empty() && task->description != task->title)
            ImGui::TextWrapped("%s", task->description.c_str());
        ImGui::Spacing();
        ImGui::TextColored(ui::colour::amber, "%s", replay_task_counters(task).c_str());
        if (task->take) {
            ImGui::SameLine();
            ImGui::Text("Take %llu", static_cast<unsigned long long>(*task->take));
        }
        if (metrics) {
            const auto first = ImGui::GetWindowPos(), size = ImGui::GetWindowSize();
            *metrics = {{"title", task->title}, {"description", task->description},
                        {"counters", replay_task_counters(task)},
                        {"bounds", {{first.x, first.y}, {first.x + size.x, first.y + size.y}}}};
        }
    }
    const bool captures_mouse = ImGui::IsWindowHovered(ImGuiHoveredFlags_AllowWhenBlockedByActiveItem);
    ImGui::End();
    return captures_mouse;
}
void scene_camera_preview(const Renderer& renderer, const ReceiverSnapshot& snapshot,
                          bool live, bool rgb, const std::array<bool, 2>& explicit_preview,
                          float scene_width, float top, float dpi, Json* metrics) {
    if (metrics)
        *metrics = {{"visible", false}, {"cameras", Json::array()}};
    std::array<CameraPresentation, 2> cameras;
    std::array<size_t, 2> shown{};
    size_t count = 0;
    for (size_t i = 0; i < cameras.size(); ++i) {
        cameras[i] = renderer.camera_presentation(snapshot, i);
        if (cameras[i].flat_preview(live, rgb, explicit_preview[i]))
            shown[count++] = i;
    }
    if (!count)
        return;
    const float margin = 12.f * dpi, padding = 8.f * dpi;
    const float gap = ImGui::GetStyle().ItemSpacing.x;
    const float available_height = std::max(1.f, ImGui::GetIO().DisplaySize.y - top - margin * 2);
    const float total_width = std::min(640.f * dpi, scene_width * .45f) - padding * 2;
    float width = std::min(320.f * dpi, (total_width - gap * float(count - 1)) / float(count));
    for (size_t n = 0; n < count; ++n) {
        const auto& image = cameras[shown[n]];
        width = std::min(width, available_height * .30f * image.width / image.height);
    }
    if (width < 1.f)
        return;
    ImGui::SetNextWindowPos({scene_width - margin, ImGui::GetIO().DisplaySize.y - margin},
                            ImGuiCond_Always, {1, 1});
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(padding, padding));
    ImGui::PushStyleColor(ImGuiCol_WindowBg, ui::colour::surface);
    const bool visible = ImGui::Begin("Camera inset", nullptr,
        ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoMove |
        ImGuiWindowFlags_AlwaysAutoResize | ImGuiWindowFlags_NoSavedSettings |
        ImGuiWindowFlags_NoFocusOnAppearing | ImGuiWindowFlags_NoDocking | ImGuiWindowFlags_NoInputs);
    if (visible) {
        ImGui::TextUnformatted("Camera");
        for (size_t n = 0; n < count; ++n) {
            if (n)
                ImGui::SameLine();
            const auto index = shown[n];
            const auto& image = cameras[index];
            ImGui::Image(static_cast<ImTextureID>(image.texture),
                         {width, width * image.height / image.width});
            if (metrics) {
                const auto minimum = ImGui::GetItemRectMin(), maximum = ImGui::GetItemRectMax();
                (*metrics)["cameras"].push_back({{"index", index}, {"sequence", image.sequence},
                    {"bounds", {{minimum.x, minimum.y}, {maximum.x, maximum.y}}}});
            }
        }
        if (metrics) {
            const auto position = ImGui::GetWindowPos(), size = ImGui::GetWindowSize();
            (*metrics)["visible"] = true;
            (*metrics)["bounds"] = {{position.x, position.y}, {position.x + size.x, position.y + size.y}};
        }
    }
    ImGui::End();
    ImGui::PopStyleColor();
    ImGui::PopStyleVar();
}
void save_episodes(const std::filesystem::path& session, const std::vector<Episode>& episodes) {
    Json ranges = Json::array();
    for (const auto& episode : episodes) {
        if (episode.start_us < 0 || episode.end_us <= episode.start_us)
            throw std::runtime_error(
                "Episode ranges must have a non-negative start and a later end");
        ranges.push_back(
            {{"start_us", episode.start_us}, {"end_us", episode.end_us}, {"task", episode.task},
             {"attributes", episode.attributes}});
    }
    save_preferences(episode_sidecar(session),
                     {{"schema", "ceres-viewer-episodes"},
                      {"version", 1},
                      {"session", session.filename().string()},
                      {"session_size", std::filesystem::file_size(session)},
                      {"episodes", std::move(ranges)}});
}
} // namespace

int run_app(const AppOptions& options) {
    glfwSetErrorCallback(
        [](int, const char* description) { std::cerr << "GLFW: " << description << '\n'; });
    if (!glfwInit())
        throw std::runtime_error("Cannot initialise GLFW");
    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 4);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 5);
    glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
    glfwWindowHint(GLFW_SAMPLES, 4);
    if (options.hidden)
        glfwWindowHint(GLFW_VISIBLE, GLFW_FALSE);
    if (!options.seconds)
        glfwWindowHint(GLFW_MAXIMIZED, GLFW_TRUE);
    if (options.borderless)
        glfwWindowHint(GLFW_DECORATED, GLFW_FALSE);
    if (options.seconds)
        glfwWindowHint(GLFW_RESIZABLE, GLFW_FALSE);
    GLFWwindow* window =
        glfwCreateWindow(options.width, options.height, "Ceres viewer", nullptr, nullptr);
    if (!window) {
        glfwTerminate();
        throw std::runtime_error("Cannot create the OpenGL window");
    }
    if (options.borderless && options.seconds)
        glfwSetWindowSize(window, options.width, options.height);
    glfwMakeContextCurrent(window);
    if (!gladLoadGL(glfwGetProcAddress))
        throw std::runtime_error("Cannot load OpenGL 4.5");
    glfwSwapInterval(options.vsync ? 1 : 0);
    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    auto& io = ImGui::GetIO();
    io.ConfigFlags |= ImGuiConfigFlags_DockingEnable | ImGuiConfigFlags_NavEnableKeyboard;
    auto config =
        options.config.empty() ? config_directory() : std::filesystem::absolute(options.config);
    std::filesystem::create_directories(config);
#ifndef _WIN32
    std::filesystem::permissions(config, std::filesystem::perms::owner_all,
                                 std::filesystem::perm_options::replace);
#endif
    std::string ini = (config / "layout.ini").string();
    io.IniFilename = ini.c_str();
    float dpi = 1;
    glfwGetWindowContentScale(window, &dpi, nullptr);
    dpi = std::clamp(dpi, .75f, 4.f);
    ui::apply_style(dpi);
    auto font = application_directory() / "assets" / "fonts" / "Roboto-Medium.ttf";
    if (!std::filesystem::exists(font))
        font = std::filesystem::path(__FILE__).parent_path().parent_path() / "assets" / "fonts" /
               "Roboto-Medium.ttf";
    ImFont* count_in_font = nullptr;
    ImFont* mono_font = nullptr;
    ImFont* readout_font = nullptr;
    ImFont* timer_font = nullptr;
    ImFont* title_font = nullptr;
    ImFont* instrument_label_font = nullptr;
    ImFont* compact_readout_font = nullptr;
    const auto mono_path = font.parent_path() / "Cousine-Regular.ttf";
    auto load_fonts = [&] {
        io.Fonts->Clear();
        auto add_font = [&](float size) {
            ImFontConfig config;
            config.SizePixels = size * dpi;
            return std::filesystem::exists(font)
                       ? io.Fonts->AddFontFromFileTTF(font.string().c_str(), config.SizePixels)
                       : io.Fonts->AddFontDefault(&config);
        };
        auto add_mono = [&](float size) {
            return std::filesystem::exists(mono_path)
                       ? io.Fonts->AddFontFromFileTTF(mono_path.string().c_str(), size * dpi)
                       : add_font(size);
        };
        io.FontDefault = add_font(ui::typography::body);
        title_font = add_font(ui::typography::title);
        instrument_label_font = add_font(ui::typography::instrument_label);
        mono_font = add_mono(ui::typography::mono);
        compact_readout_font = add_mono(ui::typography::compact_readout);
        readout_font = add_mono(ui::typography::readout);
        timer_font = add_mono(ui::typography::timer);
        count_in_font = add_mono(ui::typography::count_in);
        ui::set_fonts(io.FontDefault, mono_font, instrument_label_font);
    };
    load_fonts();
    auto asset_directory = application_directory() / "assets";
    if (!std::filesystem::exists(asset_directory / "redistributable.json"))
        asset_directory = std::filesystem::path(__FILE__).parent_path().parent_path() / "assets";
    auto renderer = std::make_unique<Renderer>(window, asset_directory);
    const auto fixture_assets =
        options.fixture ? std::optional(decode_hand_assets(renderer->hand_asset_event()))
                        : std::nullopt;
    glfwSetWindowUserPointer(window, renderer.get());
    glfwSetScrollCallback(window, [](GLFWwindow* w, double, double y) {
        if (!ImGui::GetCurrentContext() || !ImGui::GetIO().WantCaptureMouse)
            static_cast<Renderer*>(glfwGetWindowUserPointer(w))->zoom(float(y));
    });
    ImGui_ImplGlfw_InitForOpenGL(window, true);
    ImGui_ImplOpenGL3_Init("#version 450 core");
    auto decoder = std::make_unique<NvDecoder>(renderer->cuda_device());
    auto secondary_decoder = std::make_unique<NvDecoder>(renderer->cuda_device());
    detail::StereoPairQueue<VideoFrameLease> stereo_pairs;
    detail::StereoCadence stereo_cadence;
    using StereoFrameIdentity = std::tuple<uint32_t, uint32_t, uint64_t, uint32_t>;
    std::array<std::optional<StereoFrameIdentity>, 2> stereo_seen;
    const auto stereo_frame_identity = [](const SessionEvent& event) {
        return StereoFrameIdentity{event.epoch, event.space_epoch,
                                   event.attributes.value("replay_generation", uint64_t{0}),
                                   event.sequence};
    };
    std::optional<StereoCalibration> stereo_profile;
    float mapped_voxel_size = 0;
    uint64_t stereo_pair_count = 0, stereo_window_count = 0, stereo_attempt_count = 0;
    int64_t stereo_last_pair_us = 0;
    double stereo_pair_skew_ms = 0;
    std::string stereo_state = "Two cameras required";
    auto reset_stereo_acquisition = [&] {
        stereo_pairs.clear();
        stereo_cadence.reset();
        stereo_seen = {};
        stereo_last_pair_us = 0;
    };
    Recorder recorder;
    ExportJob exporter(options.helper, options.ffmpeg);
    bool exporter_present = exporter.exporter_available();
    std::future<bool> exporter_presence_check;
    double exporter_presence_due = glfwGetTime() + 1.;
    HuggingFaceClient hugging_face(config_directory() / "private");
    Calibration calibration = Calibration::quest(640, 480, "right");
    ViewOptions view;
    bool custom_calibration = false;
    std::shared_ptr<SessionSource> source;
    struct PendingRecording {
        std::filesystem::path path;
        int64_t requested_us;
        const SessionSource* source;
        uint32_t epoch, space_epoch;
        bool automatic;
    };
    constexpr int64_t recording_count_in_us = 3000000;
    std::optional<PendingRecording> pending_recording;
    std::string recording_start_notice, automatic_record_error;
    bool recording_count_in_cancelled = false;
    double recording_start_delay_seconds = 0;
    auto cancel_count_in = [&](const std::string& reason = "Recording cancelled") {
        if (!pending_recording)
            return;
        if (pending_recording->automatic && reason != "Recording cancelled")
            automatic_record_error = reason;
        pending_recording.reset();
        recording_start_notice = reason;
        recording_count_in_cancelled = true;
    };
    std::future<std::shared_ptr<SessionSource>> source_job;
    std::future<RecoveryResult> recovery_job;
    std::string recovery_message;
    std::string ui_error;
    std::mutex controls_mutex, history_mutex, recording_mutex;
    std::deque<SessionEvent> controls;
    std::optional<SessionEvent> pending_depth, environment_event;
    std::optional<StereoFrameIdentity> environment_seen;
    uint64_t environment_updates = 0;
    uint64_t last_environment_updates = 0;
    double environment_hz = 0;
    std::string environment_usage;
    bool environment_available = false;
    int previous_depth_source = -1;
    auto reset_environment = [&] {
        environment_event.reset();
        environment_seen.reset();
        environment_available = false;
        environment_usage.clear();
        renderer->clear_environment_depth();
    };
    std::deque<TimedPose> live_history;
    auto observed_hands = [&](const SessionEvent& event) {
        if (!view.mask_hands)
            return HandMaskSet{};
        HandMaskCapture capture;
        capture.receiver_time_us = event.attributes.value("recorded_time_us", event.time_us);
        capture.epoch = event.epoch;
        capture.space_epoch = event.space_epoch;
        capture.require_sender_time = event.kind == EventKind::Depth;
        if (capture.require_sender_time) {
            const auto mapped_observed = event.attributes.find("mapped_observed_us");
            if (mapped_observed != event.attributes.end() && mapped_observed->is_number_integer())
                capture.receiver_time_us = mapped_observed->get<int64_t>();
            const auto depth = decode_depth(event.payload);
            capture.observed_us = depth.observed_us;
            capture.target_us = depth.target_us;
        }
        HandMaskBuilder builder(capture);
        std::lock_guard lock(history_mutex);
        for (const auto& pose : live_history)
            builder.observe(pose.sample, pose.map_time_us);
        return builder.finish();
    };
    PoseHistory replay_history;
    std::shared_ptr<ReplaySource> history_source, history_loading_source;
    std::future<PoseHistory> history_load;
    Preferences preferences;
    try {
        preferences = load_preferences(config / "preferences.json");
    } catch (const std::exception& error) {
        ui_error = std::string("Cannot load viewer preferences: ") + error.what();
    }
    calibration = preferences.calibration;
    custom_calibration = preferences.custom_calibration;
    stereo_profile = preferences.stereo;
    view = preferences.view;
    // Freezing is a live acquisition action. Opening a saved map freezes it explicitly.
    view.map_frozen = false;
    if (!options.map_directory.empty())
        preferences.map_directory = std::filesystem::absolute(options.map_directory);
    else if (preferences.map_directory.empty())
        preferences.map_directory = (options.config.empty() ? preferences.data_path : config) / "maps";
    const auto map_run_id = std::to_string(std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());
    uint64_t map_world_serial = 0, map_connection_serial = 0;
    std::string map_world_id = map_run_id + "-" + std::to_string(++map_world_serial);
    std::tuple<uint64_t, uint32_t, uint32_t> map_binding{};
    uint32_t map_epoch = 0, map_space_epoch = 0;
    bool map_detached = false, previous_map_frozen = false, frozen_environment = true;
    bool automatic_map_freeze = false;
    std::atomic<bool> depth_capture_enabled{true}, replay_depth_input{false};
    struct MapRestore {
        int source;
        float spacing;
        bool visible;
    };
    std::optional<MapRestore> map_restore;
    MapPlacement map_placement;
    std::optional<std::tuple<uint64_t, uint32_t, uint32_t>> saved_map_binding;
    bool load_previous_frozen = false, load_previous_fusion = false;
    bool frame_loaded_map = false;
    uint64_t requested_saved_map_generation = 0;
    std::string saved_map_world_id;
    std::filesystem::path loaded_map_file, saved_map_file, loading_map_file;
    std::array<uint64_t, 2> requested_map_generation{};
    std::array<std::filesystem::path, 2> current_map_files;
    std::map<std::filesystem::path, std::unique_ptr<SpatialMapStore>> map_stores;
    std::unique_ptr<SpatialMapStore> map_loader;
    std::unique_ptr<SpatialMapFileProtection> loaded_map_protection, loading_map_protection;
    std::string map_error, last_storage_error, placement_error;
    double map_snapshot_due = 0;
    uint64_t frozen_environment_updates = 0, frozen_stereo_pairs = 0;
    char map_directory_text[2048]{}, map_open_path[2048]{};
    text_buffer(map_directory_text, preferences.map_directory.string());
    text_buffer(map_open_path, preferences.last_map.string());
    auto map_point_budget = [&] {
        return size_t((preferences.map_max_bytes - spatial_map_header_bytes) / spatial_map_record_bytes);
    };
    auto request_map_snapshots = [&] {
        for (size_t i = 0; i < 2; ++i) {
            const bool environment = i == 0;
            const auto generation = renderer->map_generation(environment);
            if (generation && generation != requested_map_generation[i] &&
                renderer->request_map_snapshot(environment, map_world_id, map_epoch, map_space_epoch))
                requested_map_generation[i] = generation;
        }
        const auto saved = renderer->saved_map_state();
        if (saved.placed && saved.generation != requested_saved_map_generation &&
            renderer->request_saved_map_snapshot())
            requested_saved_map_generation = saved.generation;
    };
    auto collect_map_snapshots = [&] {
        if (auto map = renderer->take_saved_map_snapshot()) {
            if (!saved_map_file.empty()) {
                map->world_id = saved_map_world_id;
                auto& store = map_stores[saved_map_file];
                if (!store)
                    store = std::make_unique<SpatialMapStore>(saved_map_file, preferences.map_max_bytes);
                if (!store->submit(map))
                    map_error = "The placed map could not be queued for saving";
            }
        }
        for (size_t i = 0; i < 2; ++i) {
            if (auto map = renderer->take_map_snapshot(i == 0)) {
                const auto filename = map->world_id + (i == 0 ? "-quest.cmap" : "-stereo.cmap");
                const auto path = preferences.map_directory / filename;
                if (map->points.empty() && !map_stores.contains(path))
                    continue;
                auto& store = map_stores[path];
                if (!store)
                    store = std::make_unique<SpatialMapStore>(path, preferences.map_max_bytes, 3);
                if (!store->submit(map))
                    map_error = "The map could not be queued for saving";
                if (map->world_id == map_world_id) {
                    current_map_files[i] = path;
                    if ((i == 0) == view.environment_depth && !renderer->saved_map_state().loaded) {
                        const auto previous_file = preferences.last_map.string();
                        preferences.last_map = path;
                        if (!map_open_path[0] || previous_file == map_open_path)
                            text_buffer(map_open_path, path.string());
                    }
                }
            }
        }
        std::string storage_error;
        for (auto it = map_stores.begin(); it != map_stores.end();) {
            const auto status = it->second->status();
            if (!status.error.empty()) {
                storage_error = status.error;
                if (!status.busy)
                    for (size_t i = 0; i < current_map_files.size(); ++i)
                        if (it->first == current_map_files[i])
                            requested_map_generation[i] = 0;
                if (!status.busy && it->first == saved_map_file)
                    requested_saved_map_generation = 0;
            }
            const bool current = it->first == current_map_files[0] || it->first == current_map_files[1] ||
                                 it->first == saved_map_file;
            if (!current && !status.busy && status.saved_generation >= status.submitted_generation)
                it = map_stores.erase(it);
            else
                ++it;
        }
        if (!storage_error.empty())
            map_error = storage_error;
        else if (!last_storage_error.empty() && map_error == last_storage_error)
            map_error.clear();
        last_storage_error = std::move(storage_error);
    };
    auto capture_final_maps = [&] {
        // Source changes are explicit save barriers. Drain an older readback
        // before requesting the final generation, then release the old GPU map.
        renderer->finish_map_snapshot(true);
        renderer->finish_map_snapshot(false);
        renderer->finish_saved_map_snapshot();
        collect_map_snapshots();
        request_map_snapshots();
        renderer->finish_map_snapshot(true);
        renderer->finish_map_snapshot(false);
        renderer->finish_saved_map_snapshot();
        collect_map_snapshots();
    };
    auto begin_map_world = [&](uint32_t epoch, uint32_t space_epoch) {
        capture_final_maps();
        renderer->clear_stereo(true);
        renderer->clear_environment_depth(true);
        map_world_id = map_run_id + "-" + std::to_string(++map_world_serial);
        map_epoch = epoch;
        map_space_epoch = space_epoch;
        map_binding = {map_connection_serial, epoch, space_epoch};
        map_detached = false;
        requested_map_generation = {};
        current_map_files = {};
        reset_stereo_acquisition();
        environment_seen.reset();
    };
    auto open_map = [&](const std::filesystem::path& path) {
        if (path.empty())
            return;
        if (map_loader && map_loader->status().busy)
            return;
        loading_map_file = std::filesystem::absolute(path);
        loading_map_protection = std::make_unique<SpatialMapFileProtection>(loading_map_file);
        map_loader = std::make_unique<SpatialMapStore>(loading_map_file, spatial_map_hard_max_bytes);
        map_loader->request_load(map_point_budget());
        load_previous_frozen = view.map_frozen;
        load_previous_fusion = renderer->saved_map_state().fusing;
        renderer->stop_saved_map_fusion();
        depth_capture_enabled.store(false);
        view.map_frozen = true;
        frozen_environment = view.environment_depth;
        renderer->configure_spatial_map(true, view.voxel_size, map_point_budget());
        map_error.clear();
    };
    auto unload_map = [&] {
        map_loader.reset();
        capture_final_maps();
        renderer->clear_saved_map();
        loaded_map_protection.reset();
        loading_map_protection.reset();
        if (map_restore) {
            view.depth_source = map_restore->source;
            view.voxel_size = map_restore->spacing;
            view.depth = map_restore->visible;
        }
        map_restore.reset();
        saved_map_binding.reset();
        loaded_map_file.clear();
        saved_map_file.clear();
        requested_saved_map_generation = 0;
        view.map_frozen = false;
        depth_capture_enabled.store(true);
        reset_stereo_acquisition();
        environment_seen.reset();
        renderer->configure_spatial_map(false, view.voxel_size, map_point_budget());
        map_error.clear();
        placement_error.clear();
    };
    renderer->configure_spatial_map(false, view.voxel_size, map_point_budget());
    if (!options.map_load.empty()) {
        text_buffer(map_open_path, options.map_load.string());
        open_map(options.map_load);
    }
    std::atomic<bool> accepting{true};
    std::atomic<uint64_t> accepted_head_frames{0};
    detail::HoldPress record_press;
    SceneNavigationState scene_navigation_state;
    bool record_keyboard_gesture = false;
    detail::HoldPress repeat_press;
    bool repeat_keyboard_gesture = false;
    auto event_sink = [&](const SessionEvent& e) {
        if (!accepting.load())
            return;
        if (e.kind == EventKind::Depth && !depth_capture_enabled.load() && !replay_depth_input.load())
            return;
        {
            std::lock_guard lock(recording_mutex);
            recorder.push(e);
        }
        if (e.kind == EventKind::Depth) {
            std::lock_guard lock(controls_mutex);
            // Recording sees every complete frame. Presentation retains one latest
            // depth observation, independent of video and metadata queues.
            pending_depth = e;
            return;
        }
        if (e.kind == EventKind::Video) {
            if (e.stream == "passthrough" || e.stream.empty())
                decoder->submit(e);
            else if (e.stream == "passthrough_left" || e.stream == "passthrough_right")
                secondary_decoder->submit(e);
        } else {
            decoder->submit(e);
            secondary_decoder->submit(e);
        }
        if (e.kind == EventKind::Pose) {
            try {
                auto pose = decode_pose(e.payload, e.receive_us);
                if (pose.kind == 1)
                    accepted_head_frames.fetch_add(1, std::memory_order_relaxed);
                std::lock_guard lock(history_mutex);
                live_history.push_back({std::move(pose), e.time_us,
                                        e.attributes.value("recorded_time_us", e.time_us)});
                while (!live_history.empty() &&
                       (live_history.size() > 2048 ||
                        live_history.front().sample.received_us < e.receive_us - 2000000))
                    live_history.pop_front();
            } catch (const std::exception&) {
            }
        }
        if (e.kind == EventKind::Calibration || e.kind == EventKind::Metadata ||
            e.kind == EventKind::Epoch || e.kind == EventKind::Asset) {
            std::lock_guard lock(controls_mutex);
            if (e.kind == EventKind::Epoch && !recording_marker(e))
                pending_depth.reset();
            if (e.kind == EventKind::Asset) {
                if (e.stream != "hand-rig" && e.stream != "headset-rig")
                    return;
                std::erase_if(controls, [&](const SessionEvent& pending) {
                    return pending.kind == EventKind::Asset && pending.stream == e.stream;
                });
                if (controls.size() >= 1024) {
                    const auto oldest = std::find_if(controls.begin(), controls.end(),
                                                     [](const SessionEvent& pending) {
                                                         return pending.kind != EventKind::Asset;
                                                     });
                    if (oldest != controls.end())
                        controls.erase(oldest);
                }
                controls.push_back(e);
            } else if (controls.size() < 1024)
                controls.push_back(e);
        }
    };
    auto change_source = [&](const std::filesystem::path& replay, bool connect) {
        if (source_job.valid())
            return;
        if (recorder.status().recording) {
            ui_error = "Stop recording before changing source";
            return;
        }
        cancel_count_in("Recording cancelled: source changed");
        record_press.reset();
        scene_navigation_state.reference_press.reset();
        record_keyboard_gesture = false;
        repeat_press.reset();
        repeat_keyboard_gesture = false;
        decoder->cancel_replay();
        secondary_decoder->cancel_replay();
        capture_final_maps();
        renderer->stop_saved_map_fusion();
        if (renderer->saved_map_state().loaded) {
            view.map_frozen = true;
            depth_capture_enabled.store(false);
        }
        ++map_connection_serial;
        reset_stereo_acquisition();
        reset_environment();
        renderer->invalidate_video();
        renderer->invalidate_poses();
        auto old = source;
        source_job = std::async(std::launch::async,
                                [&, old, replay, connect]() -> std::shared_ptr<SessionSource> {
                                    if (old)
                                        old->stop();
                                    replay_depth_input.store(!replay.empty());
                                    {
                                        std::lock_guard lock(controls_mutex);
                                        controls.clear();
                                        pending_depth.reset();
                                    }
                                    {
                                        std::lock_guard lock(history_mutex);
                                        live_history.clear();
                                    }
                                    decoder->begin_source();
                                    secondary_decoder->begin_source();
                                    std::shared_ptr<SessionSource> next;
                                    if (!replay.empty())
                                        next = std::make_shared<ReplaySource>(replay);
                                    else if (connect) {
                                        BridgeOptions o;
                                        o.app_origin = o.relay = options.origin;
                                        o.ca_certificate = options.ca_certificate;
                                        o.identity_path = config / "receiver.identity";
                                        auto client = std::make_shared<BridgeClient>(o);
                                        client->set_depth_enabled(depth_capture_enabled.load());
                                        next = std::move(client);
                                    }
                                    if (next) {
                                        next->set_event_sink(event_sink);
                                        next->start();
                                    }
                                    return next;
                                });
    };
    if (!options.fixture)
        change_source(options.replay, options.connect);
    auto fixture_video = read_access_units(options.fixture_video);
    size_t fixture_frame = 0;
    int64_t fixture_pose_due = 0, fixture_video_due = 0, fixture_depth_due = 0;
    ReceiverSnapshot fixture;
    fixture.connected = true;
    fixture.connection = "Fixture source";
    fixture.epoch = fixture.space_epoch = 1;
    fixture.clock.valid = true;
    fixture.camera.side = "right";
    fixture.camera.raw = {
        {"version", 1},
        {"type", "description"},
        {"epoch", 1},
        {"axes", "right-handed-x-right-y-up-z-back"},
        {"units", "metres"},
        {"quaternion", "xyzw"},
        {"referenceSpace", "local-floor"},
        {"joints", bridge_joints},
        {"clock",
         {{"units", "microseconds"}, {"domain", "sender-monotonic"}, {"id", "viewer-fixture"}}},
        {"camera",
         {{"side", "right"},
          {"width", 640},
          {"height", 480},
          {"requestedWidth", 640},
          {"fps", 30},
          {"calibration", nullptr}}}};
    char stereo_path[2048]{};
    text_buffer(stereo_path, preferences.stereo_path);
    char task[512]{}, session_path[2048]{}, export_path[2048]{}, profile_path[2048]{},
        data_path[2048]{}, recording_destination[2048]{}, task_specification_path[2048]{};
    char hf_organisation[128]{}, hf_repository[128]{}, hf_folder[512]{}, hf_filter[256]{};
    char replay_repository[1024]{};
    text_buffer(replay_repository, preferences.replay_repository);
    if (!options.replay.empty())
        preferences.replay_location = ReplayLocation::local_file;
    text_buffer(hf_organisation, preferences.hf_organisation);
    text_buffer(hf_repository, preferences.hf_repository);
    text_buffer(hf_folder, preferences.hf_folder);
    std::string hf_selected;
    std::filesystem::path hf_ready_recording;
    bool hf_private = true, hf_include_export = false, hf_auth_popup = false, hf_new_code = false;
    text_buffer(data_path, preferences.data_path.string());
    text_buffer(recording_destination, preferences.recording_destination.string());
    text_buffer(task, preferences.task_description);
    text_buffer(task_specification_path, preferences.task_specification_path);
    auto task_specification = preferences.task_specification;
    std::stop_source task_load_cancel;
    std::future<TaskSpecification> task_load;
    auto load_task_source = [&] {
        if (task_load.valid())
            return;
        task_load_cancel = std::stop_source{};
        const auto token = task_load_cancel.get_token();
        const std::string location = task_specification_path;
        task_load = std::async(std::launch::async, [location, token] {
            return load_task_specification_source(location, token);
        });
    };
    if (!options.task_specification.empty()) {
        text_buffer(task_specification_path, options.task_specification);
        load_task_source();
    }
    TaskRun task_run;
    bool manual_recording_pause = false;
    text_buffer(profile_path, preferences.profile_path);
    text_buffer(session_path, options.replay.string());
    text_buffer(export_path, (preferences.data_path / "datasets" / time_name()).string());
    std::vector<Episode> episodes;
    bool episode_open = false, episodes_dirty = false;
    int64_t episode_begin = 0, record_origin = 0;
    std::string episode_task;
    Json episode_attributes = Json::object();
    std::filesystem::path closed_recording, episode_session;
    int64_t closed_duration = 0;
    StreamDescription closed_camera;
    std::shared_ptr<ReplaySource> episode_replay, episode_loading_replay;
    ReplayTaskTimeline replay_tasks;
    std::future<EpisodeSelection> episode_load;
    auto calibration_event = [&](uint32_t epoch = 0, uint32_t space_epoch = 0) {
        SessionEvent e;
        e.kind = EventKind::Calibration;
        e.receive_us = e.time_us = monotonic_us();
        e.epoch = epoch;
        e.space_epoch = space_epoch;
        e.attributes = {{"profile", calibration.to_json()},
                        {"stereo_profile", stereo_profile ? stereo_profile->to_json() : Json()}};
        return e;
    };
    auto begin_recording = [&](const std::filesystem::path& path, const ReceiverSnapshot& snap) {
        if (std::dynamic_pointer_cast<ReplaySource>(source))
            throw std::runtime_error("Return to live input before recording");
        if (recovery_job.valid())
            throw std::runtime_error("Wait for session recovery to finish before recording");
        record_origin = monotonic_us();
        episodes.clear();
        closed_recording.clear();
        closed_duration = 0;
        episode_open = false;
        manual_recording_pause = false;
        SessionEvent epoch;
        epoch.kind = EventKind::Epoch;
        epoch.receive_us = epoch.time_us = record_origin;
        epoch.epoch = snap.epoch;
        epoch.space_epoch = snap.space_epoch;
        epoch.attributes = {
            {"reason", "record-start"}, {"epoch", snap.epoch}, {"space_epoch", snap.space_epoch}};
        std::vector<SessionEvent> initial{epoch, calibration_event(snap.epoch, snap.space_epoch)};
        SessionEvent description;
        description.kind = EventKind::Metadata;
        description.receive_us = description.time_us = record_origin;
        description.epoch = snap.epoch;
        description.space_epoch = snap.space_epoch;
        description.attributes = snap.camera.raw;
        initial.push_back(description);
        SessionEvent clock;
        clock.kind = EventKind::Clock;
        clock.receive_us = clock.time_us = record_origin;
        clock.attributes = {{"offset_us", snap.clock.offset_us},
                            {"rate", snap.clock.rate},
                            {"uncertainty_us", snap.clock.uncertainty_us},
                            {"valid", snap.clock.valid}};
        initial.push_back(clock);
        auto asset = renderer->hand_asset_event();
        asset.receive_us = asset.time_us = record_origin;
        asset.epoch = snap.epoch;
        asset.space_epoch = snap.space_epoch;
        initial.push_back(std::move(asset));
        if (auto headset = renderer->headset_asset_event()) {
            headset->receive_us = headset->time_us = record_origin;
            headset->epoch = snap.epoch;
            headset->space_epoch = snap.space_epoch;
            initial.push_back(std::move(*headset));
        }
        if (task_specification) {
            SessionEvent specification;
            specification.kind = EventKind::Asset;
            specification.stream = "task-specification";
            specification.attributes = task_specification->to_json();
            initial.push_back(std::move(specification));
        }
        if (!path.parent_path().empty())
            std::filesystem::create_directories(path.parent_path());
        text_buffer(session_path, path.string() + ".partial");
        ReceiverSnapshot recorded_snapshot;
        {
            // Asset preparation can span the first reference-space event. Capture the
            // initial state at the same boundary where event forwarding starts.
            std::lock_guard lock(recording_mutex);
            recorded_snapshot = source ? source->snapshot() : snap;
            record_origin = monotonic_us();
            for (auto& event : initial) {
                event.receive_us = event.time_us = record_origin;
                event.epoch = recorded_snapshot.epoch;
                event.space_epoch = recorded_snapshot.space_epoch;
                if (event.kind == EventKind::Epoch) {
                    event.attributes["epoch"] = recorded_snapshot.epoch;
                    event.attributes["space_epoch"] = recorded_snapshot.space_epoch;
                } else if (event.kind == EventKind::Metadata) {
                    event.attributes = recorded_snapshot.camera.raw;
                } else if (event.kind == EventKind::Clock) {
                    const auto& mapping = recorded_snapshot.clock;
                    event.attributes = {{"offset_us", mapping.offset_us},
                                        {"rate", mapping.rate},
                                        {"uncertainty_us", mapping.uncertainty_us},
                                        {"valid", mapping.valid}};
                }
            }
            recorder.start(path, initial);
            if (task_specification)
                recorder.set_capture_window(record_origin, record_origin);
        }
        if (auto bridge = std::dynamic_pointer_cast<BridgeClient>(source))
            bridge->request_keyframe();
        closed_recording = episode_session = path;
        closed_camera = recorded_snapshot.camera;
        episodes_dirty = true;
    };
    auto end_episode = [&](int64_t t) {
        if (!episode_open)
            return;
        if (t > episode_begin)
            episodes.push_back({episode_begin, t, episode_task, episode_attributes});
        auto attributes = episode_attributes;
        attributes.update({{"action", "stop"}, {"start_us", episode_begin}, {"end_us", t}});
        recorder.add_episode(episode_task, attributes);
        episode_open = false;
        episodes_dirty = true;
    };
    auto start_episode = [&](int64_t at, const std::string& description, Json attributes) {
        episode_begin = std::max<int64_t>(0, at - record_origin);
        episode_task = description;
        episode_attributes = std::move(attributes);
        episode_open = true;
        auto start = episode_attributes;
        start.update({{"action", "start"}, {"start_us", episode_begin}});
        recorder.add_episode(episode_task, start);
    };
    // Callers hold recording_mutex while choosing transition timestamps and applying
    // them, so receiver events cannot slip across a manual recording boundary.
    auto apply_task_transitions = [&](const std::vector<TaskTransition>& transitions) {
        for (const auto& transition : transitions) {
            const char* restart = transition.reason == TaskTransitionReason::restart_repetition
                                      ? "restart-repetition"
                                  : transition.reason == TaskTransitionReason::restart_task
                                      ? "restart-task"
                                      : nullptr;
            if (restart && episode_open)
                episode_attributes["completion"] = restart;
            if (transition.before.phase == TaskRunPhase::active_task && !transition.before.paused)
                end_episode(std::max<int64_t>(0, transition.time_us - record_origin));
            const bool capture =
                transition.after.phase == TaskRunPhase::active_task && !transition.after.paused;
            std::optional<int64_t> capture_end;
            if (!capture)
                capture_end = transition.time_us;
            else if (transition.after.phase_remaining_us) {
                const auto remaining = *transition.after.phase_remaining_us;
                capture_end =
                    transition.time_us +
                    std::min(remaining, std::numeric_limits<int64_t>::max() - transition.time_us);
            }
            // The receiver may run between UI frames. Enforce scheduled boundaries
            // against receipt timestamps before accepting any more observations.
            recorder.set_capture_window(transition.time_us, capture_end);
            const bool was_paused = recorder.status().paused;
            recorder.set_paused(!capture);
            if (restart) {
                recorder.add_episode("Task control", {{"action", restart},
                    {"at_us", std::max<int64_t>(0, transition.time_us - record_origin)},
                    {"task_index", transition.after.task_index},
                    {"repetition", transition.after.repetition}, {"cycle", transition.after.cycle}});
            }
            const bool request_keyframe = capture && was_paused && !recorder.status().failed;
            if (transition.after.phase == TaskRunPhase::active_task && !transition.after.paused &&
                task_specification && !recorder.status().failed) {
                const auto& step = task_specification->tasks.at(transition.after.task_index);
                const auto& description = !step.instructions.empty() && step.instructions != "--"
                                              ? step.instructions
                                          : !task_specification->run_description.empty()
                                              ? task_specification->run_description
                                              : task_specification->run_title;
                start_episode(transition.time_us, description,
                              {{"task_id", step.id},
                               {"task_index", transition.after.task_index},
                               {"repetition", transition.after.repetition},
                               {"cycle", transition.after.cycle}});
            }
            if (request_keyframe) {
                if (auto live_bridge = std::dynamic_pointer_cast<BridgeClient>(source))
                    live_bridge->request_keyframe();
            }
        }
    };
    auto finish_recording = [&] {
        end_episode(monotonic_us() - record_origin);
        recorder.stop();
        manual_recording_pause = false;
        const auto stopped = recorder.status();
        closed_duration = stopped.duration_us;
        text_buffer(session_path, stopped.path.string() + (stopped.failed ? ".partial" : ""));
    };
    auto queue_recording = [&](const std::filesystem::path& path, const ReceiverSnapshot& snap,
                               bool automatic = false) {
        if (pending_recording || recorder.status().recording)
            return;
        if (task_load.valid())
            throw std::runtime_error("Wait for the task specification to load");
        if (source_job.valid() || recovery_job.valid() ||
            std::dynamic_pointer_cast<ReplaySource>(source) ||
            (!options.fixture && (!snap.connected || snap.connection != "Streaming")))
            throw std::runtime_error("Connect a live source before recording");
        pending_recording = PendingRecording{path,       monotonic_us(),   source.get(),
                                             snap.epoch, snap.space_epoch, automatic};
        recording_start_notice.clear();
        recording_count_in_cancelled = false;
        recording_start_delay_seconds = 0;
    };
    bool panels = preferences.panels, preview = preferences.preview, fullscreen = false,
         last_tab = false, last_f11 = false, restore_maximised = false;
    detail::AccordionMotion accordion;
    std::array<float, 10> section_heights{}, section_scroll{};
    float section_width = 0.f;
    int previous_section = -1;
    int restore_x = 80, restore_y = 60, restore_w = options.width, restore_h = options.height;
    bool screenshot_taken = false, auto_record_requested = false;
    Json instrument_bar_metrics, screenshot_bar_metrics;
    Json navigation_metrics, screenshot_navigation_metrics, task_overlay_metrics, screenshot_task_overlay_metrics;
    Json task_timeline_metrics, screenshot_task_timeline_metrics;
    Json scene_spatial_controls, screenshot_spatial_controls;
    std::map<std::string, uint64_t> scene_spatial_actions;
    Json sidebar_metrics, screenshot_sidebar_metrics, visibility_metrics, screenshot_visibility_metrics;
    Json export_ui_metrics, screenshot_export_ui_metrics;
    Json camera_inset_metrics, screenshot_camera_inset_metrics;
    std::map<std::string, uint64_t> visibility_actions;
    std::map<std::string, uint64_t> recording_actions;
    double first = glfwGetTime(), previous = first;
    uint64_t frames = 0;
    Histogram gpu_times, frame_times, video_latencies;
    uint64_t last_presented = 0, last_video = 0, last_secondary = 0, last_stereo = 0,
             last_poses = 0, last_record_bytes = 0;
    double rate_started = first, video_fps = 0, secondary_fps = 0, stereo_hz = 0, pose_hz = 0,
           render_hz = 0, record_mib_s = 0;
    uint64_t rate_frames = 0;
    uint64_t last_head_frames = 0;
    double head_fps = 0;
    std::array<detail::RateHistory<60>, 3> fps_history;
    const SessionSource* rate_source = nullptr;
    Json saved_preferences;
    double preferences_due = first + 1;
    auto persist_preferences = [&] {
        preferences.view = view;
        preferences.panels = panels;
        preferences.preview = preview;
        if (data_path[0])
            preferences.data_path = data_path;
        if (recording_destination[0])
            preferences.recording_destination = recording_destination;
        preferences.task_description = task;
        preferences.task_specification_path = task_specification_path;
        preferences.task_specification = task_specification;
        preferences.hf_organisation = hf_organisation;
        preferences.hf_repository = hf_repository;
        preferences.hf_folder = hf_folder;
        preferences.replay_repository = replay_repository;
        auto json = preferences.to_json();
        if (json != saved_preferences) {
            save_preferences(config / "preferences.json", json);
            saved_preferences = std::move(json);
        }
    };
    auto persist_episodes = [&] {
        if (episodes_dirty && !episode_session.empty() && !recorder.status().recording) {
            save_episodes(episode_session, episodes);
            episodes_dirty = false;
        }
    };
    FramePacer pacer;
    Histogram swap_times, cpu_times, pacing_times, poll_times, snapshot_times, video_update_times,
        scene_cpu_times, ui_cpu_times;
    while (!glfwWindowShouldClose(window)) {
        auto frame_started = std::chrono::steady_clock::now();
        renderer->set_scene_width_fraction(panels ? .8f : 1.f);
        glfwPollEvents();
        scene_spatial_controls = Json::object();
        auto poll_finished = std::chrono::steady_clock::now();
        double now = glfwGetTime(), elapsed_frame = now - previous,
               dt = std::min(.1, elapsed_frame);
        previous = now;
        try {
            if (exporter_presence_check.valid() &&
                exporter_presence_check.wait_for(std::chrono::seconds(0)) == std::future_status::ready) {
                exporter_present = exporter_presence_check.get();
                exporter_presence_due = now + 1.;
            }
            if (!exporter_presence_check.valid() && now >= exporter_presence_due) {
                exporter_presence_due = now + 1.;
                exporter_presence_check = std::async(std::launch::async, [&exporter] {
                    return exporter.exporter_available();
                });
            }
            collect_map_snapshots();
            if (map_loader) {
                const auto status = map_loader->status();
                if (!status.busy) {
                    auto loaded = map_loader->take_loaded();
                    map_loader.reset();
                    try {
                        if (!status.error.empty())
                            throw std::runtime_error(status.error);
                        if (!loaded)
                            throw std::runtime_error("The saved map did not contain a completed snapshot");
                        Renderer::validate_spatial_map_import(*loaded);
                        capture_final_maps();
                        if (!renderer->load_saved_map(*loaded))
                            throw std::runtime_error("The saved map could not be loaded");
                        if (!map_restore)
                            map_restore = MapRestore{view.depth_source, view.voxel_size, view.depth};
                        map_placement = {};
                        saved_map_binding.reset();
                        requested_saved_map_generation = 0;
                        saved_map_world_id = "placed-" + map_run_id + "-" + std::to_string(++map_world_serial);
                        saved_map_file = preferences.map_directory / (saved_map_world_id + ".cmap");
                        loaded_map_file = loading_map_file;
                        loaded_map_protection = std::move(loading_map_protection);
                        placement_error.clear();
                        frame_loaded_map = true;
                        preferences.last_map = loaded_map_file;
                        text_buffer(map_open_path, loaded_map_file.string());
                        view.saved_map_visible = true;
                        view.depth = true;
                        view.map_frozen = true;
                        preferences.section = PaneSection::scene;
                    } catch (...) {
                        loading_map_protection.reset();
                        view.map_frozen = load_previous_frozen;
                        if (load_previous_fusion)
                            renderer->set_saved_map_fusion(true);
                        depth_capture_enabled.store(!renderer->saved_map_state().loaded ||
                                                     renderer->saved_map_state().fusing);
                        throw;
                    }
                }
            }
            if (!automatic_map_freeze && options.freeze_map_after >= 0 &&
                now - first >= options.freeze_map_after) {
                view.map_frozen = true;
                automatic_map_freeze = true;
            }
            if (view.map_frozen && !previous_map_frozen) {
                frozen_environment = view.environment_depth;
                frozen_environment_updates = environment_updates;
                frozen_stereo_pairs = stereo_pair_count;
                request_map_snapshots();
                reset_stereo_acquisition();
            }
            previous_map_frozen = view.map_frozen;
            const auto recording = std::dynamic_pointer_cast<ReplaySource>(source);
            const bool show_recorded_depth = renderer->saved_map_state().loaded &&
                                             recording && recording->has_depth_frames();
            renderer->configure_spatial_map(view.map_frozen && !show_recorded_depth,
                                             view.voxel_size, map_point_budget());
            if (now >= map_snapshot_due) {
                request_map_snapshots();
                map_snapshot_due = now + 2;
            }
        } catch (const std::exception& error) {
            map_error = error.what();
        }
        if (task_load.valid() &&
            task_load.wait_for(std::chrono::seconds(0)) == std::future_status::ready) {
            try {
                auto loaded = task_load.get();
                if (!task_load_cancel.stop_requested()) {
                    task_specification = std::move(loaded);
                    task_run = TaskRun{};
                }
            } catch (const std::exception& error) {
                if (!task_load_cancel.stop_requested()) {
                    ui_error = error.what();
                    if (!options.record.empty() && !options.task_specification.empty()) {
                        automatic_record_error = error.what();
                        auto_record_requested = true;
                    }
                }
            }
            if (task_load_cancel.stop_requested() && !options.record.empty() &&
                !options.task_specification.empty() && !auto_record_requested) {
                automatic_record_error = "Task specification loading was cancelled";
                auto_record_requested = true;
            }
        }
        if (recorder.status().recording && task_specification) {
            std::lock_guard lock(recording_mutex);
            apply_task_transitions(task_run.update(monotonic_us()));
            if (task_run.progress(monotonic_us()).phase == TaskRunPhase::complete)
                finish_recording();
        }
        if (recovery_job.valid() &&
            recovery_job.wait_for(std::chrono::seconds(0)) == std::future_status::ready) {
            try {
                const auto result = recovery_job.get();
                text_buffer(session_path, result.path.string());
                recovery_message = "Recovered " + std::to_string(result.recovered_events) +
                                   " events into a new recording";
            } catch (const std::exception& error) {
                ui_error = error.what();
                recovery_message.clear();
            }
        }
        if (source_job.valid() &&
            source_job.wait_for(std::chrono::seconds(0)) == std::future_status::ready) {
            try {
                source = source_job.get();
                if (!std::dynamic_pointer_cast<ReplaySource>(source))
                    renderer->restore_live_assets();
                calibration = preferences.calibration;
                custom_calibration = preferences.custom_calibration;
                stereo_profile = std::dynamic_pointer_cast<ReplaySource>(source)
                                     ? std::optional<StereoCalibration>{}
                                     : preferences.stereo;
            } catch (const std::exception& e) {
                ui_error = e.what();
                source.reset();
            }
        }
        auto snapshot_started = std::chrono::steady_clock::now();
        ReceiverSnapshot snap;
        if (options.fixture) {
            auto t = monotonic_us();
            fixture.now_us = t;
            if (t >= fixture_pose_due) {
                fixture_pose_due = t + 11111;
                PoseSample head;
                head.kind = 1;
                head.valid = true;
                head.epoch = head.space_epoch = 1;
                head.sequence = uint32_t(fixture.received / 3);
                head.observed_us = head.target_us = head.received_us = t;
                head.values[1] = 1.6f;
                head.values[6] = 1;
                fixture.poses[0] = head;
                fixture.poses[1] = fixture_hand(true, now - first, *fixture_assets);
                fixture.poses[2] = fixture_hand(false, now - first, *fixture_assets);
                for (auto& p : fixture.poses) {
                    event_sink(pose_event(*p));
                    ++fixture.received;
                }
                if (options.fixture_depth && depth_capture_enabled.load() && t >= fixture_depth_due) {
                    fixture_depth_due = t + 33333;
                    constexpr int width = 32, height = 24;
                    constexpr float near_z = .05f, far_z = 10.f;
                    const float focal = 1.f / std::tan(70.f * 3.14159265358979323846f / 360.f);
                    const std::array<float, 16> identity{
                        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
                    auto world = identity;
                    world[12] = head.values[0];
                    world[13] = head.values[1];
                    world[14] = head.values[2];
                    const std::array<float, 16> projection{
                        focal * height / width, 0, 0, 0, 0, focal, 0, 0,
                        0, 0, -(far_z + near_z) / (far_z - near_z), -1,
                        0, 0, -2 * far_z * near_z / (far_z - near_z), 0};
                    const Json metadata{
                        {"version", 1}, {"epoch", head.epoch}, {"space_epoch", head.space_epoch},
                        {"sequence", uint32_t(fixture.depth_frames)},
                        {"observed_us", head.observed_us}, {"target_us", head.target_us},
                        {"width", width}, {"height", height},
                        {"source_width", width}, {"source_height", height},
                        {"eye", "none"}, {"usage", "cpu-optimized"},
                        {"source_format", "unsigned-short"}, {"depth_format", "uint16-mm"},
                        {"world_from_view", world}, {"projection", projection},
                        {"norm_depth_from_norm_view", identity}, {"geometry_source", "sensor"},
                        {"readback_us", 0}, {"target_lead_us", 0}, {"mapping_version", 2}};
                    const auto encoded = metadata.dump();
                    std::vector<uint8_t> bytes{'C', 'E', 'D', '1'};
                    for (int i = 0; i < 4; ++i)
                        bytes.push_back(uint8_t(uint32_t(encoded.size()) >> (i * 8)));
                    bytes.insert(bytes.end(), encoded.begin(), encoded.end());
                    for (int i = 0; i < width * height; ++i) {
                        bytes.push_back(uint8_t(1500 & 255));
                        bytes.push_back(uint8_t(1500 >> 8));
                    }
                    auto depth = make_depth_event(std::move(bytes), t, fixture.clock);
                    depth.attributes["fixture_elapsed_us"] = int64_t((now - first) * 1000000);
                    fixture.depth_bytes += depth.payload.size();
                    ++fixture.depth_frames;
                    fixture.depth_status = "streaming";
                    fixture.depth_usage = "cpu-optimized";
                    event_sink(depth);
                }
            }
            if (!fixture_video.empty() && t >= fixture_video_due) {
                fixture_video_due = t + 33333;
                SessionEvent e;
                e.kind = EventKind::Video;
                e.receive_us = e.time_us = t;
                e.epoch = e.space_epoch = 1;
                e.sequence = uint32_t(fixture.video_frames);
                e.rtp_timestamp = e.sequence * 3000;
                e.stream = "passthrough";
                e.payload = fixture_video[fixture_frame++ % fixture_video.size()];
                e.keyframe = is_idr(e.payload);
                e.attributes = {
                    {"head_pose", {0, 1.6, 0, 0, 0, 0, 1}}, {"width", 640}, {"height", 480}};
                fixture.video_bytes += e.payload.size();
                ++fixture.video_frames;
                event_sink(e);
            }
            snap = fixture;
        } else if (source)
            snap = source->snapshot();
        else {
            snap.now_us = monotonic_us();
            snap.connection = source_job.valid() ? "Opening source" : "Disconnected";
        }
        auto snapshot_finished = std::chrono::steady_clock::now();
        auto replay = std::dynamic_pointer_cast<ReplaySource>(source);
        auto bridge = std::dynamic_pointer_cast<BridgeClient>(source);
        const bool recorded_spatial_data = replay && replay->has_depth_frames();
        const auto current_map_binding = std::tuple{map_connection_serial, snap.epoch, snap.space_epoch};
        auto saved_map = renderer->saved_map_state();
        if (saved_map.loaded && !saved_map.fusing && !map_loader) {
            view.map_frozen = true;
            depth_capture_enabled.store(false);
        }
        if (saved_map.loaded && saved_map_binding && *saved_map_binding != current_map_binding) {
            renderer->stop_saved_map_fusion();
            view.map_frozen = true;
            depth_capture_enabled.store(false);
            saved_map = renderer->saved_map_state();
        }
        if (bridge)
            bridge->set_depth_enabled(depth_capture_enabled.load());
        const auto set_map_fusion = [&](bool enabled) {
            const auto state = renderer->saved_map_state();
            if (enabled && (source_job.valid() || !state.placed || !saved_map_binding ||
                            *saved_map_binding != current_map_binding || (replay && !recorded_spatial_data)))
                return false;
            if (!renderer->set_saved_map_fusion(enabled, enabled
                    ? std::optional<int64_t>(replay ? replay->position_us() : monotonic_us()) : std::nullopt))
                return false;
            view.map_frozen = !enabled;
            depth_capture_enabled.store(enabled);
            environment_seen.reset();
            reset_stereo_acquisition();
            return true;
        };
        const auto place_loaded_map = [&] {
            const auto headset = renderer->headset_transform();
            if (!headset || source_job.valid())
                return false;
            if (!renderer->place_saved_map(map_placement.transform(*headset), snap.epoch,
                                           snap.space_epoch, replay ? replay->position_us() : monotonic_us()))
                return false;
            saved_map_binding = current_map_binding;
            saved_map_world_id = "placed-" + map_run_id + "-" + std::to_string(++map_world_serial);
            saved_map_file = preferences.map_directory / (saved_map_world_id + ".cmap");
            requested_saved_map_generation = 0;
            map_snapshot_due = 0;
            view.map_frozen = true;
            depth_capture_enabled.store(false);
            map_error.clear();
            return true;
        };
        const bool reconstruct_recording = saved_map.loaded && recorded_spatial_data;
        const bool reconstruct_spatial_data = !view.map_frozen || reconstruct_recording;
        if (reconstruct_spatial_data && (map_detached ||
            map_binding != std::tuple{map_connection_serial, snap.epoch, snap.space_epoch})) {
            try {
                begin_map_world(snap.epoch, snap.space_epoch);
            } catch (const std::exception& error) {
                map_error = error.what();
                view.map_frozen = true;
                renderer->configure_spatial_map(true, view.voxel_size, map_point_budget());
            }
        }
        view.map_headset_world_matches = !map_detached &&
            map_binding == std::tuple{map_connection_serial, snap.epoch, snap.space_epoch};
        if (replay != episode_replay) {
            try {
                persist_episodes();
            } catch (const std::exception& error) {
                ui_error = error.what();
            }
            episodes.clear();
            replay_tasks = {};
            episodes_dirty = false;
            episode_open = false;
            episode_session = replay ? replay->path() : std::filesystem::path{};
            episode_replay = replay;
            if (!episode_load.valid())
                episode_loading_replay.reset();
            history_source.reset();
            replay_history = {};
            if (!history_load.valid())
                history_loading_source.reset();
        }
        if (episode_load.valid() &&
            episode_load.wait_for(std::chrono::seconds(0)) == std::future_status::ready) {
            try {
                auto selected = episode_load.get();
                if (episode_loading_replay == replay) {
                    episodes = std::move(selected.episodes);
                    replay_tasks = std::move(selected.tasks);
                    if (!selected.error.empty())
                        ui_error = selected.error;
                }
            } catch (const std::exception& error) {
                if (episode_loading_replay == replay)
                    ui_error = error.what();
            }
            if (!replay)
                episode_loading_replay.reset();
        }
        if (replay && episode_loading_replay != replay && !episode_load.valid()) {
            episode_loading_replay = replay;
            episode_load =
                std::async(std::launch::async, [replay] { return load_episodes(*replay); });
        }
        if (history_load.valid() &&
            history_load.wait_for(std::chrono::seconds(0)) == std::future_status::ready) {
            try {
                auto history = history_load.get();
                if (history_loading_source == replay) {
                    replay_history = std::move(history);
                    history_source = replay;
                }
            } catch (const std::exception& error) {
                ui_error = error.what();
            }
            if (!replay)
                history_loading_source.reset();
        }
        ReceiverSnapshot inspection = snap;
        const auto pose_offset = detail::presentation_pose_offset_us(bool(replay), view.pose_time_offset_ms);
        if (replay && pose_offset != 0) {
            inspection.poses = {};
            auto target = replay->position_us() - pose_offset;
            if (target >= 0 && target <= replay->duration_us() && !history_load.valid() &&
                (history_source != replay ||
                 (replay_history.start_us > 0 && target < replay_history.start_us + 250000) ||
                 (replay_history.end_us < replay->duration_us() &&
                  target > replay_history.end_us - 250000))) {
                auto start = std::max<int64_t>(0, target - 750000),
                     end = std::min(replay->duration_us(), target + 1250000);
                history_loading_source = replay;
                history_load = std::async(std::launch::async, [replay, start, end] {
                    return PoseHistory{start, end, replay->pose_history(start, end)};
                });
            }
            if (history_source == replay && target >= 0 && target <= replay->duration_us()) {
                for (const auto& event : replay_history.samples) {
                    auto sample_time = event.attributes.at("session_time_us").get<int64_t>();
                    if (sample_time > target)
                        break;
                    if (sample_time < target - 50000 || event.epoch != snap.epoch ||
                        event.space_epoch != snap.space_epoch)
                        continue;
                    try {
                        auto pose = decode_pose(
                            event.payload,
                            snap.now_us + event.attributes.at("session_receive_us").get<int64_t>() - target);
                        pose.observed_us = snap.now_us + sample_time - target;
                        inspection.poses.at(pose.kind - 1) = std::move(pose);
                    } catch (const std::exception& error) {
                        ui_error = error.what();
                    }
                }
                inspection.clock.rate = 1;
                inspection.clock.offset_us = 0;
            }
        }
        auto calibration_changed = [&] {
            preferences.calibration = calibration;
            preferences.custom_calibration = custom_calibration;
            reset_stereo_acquisition();
            recorder.push(calibration_event(snap.epoch, snap.space_epoch));
        };
        if (!options.record.empty() && !auto_record_requested && !task_load.valid() &&
            (options.fixture || (snap.connected && snap.connection == "Streaming"))) {
            try {
                queue_recording(options.record, snap, true);
                auto_record_requested = true;
            } catch (const std::exception& e) {
                ui_error = automatic_record_error = e.what();
                auto_record_requested = true;
            }
        }
        {
            std::deque<SessionEvent> events;
            {
                std::lock_guard lock(controls_mutex);
                // The opening source can emit its initial controls before its
                // future is adopted. Apply them only after restoring source defaults.
                if (!source_job.valid())
                    events.swap(controls);
            }
            for (auto& e : events) {
                try {
                    if (e.kind == EventKind::Calibration && e.attributes.contains("profile")) {
                        calibration = Calibration::from_json(e.attributes["profile"]);
                        custom_calibration = true;
                        if (e.attributes.contains("stereo_profile")) {
                            stereo_profile.reset();
                            if (!e.attributes.at("stereo_profile").is_null())
                                stereo_profile =
                                    StereoCalibration::from_json(e.attributes.at("stereo_profile"));
                        }
                        reset_stereo_acquisition();
                    } else if (e.kind == EventKind::Epoch && !recording_marker(e)) {
                        if (replay && e.attributes.value("reason", std::string{}) == "seek" &&
                            renderer->saved_map_state().loaded) {
                            renderer->stop_saved_map_fusion();
                            view.map_frozen = true;
                            depth_capture_enabled.store(false);
                        }
                        if (reconstruct_spatial_data)
                            begin_map_world(snap.epoch, snap.space_epoch);
                        reset_environment();
                        if (replay && e.attributes.value("reason", std::string{}) == "seek")
                            stereo_profile.reset();
                        reset_stereo_acquisition();
                        renderer->invalidate_video();
                    } else if (e.kind == EventKind::Asset && !e.payload.empty()) {
                        renderer->restore_hand_asset(e);
                        renderer->restore_headset_asset(e);
                    }
                } catch (const std::exception& error) {
                    ui_error = error.what();
                }
            }
        }
        if (!custom_calibration && snap.camera.width > 0 && snap.camera.height > 0 &&
            (calibration.width != snap.camera.width || calibration.height != snap.camera.height ||
             calibration.side != snap.camera.side) &&
            snap.connected) {
            auto next = Calibration::quest(snap.camera.width, snap.camera.height, snap.camera.side);
            next.flip_x = calibration.flip_x;
            next.flip_y = calibration.flip_y;
            calibration = std::move(next);
            recorder.push(calibration_event(snap.epoch, snap.space_epoch));
        }
        auto decoder_status = decoder->status();
        auto secondary_status = secondary_decoder->status();
        if ((decoder_status.needs_keyframe ||
             (snap.camera.cameras.size() == 2 && secondary_status.needs_keyframe)) &&
            bridge)
            bridge->request_keyframe();
        auto video_update_started = std::chrono::steady_clock::now();
        if (mapped_voxel_size != view.voxel_size) {
            mapped_voxel_size = view.voxel_size;
            reset_stereo_acquisition();
            environment_seen.reset();
        }
        if (previous_depth_source != view.depth_source) {
            reset_stereo_acquisition();
            previous_depth_source = view.depth_source;
        }
        if (!source_job.valid()) {
            std::lock_guard lock(controls_mutex);
            if (pending_depth) {
                environment_event = std::move(pending_depth);
                pending_depth.reset();
            }
        }
        if (environment_event && (environment_event->epoch != snap.epoch ||
                                  environment_event->space_epoch != snap.space_epoch)) {
            reset_environment();
        }
        if (environment_event) {
            environment_available = true;
            environment_usage = environment_event->attributes.value("usage", std::string{});
        }
        view.environment_depth = reconstruct_recording ? true : view.map_frozen ? frozen_environment :
            (view.depth_source == 1 || (view.depth_source == 0 && environment_available));
        if (reconstruct_spatial_data && view.environment_depth && environment_event && !source_job.valid() &&
            environment_seen != stereo_frame_identity(*environment_event)) {
            try {
                const auto& event = *environment_event;
                const auto time =
                    replay ? event.attributes.at("session_time_us").get<int64_t>() : event.time_us;
                if (renderer->update_environment_depth(event, view.depth_min, view.depth_max,
                                                       view.voxel_size, time, observed_hands(event))) {
                    environment_seen = stereo_frame_identity(event);
                    ++environment_updates;
                }
            } catch (const std::exception& error) {
                ui_error = error.what();
                environment_seen = stereo_frame_identity(*environment_event);
            }
        }
        std::array<VideoFrameLease, 2> camera_frames{decoder->latest(),
                                                     secondary_decoder->latest()};
        const bool dual_camera = snap.camera.cameras.size() == 2;
        std::array<std::array<int, 2>, 2> quest_dimensions{{{640, 480}, {640, 480}}};
        if (stereo_profile && stereo_profile->preset_id == "quest3-stereo-v1") {
            quest_dimensions[0] = {stereo_profile->left.width, stereo_profile->left.height};
            quest_dimensions[1] = {stereo_profile->right.width, stereo_profile->right.height};
        }
        const auto accept_quest_dimensions = [&](const std::string& side, int width, int height) {
            if ((side == "left" || side == "right") && width >= 32 && height >= 32 &&
                width <= 8192 && height <= 8192 && width % 2 == 0 && height % 2 == 0)
                quest_dimensions[side == "left" ? 0 : 1] = {width, height};
        };
        accept_quest_dimensions(snap.camera.side, snap.camera.width, snap.camera.height);
        for (const auto& camera : snap.camera.cameras)
            accept_quest_dimensions(camera.side, camera.width, camera.height);
        for (size_t i = 0; i < (dual_camera ? 2u : 1u); ++i) {
            const auto& frame = camera_frames[i];
            if (!frame || frame.image->event.epoch != snap.epoch ||
                frame.image->event.space_epoch != snap.space_epoch)
                continue;
            const auto side = frame.image->event.attributes.value(
                "camera_side", i == 0 ? snap.camera.side : snap.camera.cameras[i].side);
            accept_quest_dimensions(side, frame.image->width, frame.image->height);
        }
        const auto quest_stereo = [&] {
            auto profile = StereoCalibration::quest(quest_dimensions[0][0], quest_dimensions[0][1]);
            profile.right =
                Calibration::quest(quest_dimensions[1][0], quest_dimensions[1][1], "right");
            return profile;
        };
        if (!replay && !source_job.valid() && snap.connected && stereo_profile &&
            stereo_profile->preset_id == "quest3-stereo-v1" &&
            (stereo_profile->left.width != quest_dimensions[0][0] ||
             stereo_profile->left.height != quest_dimensions[0][1] ||
             stereo_profile->right.width != quest_dimensions[1][0] ||
             stereo_profile->right.height != quest_dimensions[1][1])) {
            stereo_profile = quest_stereo();
            preferences.stereo = stereo_profile;
            reset_stereo_acquisition();
            recorder.push(calibration_event(snap.epoch, snap.space_epoch));
        }
        const auto stereo_now_us = monotonic_us();
        const auto acquisition =
            stereo_cadence.update(stereo_now_us, view.stereo_update_hz,
                                   reconstruct_spatial_data && !view.environment_depth && dual_camera &&
                                      stereo_profile.has_value() && !source_job.valid());
        if (!acquisition.acquire || acquisition.opened)
            stereo_pairs.clear();
        if (acquisition.opened) {
            ++stereo_window_count;
            stereo_state = "Waiting for camera timing";
        }
        for (size_t camera_index = 0; !source_job.valid() && camera_index < (dual_camera ? 2u : 1u);
             ++camera_index) {
            const auto& frame = camera_frames[camera_index];
            if (!frame || frame.image->event.epoch != snap.epoch ||
                frame.image->event.space_epoch != snap.space_epoch)
                continue;
            const auto side = frame.image->event.attributes.value(
                "camera_side",
                camera_index == 0 ? snap.camera.side : snap.camera.cameras[camera_index].side);
            auto camera_calibration =
                camera_index == 0
                    ? calibration
                    : Calibration::quest(frame.image->width, frame.image->height, side);
            if (dual_camera && stereo_profile && (side == "left" || side == "right"))
                camera_calibration = side == "left" ? stereo_profile->left : stereo_profile->right;
            renderer->update_video(frame, camera_calibration, view.undistort, camera_index);
            if (acquisition.acquire && (side == "left" || side == "right") &&
                (replay || stereo_now_us - frame.image->event.receive_us <= 250000)) {
                const auto& event = frame.image->event;
                // Queue-local sequence checks reject duplicates within a window.
                // Only integrated images stay consumed across separate windows.
                if (stereo_seen[side == "left" ? 0 : 1] != stereo_frame_identity(event))
                    stereo_pairs.push(frame, event);
            }
        }
        if (!reconstruct_spatial_data || !dual_camera || !stereo_profile || view.environment_depth) {
            stereo_state = view.map_frozen ? "Map frozen"
                           : !dual_camera    ? "Two cameras required"
                           : !stereo_profile ? "Load stereo calibration"
                                             : "Off";
        } else if (acquisition.acquire) {
            if (auto pair = stereo_pairs.take(int64_t(view.stereo_skew_ms * 1000))) {
                ++stereo_attempt_count;
                try {
                    const auto& event = pair->left.image->event;
                    const auto observation_time =
                        replay ? event.attributes.at("session_time_us").get<int64_t>()
                               : event.time_us;
                    if (observation_time < 0)
                        throw std::runtime_error("Invalid stereo observation time");
                    if (renderer->update_stereo(pair->left, pair->right, *stereo_profile,
                                                view.depth_min, view.depth_max, view.voxel_size,
                                                observation_time, observed_hands(event))) {
                        ++stereo_pair_count;
                        stereo_seen[0] = stereo_frame_identity(pair->left.image->event);
                        stereo_seen[1] = stereo_frame_identity(pair->right.image->event);
                        stereo_last_pair_us = stereo_now_us;
                        stereo_pair_skew_ms = pair->skew_us / 1000.0;
                        stereo_state = "Updating space";
                    } else
                        stereo_state = "Waiting for head association";
                } catch (const std::exception& error) {
                    stereo_state = error.what();
                }
                // Both a submitted update and a rejected pair end this window.
                // Rendering retains accepted GPU leases only until work completes.
                stereo_cadence.finish();
                stereo_pairs.clear();
            }
        }
        auto video_update_finished = std::chrono::steady_clock::now();
        float current_dpi = 1;
        glfwGetWindowContentScale(window, &current_dpi, nullptr);
        current_dpi = std::clamp(current_dpi, .75f, 4.f);
        if (std::abs(current_dpi - dpi) > .01f) {
            dpi = current_dpi;
            ui::apply_style(dpi);
            ImGui_ImplOpenGL3_DestroyFontsTexture();
            load_fonts();
        }
        ImGui_ImplOpenGL3_NewFrame();
        ImGui_ImplGlfw_NewFrame();
        ImGui::NewFrame();
        const auto& instrument_style = ImGui::GetStyle();
        const float instrument_height =
            readout_font->FontSize + io.FontDefault->FontSize + ui::metrics().panel_padding +
            instrument_style.CellPadding.y * 2.f + instrument_style.ItemSpacing.y * 2.f + 2.f * dpi;
        const float task_track_height = replay && !replay_tasks.tasks().empty() ? 32.f * dpi : 0.f;
        const float replay_transport_height = instrument_height + task_track_height;
        if (ImGui::IsKeyPressed(ImGuiKey_Escape, false)) {
            cancel_count_in();
            if (!io.WantTextInput)
                ImGui::SetWindowFocus(nullptr);
        }
        const bool focus_controls = ImGui::IsKeyPressed(ImGuiKey_F6, false);
        const bool focus_record = ImGui::IsKeyPressed(ImGuiKey_F7, false);
        const bool focus_visibility = ImGui::IsKeyPressed(ImGuiKey_F8, false);
        if (focus_controls || focus_visibility)
            panels = true;
        bool tab = glfwGetKey(window, GLFW_KEY_TAB) == GLFW_PRESS,
             f11 = glfwGetKey(window, GLFW_KEY_F11) == GLFW_PRESS;
        if (tab && !last_tab && (!panels || !io.WantCaptureKeyboard))
            panels = !panels;
        if (f11 && !last_f11) {
            if (!fullscreen) {
                auto* monitor = window_monitor(window);
                auto* mode = monitor ? glfwGetVideoMode(monitor) : nullptr;
                if (mode) {
                    restore_maximised = glfwGetWindowAttrib(window, GLFW_MAXIMIZED) == GLFW_TRUE;
                    if (restore_maximised)
                        glfwRestoreWindow(window);
                    glfwGetWindowPos(window, &restore_x, &restore_y);
                    glfwGetWindowSize(window, &restore_w, &restore_h);
                    int x, y;
                    glfwGetMonitorPos(monitor, &x, &y);
                    glfwSetWindowAttrib(window, GLFW_DECORATED, GLFW_FALSE);
                    glfwSetWindowPos(window, x, y);
                    glfwSetWindowSize(window, mode->width, mode->height);
                    fullscreen = true;
                }
            } else {
                glfwSetWindowAttrib(window, GLFW_DECORATED, GLFW_TRUE);
                glfwSetWindowPos(window, restore_x, restore_y);
                glfwSetWindowSize(window, restore_w, restore_h);
                if (restore_maximised)
                    glfwMaximizeWindow(window);
                fullscreen = false;
            }
        }
        last_tab = tab;
        last_f11 = f11;
        const float scene_width = panels ? std::floor(io.DisplaySize.x * .8f) : io.DisplaySize.x;
        std::array<bool, 2> explicit_video_preview{};
        auto scene_started = std::chrono::steady_clock::now();
        renderer->set_scene_width_fraction(panels ? .8f : 1.f);
        renderer->set_scene_top_fraction(instrument_height / std::max(1.f, io.DisplaySize.y));
        renderer->set_scene_bottom_fraction(replay ? replay_transport_height / std::max(1.f, io.DisplaySize.y) : 0.f);
        const bool navigation_capture = scene_navigation(*renderer, scene_navigation_state, instrument_height, dpi,
            options.metrics.empty() ? nullptr : &navigation_metrics);
        ReplayTask live_scene_task;
        const ReplayTask* scene_task = replay ? replay_tasks.at(replay->position_us()) : nullptr;
        if (!replay) {
            const auto progress = task_run.progress(monotonic_us());
            const auto* step = task_run.current_task();
            const bool ready = progress.phase == TaskRunPhase::stopped;
            if (ready && task_specification && !task_specification->tasks.empty())
                step = &task_specification->tasks.front();
            if (step && task_specification) {
                live_scene_task.title = step->label;
                live_scene_task.description = step->instructions;
                live_scene_task.task_number = ready ? 1 : progress.task_index + 1;
                live_scene_task.task_count = task_specification->tasks.size();
                live_scene_task.cycle = ready ? 1 : progress.cycle;
                live_scene_task.cycle_count = task_specification->cycle_count;
                live_scene_task.repetition = ready ? 1 : progress.repetition;
                live_scene_task.repeat_count = step->repeat_count;
                scene_task = &live_scene_task;
            } else if (!task_specification && task[0]) {
                live_scene_task.description = task;
                scene_task = &live_scene_task;
            }
        }
        const bool task_capture = scene_task_overlay(scene_task, scene_width, instrument_height,
            replay ? replay_transport_height : 0.f, dpi, options.metrics.empty() ? nullptr : &task_overlay_metrics);
        renderer->process_input(dt, io.WantCaptureMouse || navigation_capture || task_capture, io.WantCaptureKeyboard);
        const auto trail_time =
            replay ? std::max<int64_t>(0, replay->position_us() -
                                              int64_t(view.pose_time_offset_ms * 1000))
                   : inspection.now_us;
        const auto scene_time = replay ? replay->position_us() : snap.now_us;
        if (!source_job.valid())
            renderer->update_headset_position(snap, replay ? replay->speed() : 1.);
        if (renderer->saved_map_state().loaded && !renderer->saved_map_state().placed) {
            try {
                renderer->set_saved_map_transform(map_placement.transform(
                    renderer->headset_transform().value_or(glm::mat4(1.f))));
                placement_error.clear();
            } catch (const std::exception& error) {
                placement_error = error.what();
            }
        }
        auto scene_view = view;
        if (!replay)
            scene_view.pose_time_offset_ms = 0;
        if (replay && !recorded_spatial_data)
            scene_view.recorded_map_visible = false;
        renderer->draw(inspection, calibration, scene_view, trail_time,
                       replay && view.pose_time_offset_ms == 0 ? replay->speed() : 1., scene_time);
        if (frame_loaded_map && renderer->select_scene_reference(SceneReference::model)) {
            renderer->select_scene_view(SceneView::iso);
            frame_loaded_map = false;
        }
        auto scene_finished = std::chrono::steady_clock::now();
        auto record_status = recorder.status();
        auto export_status = exporter.status();
        if (!options.metrics.empty())
            export_ui_metrics = {{"exporter_present", exporter_present}, {"disclosure", nullptr},
                                 {"action", nullptr}};
        const auto hf_status = hugging_face.status();
        if (hf_new_code && !hf_status.running) {
            hf_new_code = false;
            hugging_face.sign_in();
        }
        if (auto downloaded = hugging_face.take_download(); !downloaded.empty())
            hf_ready_recording = std::move(downloaded);
        if (!hf_ready_recording.empty() && !source_job.valid() && !record_status.recording &&
            !pending_recording) {
            text_buffer(session_path, hf_ready_recording.string());
            change_source(hf_ready_recording, false);
            hf_ready_recording.clear();
        }
        const auto hf_account_controls = [&](bool show_account = true) {
            ImGui::PushID("HuggingFaceAccount");
            if (show_account && hf_status.username.empty()) {
                ImGui::BeginDisabled(hf_status.running);
                if (ui::primary_button("Sign in to Hugging Face"))
                    hugging_face.sign_in();
                ImGui::EndDisabled();
            } else if (show_account) {
                ImGui::TextWrapped("Signed in as %s", hf_status.username.c_str());
                ImGui::BeginDisabled(hf_status.running);
                if (ImGui::Button("Sign out")) hugging_face.sign_out();
                same_line_if_room("Sign in again");
                if (ImGui::Button("Sign in again")) hugging_face.sign_in();
                ImGui::EndDisabled();
            }
            if (hf_status.running) {
                ImGui::ProgressBar(hf_status.progress, {-1, 0}, hf_status.message.c_str());
                if (ImGui::Button("Cancel##HuggingFace")) hugging_face.cancel();
            } else if (!hf_status.message.empty())
                ImGui::TextWrapped("%s", hf_status.message.c_str());
            if (!hf_status.error.empty()) {
                ImGui::PushStyleColor(ImGuiCol_Text, ui::colour::red);
                ImGui::TextWrapped("%s", hf_status.error.c_str());
                ImGui::PopStyleColor();
            }
            ImGui::PopID();
        };
        if (rate_source != source.get()) {
            rate_source = source.get();
            fps_history = {};
            last_head_frames = accepted_head_frames.load(std::memory_order_relaxed);
            last_video = decoder_status.decoded;
            rate_started = now;
            rate_frames = frames;
            head_fps = video_fps = render_hz = 0;
        }
        if (now - rate_started >= 1) {
            double elapsed = now - rate_started;
            video_fps =
                (decoder_status.decoded >= last_video ? decoder_status.decoded - last_video : 0) /
                elapsed;
            secondary_fps = (secondary_status.decoded >= last_secondary
                                 ? secondary_status.decoded - last_secondary
                                 : 0) /
                            elapsed;
            stereo_hz = (stereo_pair_count - last_stereo) / elapsed;
            environment_hz = (environment_updates - last_environment_updates) / elapsed;
            last_environment_updates = environment_updates;
            pose_hz = (snap.received >= last_poses ? snap.received - last_poses : 0) / elapsed;
            render_hz = (frames - rate_frames) / elapsed;
            const auto head_frames = accepted_head_frames.load(std::memory_order_relaxed);
            head_fps = (head_frames - last_head_frames) / elapsed;
            last_head_frames = head_frames;
            fps_history[0].sample(now, float(head_fps));
            fps_history[1].sample(now, float(video_fps));
            fps_history[2].sample(now, float(render_hz));
            record_mib_s = (record_status.written_bytes >= last_record_bytes
                                ? record_status.written_bytes - last_record_bytes
                                : 0) /
                           (elapsed * 1048576.0);
            last_record_bytes = record_status.written_bytes;
            last_video = decoder_status.decoded;
            last_secondary = secondary_status.decoded;
            last_stereo = stereo_pair_count;
            last_poses = snap.received;
            rate_frames = frames;
            rate_started = now;
        }
        ImVec2 sidebar_heading_first{}, sidebar_heading_last{};
        if (!options.metrics.empty()) {
            sidebar_metrics = nullptr;
            visibility_metrics = nullptr;
        }
        if (panels) {
            ImGui::SetNextWindowPos({scene_width, 0}, ImGuiCond_Always);
            ImGui::SetNextWindowSize({io.DisplaySize.x - scene_width, io.DisplaySize.y},
                                    ImGuiCond_Always);
            ImGui::SetNextWindowScroll({0, 0});
            ImGui::PushStyleVar(ImGuiStyleVar_WindowRounding, 0);
            ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0, 0));
            ImGui::Begin("Controls", nullptr,
                         ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoMove |
                             ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoDocking |
                              ImGuiWindowFlags_NoSavedSettings |
                              ImGuiWindowFlags_NoFocusOnAppearing | ImGuiWindowFlags_NoScrollbar |
                              ImGuiWindowFlags_NoScrollWithMouse);
            const auto& style = ImGui::GetStyle();
            ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(12.f * dpi, 8.f * dpi));
            ImGui::BeginChild("Sidebar heading", {0, instrument_height},
                              ImGuiChildFlags_AlwaysUseWindowPadding,
                              ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoScrollWithMouse);
            ImGui::PopStyleVar();
            sidebar_heading_first = ImGui::GetWindowPos();
            const auto heading_size = ImGui::GetWindowSize();
            sidebar_heading_last = {sidebar_heading_first.x + heading_size.x,
                                     sidebar_heading_first.y + heading_size.y};
            ImGui::PushFont(title_font);
            ImGui::TextUnformatted("Ceres");
            ImGui::PopFont();
            ImGui::SameLine();
            ui::muted("Bridge");
            if (ImGui::BeginTable("Tracking signals", 3, ImGuiTableFlags_SizingStretchSame)) {
                const auto pose_now = snap.now_us ? snap.now_us : monotonic_us();
                for (size_t i = 0; i < snap.poses.size(); ++i) {
                    ImGui::TableNextColumn();
                    const auto& pose = snap.poses[i];
                    const bool fresh =
                        pose && pose->valid && snap.clock.valid &&
                        pose_now - pose->received_us <= 50000 &&
                        pose_now - (pose->observed_us * snap.clock.rate + snap.clock.offset_us) +
                                snap.clock.uncertainty_us <= 50000;
                    ui::indicator(i == 0 ? "Head" : i == 1 ? "Left" : "Right", fresh);
                }
                ImGui::EndTable();
            }
            ImGui::EndChild();
            ImGui::GetWindowDrawList()->AddLine(
                {scene_width, instrument_height - dpi},
                {io.DisplaySize.x, instrument_height - dpi},
                ImGui::GetColorU32(ui::colour::border), dpi);
            const float footer_height = ui::metrics().row_height + ui::metrics().unit * 2.f;
            ImGui::SetCursorPosY(instrument_height + style.ItemSpacing.y);
            ImGui::BeginChild("Sections", {0, std::max(1.f, io.DisplaySize.y -
                                         instrument_height - footer_height - style.ItemSpacing.y * 2.f)},
                              0, ImGuiWindowFlags_NoScrollbar);
            ImGui::PushItemWidth(-1);
            if (!ui_error.empty()) {
                ImGui::PushStyleColor(ImGuiCol_Text, ui::colour::red);
                ImGui::TextWrapped("%s", ui_error.c_str());
                ImGui::PopStyleColor();
                if (ImGui::SmallButton("Dismiss"))
                    ui_error.clear();
                ImGui::Separator();
            }
            if (focus_controls) {
                ImGui::SetWindowFocus();
                ImGui::SetKeyboardFocusHere();
                ImGui::SetNavCursorVisible(true);
            }
            const float header_height = ImGui::GetTextLineHeight() + 12.f * dpi;
            const float body_height = std::max(
                1.f, ImGui::GetContentRegionAvail().y -
                         float(section_heights.size()) * (header_height + style.ItemSpacing.y) -
                         style.ItemSpacing.y);
            if (std::abs(section_width - ImGui::GetContentRegionAvail().x) > 1.f) {
                section_heights.fill(0.f);
                section_width = ImGui::GetContentRegionAvail().x;
            }
            accordion.update(static_cast<int>(preferences.section), section_heights, body_height,
                             io.DeltaTime);
            const auto visible_section = static_cast<PaneSection>(accordion.displayed());
            Json section_metrics;
            if (!options.metrics.empty())
                section_metrics = Json::array();
            const auto section = [&](const char* label, const char* index, PaneSection value) {
                const bool selected = preferences.section == value;
                bool open = selected;
                ui::section(label, index, open);
                if (!options.metrics.empty()) {
                    const auto first = ImGui::GetItemRectMin(), last = ImGui::GetItemRectMax();
                    section_metrics.push_back({{"label", label}, {"open", open},
                                               {"bounds", {{first.x, first.y}, {last.x, last.y}}}});
                }
                if (open != selected)
                    preferences.section = open ? value : PaneSection::none;
                return visible_section == value && accordion.height() >= 1.f;
            };
            const auto begin_body = [&](const char* id) {
                const auto index = static_cast<size_t>(accordion.displayed());
                const bool in_motion = accordion.moving();
                if (previous_section != accordion.displayed() || in_motion)
                    ImGui::SetNextWindowScroll({-1.f, section_scroll[index]});
                ImGui::BeginDisabled(in_motion || visible_section != preferences.section);
                ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(12.f * dpi, 8.f * dpi));
                ImGui::BeginChild(id, {0, std::max(4.f, accordion.height())},
                                  ImGuiChildFlags_AlwaysUseWindowPadding,
                                  (visible_section == PaneSection::scene ? 0 : ImGuiWindowFlags_NoScrollbar) |
                                      (in_motion ? ImGuiWindowFlags_NoMouseInputs : 0));
                ImGui::PopStyleVar();
            };
            const auto end_body = [&] {
                const auto index = static_cast<size_t>(accordion.displayed());
                if (accordion.height() >= ImGui::GetTextLineHeight() + 16.f * dpi)
                    section_heights[index] =
                        ImGui::GetCursorPosY() + 8.f * dpi - style.ItemSpacing.y;
                if (!accordion.moving())
                    section_scroll[index] = ImGui::GetScrollY();
                ImGui::EndChild();
                ImGui::EndDisabled();
            };
            if (section("Connection", "01", PaneSection::connection)) {
                begin_body("Connection body");
                ImGui::PushID("Connection");
                if (!snap.pairing_url.empty() && !snap.code.empty()) {
                    ImGui::PushFont(readout_font);
                    const float code_width = ImGui::CalcTextSize(snap.code.c_str()).x;
                    ImGui::PopFont();
                    const float qr_space =
                        ImGui::GetContentRegionAvail().x - code_width - style.ItemSpacing.x;
                    const bool inline_code = qr_space >= 104.f * dpi;
                    qr_code(snap.pairing_url,
                            inline_code ? std::min(132.f * dpi, qr_space)
                                        : std::min(132.f * dpi, ImGui::GetContentRegionAvail().x));
                    if (inline_code)
                        ImGui::SameLine();
                    ImGui::BeginGroup();
                    ui::field_label("Access code");
                    ImGui::PushFont(readout_font);
                    ImGui::PushStyleColor(ImGuiCol_Text, ui::colour::amber);
                    ImGui::TextUnformatted(snap.code.c_str());
                    ImGui::PopStyleColor();
                    ImGui::PopFont();
                    if (ImGui::Button("Copy"))
                        ImGui::SetClipboardText(snap.code.c_str());
                    ui::help("Enter the access code in Ceres Bridge on the headset.");
                    ImGui::EndGroup();
                    ImGui::Separator();
                }
                ui::indicator(replay            ? "Replay"
                              : options.fixture ? "Preview"
                                                : snap.connection.c_str(),
                              snap.connected);
                ui::help(options.origin.c_str());
                if (bridge) {
                    const float action_width = ImGui::CalcTextSize("Disconnect").x +
                                               style.FramePadding.x * 2.f +
                                               style.CellPadding.x * 2.f;
                    if (ImGui::BeginTable(
                            "Pairing actions",
                            ImGui::GetContentRegionAvail().x >= action_width * 2.f ? 2 : 1,
                            ImGuiTableFlags_SizingStretchSame)) {
                        ImGui::TableNextColumn();
                        if (ImGui::Button("Disconnect", {-1, 0}))
                            change_source({}, false);
                        ImGui::TableNextColumn();
                        if (ImGui::Button("Pair again", {-1, 0})) {
                            cancel_count_in("Recording cancelled: pairing changed");
                            bridge->fresh_pairing();
                        }
                        ImGui::EndTable();
                    }
                } else if (!options.fixture && !source_job.valid()) {
                    if (ImGui::Button("Connect"))
                        change_source({}, true);
                }
                if (!snap.error.empty())
                    ImGui::TextWrapped("%s", snap.error.c_str());
                ImGui::PopID();
                end_body();
            }
            if (section("Hands", "02", PaneSection::hands)) {
                begin_body("Hands body");
                ImGui::PushID("Hands");
                const char* levels[] = {"Outline", "Points", "Bones", "Mesh"};
                const char* colours[] = {"Side", "Normals", "Velocity", "Motion flow (Middlebury)"};
                const char* trails[] = {"Hand (COG)", "Joints", "Bones", "Fingertips"};
                pane_selector("Level", view.hand_level, levels);
                pane_selector("Colours", view.hand_colour, colours);
                ImGui::Separator();
                int trail_mode = std::clamp(static_cast<int>(view.trail_mode) - 1, 0, 3);
                pane_selector("Trails", trail_mode, trails);
                view.trail_mode = static_cast<TrailMode>(trail_mode + 1);
                ImGui::PushID("Trails");
                pane_selector("Colours", view.trail_colour, colours);
                ImGui::PopID();
                pane_slider("Trail span", &view.trail_seconds, .25f, 5.f, "%.2f s");
                ImGui::Separator();
                if (replay) {
                    pane_slider("Delay", &view.pose_time_offset_ms, -500.f, 500.f, "%+.0f ms");
                    ui::help("Positive values inspect earlier tracking. Recording and export retain source timestamps.");
                }
                ImGui::PopID();
                end_body();
            }
            if (section("Spatial map", "03", PaneSection::depth)) {
                begin_body("Depth body");
                ImGui::PushID("Depth");
                ImGui::PushID("Map");
                ui::subsection("Acquisition", true);
                const float map_action_width =
                    std::max(1.f, (ImGui::GetContentRegionAvail().x - style.ItemSpacing.x) * .5f);
                const bool compact_map_actions =
                    ImGui::CalcTextSize("Resume map").x + style.FramePadding.x * 2.f > map_action_width;
                ImGui::BeginDisabled(saved_map.loaded || map_loader != nullptr);
                if (ImGui::Button(view.map_frozen
                                      ? (compact_map_actions ? "Resume###FreezeMap" : "Resume map###FreezeMap")
                                      : (compact_map_actions ? "Freeze###FreezeMap" : "Freeze map###FreezeMap"),
                                  {map_action_width, 0})) {
                    view.map_frozen = !view.map_frozen;
                    if (view.map_frozen)
                        frozen_environment = view.environment_depth;
                }
                ImGui::EndDisabled();
                ui::help(saved_map.loaded ? "Use FUSE in Scene to resume capture into the saved map."
                         : "Freeze or resume map observations. Distance colours keep updating.");
                ImGui::SameLine();
                if (ImGui::Button(compact_map_actions ? "Clear###ClearMap" : "Clear map###ClearMap",
                                  {map_action_width, 0})) {
                    try {
                        begin_map_world(snap.epoch, snap.space_epoch);
                    } catch (const std::exception& error) {
                        map_error = error.what();
                    }
                }
                ui::help("Starts a new map. Previous saved maps remain available.");
                const size_t retained_points = renderer->map_point_count(view.environment_depth);
                const size_t live_point_limit = map_point_budget();
                ImGui::PushStyleColor(ImGuiCol_Text, ui::colour::muted);
                ImGui::TextWrapped("%s: %zu/%zu points", view.map_frozen ? "Frozen" : "Acquiring",
                                   retained_points, live_point_limit);
                ImGui::PopStyleColor();
                ImGui::ProgressBar(live_point_limit ? std::clamp(float(retained_points) / float(live_point_limit), 0.f, 1.f) : 0.f,
                                   {-1.f, ui::metrics().unit * 2.f}, "");
                ui::help("Retained map points as a proportion of the live limit. Max size sets this allowance.");
                const char* detail[] = {"Full", "Adaptive"};
                pane_selector("Detail", view.depth_lod, detail);
                ui::help("Adaptive keeps repeatedly confirmed surfaces detailed and groups uncertain observations. "
                         "Looking away does not reduce stored detail.");
                float voxel_cm = view.voxel_size * 100.f;
                if (pane_slider("Spacing", &voxel_cm, 1.f, 10.f, "%.1f cm"))
                    view.voxel_size = voxel_cm / 100.f;
                ui::help("Fusion resolution. Existing geometry is retained when this changes.");
                float density = view.map_density * 100.f;
                if (pane_slider("Density", &density, 1.f, 100.f, "%.0f %%"))
                    view.map_density = density / 100.f;
                ui::help("Visible samples only. Reliable, repeatedly observed surfaces take priority. "
                         "Changing density does not discard saved geometry.");
                ImGui::Checkbox("Mask hands", &view.mask_hands);
                ui::help("Exclude tracked fingers and palms while preserving the surfaces behind them.");
                ui::subsection("Appearance");
                const char* map_styles[] = {"Points", "Shape"};
                pane_selector("View", view.map_style, map_styles);
                ui::help("Shape adds depth shading to reveal boundaries and overlapping surfaces.");
                if (view.map_style == SpatialMapStyle::shape)
                    pane_slider("Relief", &view.map_relief_strength, 0.f, 3.f, "%.1f");
                const char* map_shaders[] = {"Distance", "Recency", "Confidence", "Neutral"};
                pane_selector("Colour", view.map_shader, map_shaders);
                if (view.map_shader == SpatialMapShader::recency)
                    pane_slider("Age span", &view.map_recency_seconds, 1.f, 600.f, "%.0f s");
                float depth_opacity = view.depth_opacity * 100.f;
                if (pane_slider("Opacity", &depth_opacity, 10.f, 100.f, "%.0f %%"))
                    view.depth_opacity = depth_opacity / 100.f;
                if (!view.environment_depth) {
                    pane_slider("Pair limit", &view.stereo_skew_ms, 1.f, 20.f, "%.0f ms");
                    ui::help("Maximum difference between camera media timestamps. The cameras "
                             "expose independently.");
                }
                if (ImGui::BeginTable("Depth range", 2, ImGuiTableFlags_SizingStretchSame)) {
                    ImGui::TableNextColumn();
                    ImGui::SetNextItemWidth(-1);
                    ImGui::SliderFloat("##Near", &view.depth_min, .1f, 2.f, "Near %.2f m");
                    ui::help("Near end of the distance gradient, measured from the headset.");
                    view.depth_max = std::max(view.depth_max, view.depth_min + .1f);
                    ImGui::TableNextColumn();
                    ImGui::SetNextItemWidth(-1);
                    ImGui::SliderFloat("##Far", &view.depth_max, view.depth_min + .1f, 10.f, "Far %.1f m");
                    ui::help("Far end of the distance gradient, measured from the headset.");
                    ImGui::EndTable();
                }
                if (view.map_shader != SpatialMapShader::neutral)
                    ui::gradient_picker("Map gradient", view.map_gradient);
                pane_slider("Point size", &view.point_size, 1.f, 5.f, "%.0f px");
                ui::help("Exact framebuffer pixels, independent of distance and map spacing.");
                ui::subsection("Storage");
                float map_limit_mib = float(preferences.map_max_bytes) / (1024.f * 1024.f);
                if (ui::begin_field("Max size")) {
                    const float limit_width = ImGui::CalcTextSize("999.9k pts").x;
                    ImGui::SetNextItemWidth(std::max(1.f, ImGui::GetContentRegionAvail().x -
                                                        limit_width - style.ItemSpacing.x));
                    if (ImGui::SliderFloat("##value", &map_limit_mib, 1.f, 256.f, "%.0f MiB")) {
                        preferences.map_max_bytes = uint64_t(std::round(map_limit_mib)) * 1024 * 1024;
                        for (auto& [path, store] : map_stores)
                            store->set_max_bytes(preferences.map_max_bytes);
                    }
                    ui::help("Maximum size of each saved map and its live point budget. "
                             "When the budget is full, uncertain regions merge before reliable detail.");
                    ImGui::SameLine();
                    ImGui::AlignTextToFramePadding();
                    const auto point_limit = map_point_budget();
                    if (point_limit >= 1000000)
                        ImGui::TextColored(ui::colour::muted, "%.2fM pts", double(point_limit) / 1000000.);
                    else
                        ImGui::TextColored(ui::colour::muted, "%.1fk pts", double(point_limit) / 1000.);
                    if (ImGui::IsItemHovered())
                        ImGui::SetTooltip("Live limit: %zu points", point_limit);
                    ui::end_field();
                }
                ui::field_label("Map folder");
                ImGui::SetNextItemWidth(-1);
                if (ImGui::InputTextWithHint("##MapDirectory", "Map folder", map_directory_text,
                                            sizeof(map_directory_text), ImGuiInputTextFlags_EnterReturnsTrue)) {
                    if (map_directory_text[0]) {
                        try {
                            preferences.map_directory = std::filesystem::absolute(map_directory_text);
                            requested_map_generation = {};
                            map_snapshot_due = 0;
                            map_error.clear();
                        } catch (const std::exception& error) {
                            map_error = error.what();
                        }
                    }
                }
                ui::help("The three most recent automatic maps are kept in this folder. Press Enter to change the folder.");
                const auto map_file = current_map_files[view.environment_depth ? 0 : 1];
                if (const auto store = map_stores.find(map_file); store != map_stores.end()) {
                    const auto status = store->second->status();
                    ImGui::PushStyleColor(ImGuiCol_Text, ui::colour::muted);
                    ImGui::TextWrapped("%s: %.2f MiB, %llu samples", status.busy ? "Saving" : "Saved",
                                double(status.file.bytes) / (1024. * 1024.),
                                static_cast<unsigned long long>(status.file.stored_points));
                    if (status.file.grid_size > 0)
                        ImGui::Text("Saved spacing: %.1f cm", status.file.grid_size * 100.f);
                    ImGui::PopStyleColor();
                }
                if (ImGui::Button("Save map now", {-1, 0})) {
                    requested_map_generation = {};
                    requested_saved_map_generation = 0;
                    map_snapshot_due = 0;
                    for (auto& [path, store] : map_stores)
                        store->retry_save();
                }
                if (!map_error.empty())
                    ImGui::TextWrapped("%s", map_error.c_str());
                ImGui::PopID();
                ImGui::PopID();
                end_body();
            }
            if (section("Scene", "04", PaneSection::scene)) {
                begin_body("Scene body");
                ImGui::PushID("Scene");
                ui::subsection("Geometry", true);
                ImGui::Checkbox("Grid", &view.grid);
                same_line_if_room("Frustum", true);
                ImGui::Checkbox("Frustum", &view.frusta);
                ui::subsection("Spatial map");
                ImGui::PushID("Spatial map");
                const auto spatial_control = [&](const char* name) {
                    if (!options.metrics.empty()) {
                        const auto minimum = ImGui::GetItemRectMin(), maximum = ImGui::GetItemRectMax();
                        scene_spatial_controls[name] = {{minimum.x, minimum.y}, {maximum.x, maximum.y}};
                    }
                };
                ui::field_label("Saved map");
                ImGui::SetNextItemWidth(-1);
                ImGui::InputTextWithHint("##OpenMapPath", "Saved .cmap file", map_open_path, sizeof(map_open_path));
                spatial_control("path");
                ImGui::BeginDisabled(!map_open_path[0] || map_loader != nullptr);
                if (ImGui::Button("Open saved map", {-1, 0})) {
                    try {
                        open_map(map_open_path);
                        ++scene_spatial_actions["open"];
                    } catch (const std::exception& error) {
                        map_error = error.what();
                    }
                }
                spatial_control("open");
                ImGui::EndDisabled();
                if (map_loader)
                    ui::muted("Loading spatial map");
                const auto placed_map = renderer->saved_map_state();
                const auto headset = renderer->headset_transform();
                if ((placed_map.loaded || map_loader) && ImGui::BeginTable("Map actions", 2,
                        ImGuiTableFlags_SizingStretchSame)) {
                    ImGui::TableNextColumn();
                    ImGui::BeginDisabled(!headset || source_job.valid() || map_loader != nullptr ||
                                         (!placed_map.placed && !placement_error.empty()));
                    if (ImGui::Button(placed_map.placed ? "Adjust" : "Place", {-1, 0})) {
                        try {
                            if (placed_map.placed) {
                                capture_final_maps();
                                if (renderer->begin_saved_map_placement()) {
                                    map_placement = {};
                                    map_placement.base = glm::inverse(*headset);
                                    saved_map_binding.reset();
                                    view.map_frozen = true;
                                    depth_capture_enabled.store(false);
                                    ++scene_spatial_actions["adjust"];
                                }
                            } else if (place_loaded_map()) {
                                ++scene_spatial_actions["place"];
                            }
                        } catch (const std::exception& error) {
                            map_error = error.what();
                        }
                    }
                    spatial_control(placed_map.placed ? "adjust" : "place");
                    ImGui::EndDisabled();
                    ImGui::TableNextColumn();
                    if (ImGui::Button("Unload", {-1, 0})) {
                        try {
                            unload_map();
                            ++scene_spatial_actions["unload"];
                        } catch (const std::exception& error) {
                            map_error = error.what();
                        }
                    }
                    spatial_control("unload");
                    ImGui::EndTable();
                }
                if (recorded_spatial_data || (!replay && renderer->map_point_count(view.environment_depth) > 0)) {
                    bool visible = view.depth && view.recorded_map_visible;
                    if (ImGui::Checkbox(recorded_spatial_data ? "Recording" : "Captured map", &visible)) {
                        view.recorded_map_visible = visible;
                        if (visible) view.depth = true;
                    }
                    spatial_control("recording_visibility");
                    ImGui::PushID("Recording layer");
                    float opacity = view.recorded_map_opacity * 100.f;
                    if (pane_slider("Opacity", &opacity, 0.f, 100.f, "%.0f %%"))
                        view.recorded_map_opacity = opacity / 100.f;
                    spatial_control("recording_opacity");
                    ImGui::PopID();
                }
                if (placed_map.loaded) {
                    ImGui::Checkbox("Saved map", &view.saved_map_visible);
                    spatial_control("saved_visibility");
                    ImGui::PushID("Saved layer");
                    float opacity = view.saved_map_opacity * 100.f;
                    if (pane_slider("Opacity", &opacity, 0.f, 100.f, "%.0f %%"))
                        view.saved_map_opacity = opacity / 100.f;
                    spatial_control("saved_opacity");
                    ImGui::PopID();
                    ImGui::TextWrapped("%s", loaded_map_file.filename().string().c_str());
                    if (!placed_map.placed) {
                        ui::muted("Place in the scene");
                        map_placement_adjuster(map_placement, options.metrics.empty() ? nullptr : &scene_spatial_controls);
                        ui::help("Position in metres and rotation in degrees, relative to the headset.");
                        if (!headset) ui::muted("Waiting for a headset pose");
                    } else {
                        const bool aligned = saved_map_binding && *saved_map_binding == current_map_binding;
                        ui::muted(placed_map.fusing ? "Fusing incoming depth" : aligned ? "Placed" : "Placement needed");
                    }
                }
                if (!map_error.empty()) ImGui::TextWrapped("%s", map_error.c_str());
                if (!placement_error.empty()) ImGui::TextWrapped("%s", placement_error.c_str());
                ImGui::PopID();
                ui::subsection("Image");
                ImGui::Checkbox("Preview", &preview);
                pane_slider("Distance", &view.plane_distance, .2f, 3.f, "%.2f m");
                float opacity = view.plane_opacity * 100.f;
                if (pane_slider("Opacity", &opacity, 10.f, 100.f, "%.0f %%"))
                    view.plane_opacity = opacity / 100.f;
                if (preview && view.projection) {
                    for (size_t camera_index = 0; camera_index < (dual_camera ? 2u : 1u);
                         ++camera_index) {
                        if (dual_camera)
                            ui::muted(snap.camera.cameras[camera_index].side == "left" ? "Left"
                                                                                       : "Right");
                        if (renderer->video_texture(camera_index)) {
                            const float width = ImGui::GetContentRegionAvail().x;
                            ImGui::Image(
                                static_cast<ImTextureID>(renderer->video_texture(camera_index)),
                                {width, width * renderer->video_height(camera_index) /
                                            std::max(1, renderer->video_width(camera_index))});
                            explicit_video_preview[camera_index] = ImGui::IsItemVisible();
                        } else
                            ImGui::TextWrapped("No image");
                    }
                }
                const float camera_button_width = ImGui::CalcTextSize("Headset").x +
                                                  style.FramePadding.x * 2.f +
                                                  style.CellPadding.x * 2.f;
                if (ImGui::BeginTable(
                        "Camera views",
                        ImGui::GetContentRegionAvail().x >= camera_button_width * 3.f ? 3 : 1,
                        ImGuiTableFlags_SizingStretchSame)) {
                    ImGui::TableNextColumn();
                    if (ImGui::Button("Reset", {-1, 0}))
                        renderer->reset_view();
                    ImGui::TableNextColumn();
                    ImGui::BeginDisabled(!renderer->scene_reference_available(SceneReference::hands));
                    if (ImGui::Button("Hands", {-1, 0}))
                        renderer->frame_hands(inspection);
                    ImGui::EndDisabled();
                    if (ImGui::IsItemHovered(ImGuiHoveredFlags_AllowWhenDisabled))
                        ImGui::SetTooltip("Centre the visible tracked hands");
                    ImGui::TableNextColumn();
                    ImGui::BeginDisabled(!renderer->scene_view_available(SceneView::hmd));
                    if (ImGui::Button("Headset", {-1, 0}))
                        renderer->headset_view(inspection);
                    ImGui::EndDisabled();
                    if (ImGui::IsItemHovered(ImGuiHoveredFlags_AllowWhenDisabled))
                        ImGui::SetTooltip("View from the last accepted headset pose");
                    ImGui::EndTable();
                }

                ImGui::PopID();
                end_body();
            }
            if (section("Task", "05", PaneSection::task)) {
                begin_body("Task body");
                ImGui::PushID("Task");
                if (replay) {
                    const auto position = replay->position_us();
                    const auto* current = replay_tasks.at(position);
                    const auto* setup = current ? current : replay_tasks.tasks().empty()
                        ? nullptr : &replay_tasks.tasks().front();
                    if (setup && !setup->run_title.empty()) {
                        ImGui::TextWrapped("%s", setup->run_title.c_str());
                        if (!setup->run_description.empty())
                            ImGui::TextWrapped("%s", setup->run_description.c_str());
                        ImGui::Separator();
                    }
                    replay_task_details(replay_tasks, position, episode_load.valid());
                    if (!replay_tasks.tasks().empty()) {
                        ui::subsection("Recorded task timeline");
                        for (const auto& interval : replay_tasks.tasks()) {
                            ImGui::PushStyleColor(ImGuiCol_Text, &interval == current
                                ? ui::colour::amber : ui::colour::text);
                            ImGui::TextWrapped("%s", interval.title.c_str());
                            ImGui::TextUnformatted(replay_task_counters(&interval).c_str());
                            ImGui::Text("%s to %s", replay_timestamp(interval.start_us).c_str(),
                                        replay_timestamp(interval.end_us).c_str());
                            ImGui::PopStyleColor();
                            ImGui::Spacing();
                        }
                    }
                } else {
                    ImGui::BeginDisabled(record_status.recording || pending_recording.has_value() ||
                                         task_load.valid());
                    pane_text_input("Specification", task_specification_path,
                                    sizeof(task_specification_path),
                                    "JSON file or https:// URL");
                    if (ImGui::Button("Load")) {
                        try {
                            load_task_source();
                        } catch (const std::exception& error) {
                            ui_error = error.what();
                        }
                    }
                    if (task_specification) {
                        same_line_if_room("Clear");
                        if (ImGui::Button("Clear")) {
                            task_specification.reset();
                            task_run = TaskRun{};
                            task_specification_path[0] = '\0';
                        }
                    }
                    if (!task_specification)
                        pane_text_input("Description", task, sizeof(task), "Describe the task");
                    ImGui::EndDisabled();
                    if (task_load.valid()) {
                        ui::muted("Loading...");
                        same_line_if_room("Cancel");
                        if (ImGui::Button("Cancel"))
                            task_load_cancel.request_stop();
                    }
                    if (task_specification) {
                        ImGui::Separator();
                        ImGui::TextWrapped("%s", task_specification->run_title.c_str());
                        if (!task_specification->run_description.empty())
                            ImGui::TextWrapped("%s", task_specification->run_description.c_str());
                        ImGui::Text("%zu tasks / %llu cycles", task_specification->tasks.size(),
                                    static_cast<unsigned long long>(task_specification->cycle_count));
                        for (size_t index = 0; index < task_specification->tasks.size(); ++index) {
                            const auto& step = task_specification->tasks[index];
                            ImGui::Separator();
                            ImGui::TextWrapped("%zu. %s", index + 1, step.label.c_str());
                            if (!step.instructions.empty())
                                ImGui::TextWrapped("%s", step.instructions.c_str());
                            if (step.type == TaskType::pause)
                                ImGui::Text("Pause / %.0f s", step.duration_s);
                            else if (step.type == TaskType::timed)
                                ImGui::Text("%llu reps / %.0f s",
                                            static_cast<unsigned long long>(step.repeat_count),
                                            step.duration_s);
                            else
                                ImGui::Text("%llu reps / open",
                                            static_cast<unsigned long long>(step.repeat_count));
                        }
                    }
                }
                ImGui::PopID();
                end_body();
            }
            if (section("Recording", "06", PaneSection::recording)) {
                begin_body("Recording body");
                ImGui::PushID("Recording");
                ImGui::BeginDisabled(record_status.recording || pending_recording.has_value());
                pane_text_input("Destination##Recording", recording_destination,
                                sizeof(recording_destination));
                ImGui::EndDisabled();
                if (!recording_start_notice.empty())
                    ImGui::TextWrapped("%s", recording_start_notice.c_str());
                if (record_status.failed)
                    ImGui::TextWrapped("%s", record_status.error.c_str());
                if (ui::disclosure("Episodes")) {
                    if (replay) {
                        ImGui::BeginDisabled(episode_load.valid());
                        if (ImGui::Button("Mark in")) {
                            episode_begin = replay->position_us();
                            episode_open = true;
                            episode_task = task;
                        }
                        same_line_if_room("Mark out");
                        if (ImGui::Button("Mark out") && episode_open) {
                            auto end = replay->position_us();
                            if (end > episode_begin) {
                                episodes.push_back({episode_begin, end, episode_task});
                                episode_open = false;
                                episodes_dirty = true;
                            } else
                                ui_error = "The episode must end after its start";
                        }
                        ImGui::EndDisabled();
                    }
                    if (episode_load.valid())
                        ui::muted("Loading");
                    else if (episodes.empty())
                        ui::muted("No ranges. Mark in replay.");
                    ImGui::BeginDisabled(episode_load.valid());
                    for (size_t i = 0; i < episodes.size(); ++i) {
                        ImGui::PushID(int(i));
                        auto& e = episodes[i];
                        const auto outcome = e.attributes.value("outcome", std::string{});
                        if (outcome == "pass" || outcome == "fail" || outcome == "restarted")
                            ImGui::TextColored(outcome == "pass" ? ui::colour::green :
                                               outcome == "fail" ? ui::colour::red : ui::colour::muted,
                                               "%s", outcome == "pass" ? "Pass" :
                                               outcome == "fail" ? "Fail" : "Restarted");
                        char label[512]{};
                        text_buffer(label, e.task);
                        if (pane_text_input("Task", label, sizeof(label))) {
                            e.task = label;
                            episodes_dirty = true;
                        }
                        double start = e.start_us / 1e6, end = e.end_us / 1e6;
                        ui::field_label("Start (s)");
                        ImGui::SetNextItemWidth(-1);
                        if (ImGui::InputDouble("##Start (s)", &start) && std::isfinite(start)) {
                            e.start_us = int64_t(std::clamp(start, 0., 9e9) * 1e6);
                            episodes_dirty = true;
                        }
                        ui::field_label("End (s)");
                        ImGui::SetNextItemWidth(-1);
                        if (ImGui::InputDouble("##End (s)", &end) && std::isfinite(end)) {
                            e.end_us = int64_t(std::clamp(end, 0., 9e9) * 1e6);
                            episodes_dirty = true;
                        }
                        const bool remove = ImGui::Button("Remove");
                        ImGui::Separator();
                        ImGui::PopID();
                        if (remove) {
                            episodes.erase(episodes.begin() + static_cast<ptrdiff_t>(i));
                            episodes_dirty = true;
                            break;
                        }
                    }
                    ImGui::EndDisabled();
                }
                const bool export_open = ui::disclosure("Export");
                if (!options.metrics.empty()) {
                    const auto first = ImGui::GetItemRectMin(), last = ImGui::GetItemRectMax();
                    export_ui_metrics["disclosure"] = {{"open", export_open},
                        {"bounds", {{first.x, first.y}, {last.x, last.y}}}};
                }
                if (export_open) {
                    pane_text_input("Destination##LeRobot", export_path, sizeof(export_path));
                    if (episodes.empty()) {
                        ImGui::BeginDisabled(record_status.recording || episode_load.valid());
                        if (ImGui::Button("Use whole session")) {
                            auto input = replay ? replay->path() : closed_recording;
                            auto duration = replay ? replay->duration_us() : closed_duration;
                            if (input.empty() || duration <= 0)
                                ui_error = "Open a completed recording before selecting an episode";
                            else if (!task[0])
                                ui_error = "Enter a task description before selecting an episode";
                            else {
                                episodes.push_back({0, duration, task});
                                episode_session = input;
                                episodes_dirty = true;
                            }
                        }
                        ImGui::EndDisabled();
                    }
                    if (!export_status.running) {
                        const bool export_unavailable = !exporter_present || episodes.empty() ||
                            record_status.recording || episode_load.valid();
                        ImGui::BeginDisabled(export_unavailable);
                        const bool request_export = ui::primary_button(exporter_present ? "Export###RunExport" :
                                                                                       "Exporter not present###RunExport");
                        if (!options.metrics.empty()) {
                            const auto first = ImGui::GetItemRectMin(), last = ImGui::GetItemRectMax();
                            export_ui_metrics["action"] = {
                                {"label", exporter_present ? "Export" : "Exporter not present"},
                                {"enabled", !export_unavailable && !accordion.moving() &&
                                            visible_section == preferences.section},
                                {"visible", ImGui::IsItemVisible()},
                                {"reason", !exporter_present ? "Exporter not present" :
                                    episodes.empty() ? "No episodes selected" :
                                    record_status.recording ? "Recording is active" :
                                    episode_load.valid() ? "Episodes are loading" : ""},
                                {"bounds", {{first.x, first.y}, {last.x, last.y}}}};
                        }
                        if (request_export) {
                            try {
                                std::filesystem::path input =
                                    replay ? replay->path() : closed_recording;
                                int64_t duration = replay ? replay->duration_us() : closed_duration;
                                if (input.empty())
                                    throw std::runtime_error(
                                        "Open a completed recording before export");
                                Json ranges = Json::array();
                                for (auto& e : episodes) {
                                    if (e.task.empty() || e.start_us < 0 ||
                                        e.end_us <= e.start_us || e.end_us > duration)
                                        throw std::runtime_error("Each episode needs a task and a "
                                                                 "range within this recording");
                                    ranges.push_back({{"start_us", e.start_us},
                                                      {"end_us", e.end_us},
                                                      {"task", e.task}});
                                }
                                persist_episodes();
                                const auto& export_camera = replay ? snap.camera : closed_camera;
                                const bool has_video_dimensions =
                                    export_camera.width > 0 && export_camera.height > 0;
                                Json job = {
                                    {"schema", "ceres-native-export"},
                                    {"version", 1},
                                    {"profile", "ceres-bridge-lerobot3-v1"},
                                    {"session", std::filesystem::absolute(input).string()},
                                    {"output",
                                     std::filesystem::absolute(std::filesystem::path(export_path))
                                         .string()},
                                    {"fps", 30},
                                    {"episodes", ranges},
                                    {"video",
                                     {{"key", "observation.images.passthrough"},
                                      {"stream", "passthrough"},
                                      {"source_dimensions", true},
                                      {"width", has_video_dimensions ? export_camera.width : 640},
                                      {"height",
                                       has_video_dimensions ? export_camera.height : 480}}}};
                                auto jobfile = std::filesystem::path(data_path) / "jobs" /
                                               (time_name() + ".json");
                                exporter.start(job, jobfile);
                            } catch (const std::exception& e) {
                                ui_error = e.what();
                            }
                        }
                        ImGui::EndDisabled();
                        if (!exporter_present)
                            ImGui::TextWrapped("Install the native exporter to create a LeRobot dataset "
                                               "from this recording.");
                    } else {
                        ImGui::ProgressBar(export_status.progress);
                        if (ImGui::Button("Cancel export"))
                            exporter.cancel();
                    }
                    if (!export_status.message.empty())
                        ImGui::TextWrapped("%s", export_status.message.c_str());
                    if (!export_status.error.empty())
                        ImGui::TextWrapped("%s", export_status.error.c_str());
                }
                if (ui::disclosure("Hugging Face export")) {
                    ImGui::PushID("HuggingFaceExport");
                    hf_account_controls();
                    ImGui::BeginDisabled(hf_status.running);
                    pane_text_input("Organisation or username##Upload", hf_organisation, sizeof(hf_organisation));
                    pane_text_input("Repository##Upload", hf_repository, sizeof(hf_repository));
                    pane_text_input("Folder##Upload", hf_folder, sizeof(hf_folder), "Optional folder in the repository");
                    ImGui::Checkbox("Create a private repository if missing", &hf_private);
                    ImGui::Checkbox("Include LeRobot export", &hf_include_export);
                    const auto upload_recording = replay ? replay->path() : closed_recording;
                    if (!upload_recording.empty())
                        ImGui::TextWrapped("Recording: %s", upload_recording.filename().string().c_str());
                    if (hf_include_export)
                        ImGui::TextWrapped("Export: %s", export_path);
                    const bool unavailable = hf_status.username.empty() || upload_recording.empty() ||
                        record_status.recording || pending_recording.has_value() || export_status.running ||
                        episode_load.valid();
                    ImGui::BeginDisabled(unavailable);
                    if (ui::primary_button("Upload recording")) {
                        try {
                            persist_episodes();
                            hugging_face.upload(hf::repository_id(hf_organisation, hf_repository), upload_recording,
                                hf_include_export ? std::filesystem::path(export_path) : std::filesystem::path{},
                                hf_folder, hf_private);
                        } catch (const std::exception& error) { ui_error = error.what(); }
                    }
                    ImGui::EndDisabled();
                    ImGui::EndDisabled();
                    if (!hf_status.commit_url.empty() && ImGui::Button("View uploaded recording"))
                        hf::open_browser(hf_status.commit_url);
                    ImGui::PopID();
                }
                if (ui::disclosure("Recovery")) {
                    ImGui::BeginDisabled(record_status.recording || pending_recording.has_value() ||
                                         recovery_job.valid());
                    if (ImGui::Button("Recover")) {
                        try {
                            auto in = std::filesystem::path(session_path);
                            auto out = in;
                            out.replace_extension("recovered.mcap");
                            recovery_message = "Recovering recording...";
                            recovery_job = std::async(std::launch::async, [&, in, out] {
                                recorder.stop();
                                return recover_session(in, out);
                            });
                        } catch (const std::exception& e) {
                            ui_error = e.what();
                        }
                    }
                    ImGui::EndDisabled();
                    if (!recovery_message.empty())
                        ImGui::TextWrapped("%s", recovery_message.c_str());
                }
                ImGui::PopID();
                end_body();
            }
            if (section("Replay", "07", PaneSection::replay)) {
                begin_body("Replay body");
                ImGui::PushID("Replay");
                const std::array<const char*, 2> source_labels{"Hugging Face", "Local file"};
                const float segment_space = ImGui::GetContentRegionAvail().x;
                const float first_label_width = ImGui::CalcTextSize(source_labels[0]).x + 8.f * dpi;
                const float second_label_width = ImGui::CalcTextSize(source_labels[1]).x + 8.f * dpi;
                const float first_segment_width = segment_space * first_label_width /
                                                  (first_label_width + second_label_width);
                ImGui::PushStyleVar(ImGuiStyleVar_ItemSpacing, {0, ImGui::GetStyle().ItemSpacing.y});
                ImGui::PushStyleVar(ImGuiStyleVar_FramePadding, {4.f * dpi, ImGui::GetStyle().FramePadding.y});
                for (int index = 0; index < 2; ++index) {
                    if (index) ImGui::SameLine();
                    const auto location = static_cast<ReplayLocation>(index);
                    const bool selected = preferences.replay_location == location;
                    ImGui::PushStyleColor(ImGuiCol_Button, selected ? ui::colour::overlay : ui::colour::surface);
                    ImGui::PushStyleColor(ImGuiCol_Text, selected ? ui::colour::amber : ui::colour::text);
                    const float width = index == 0 ? first_segment_width : segment_space - first_segment_width;
                    if (ImGui::Button(source_labels[index], {width, 0}))
                        preferences.replay_location = location;
                    ImGui::PopStyleColor(2);
                }
                ImGui::PopStyleVar(2);
                ImGui::Spacing();
                if (preferences.replay_location == ReplayLocation::local_file) {
                    ImGui::PushID("File");
                    pane_text_input("Recording", session_path, sizeof(session_path), ".mcap");
                    ImGui::BeginDisabled(!session_path[0] || record_status.recording ||
                                         pending_recording.has_value() || source_job.valid() || hf_status.running);
                    if (ui::primary_button("Open recording")) change_source(session_path, false);
                    ImGui::EndDisabled();
                    if (hf_status.running)
                        hf_account_controls(false);
                    ImGui::PopID();
                } else {
                    ImGui::PushID("HuggingFaceReplay");
                    ImGui::BeginDisabled(hf_status.running);
                    pane_text_input("Repository", replay_repository, sizeof(replay_repository), "hf:username/dataset");
                    ImGui::BeginDisabled(!replay_repository[0]);
                    if (ui::primary_button("Browse recordings")) {
                        try {
                            hf_selected.clear();
                            hugging_face.browse(replay_repository);
                        } catch (const std::exception& error) { ui_error = error.what(); }
                    }
                    ImGui::EndDisabled();
                    ImGui::EndDisabled();
                    if (!hf_status.repository.empty()) {
                        ImGui::TextWrapped("%s", hf_status.repository.c_str());
                        pane_text_input("Filter", hf_filter, sizeof(hf_filter), "Recording name");
                        std::vector<size_t> visible;
                        for (size_t index = 0; index < hf_status.recordings->size(); ++index)
                            if (!hf_filter[0] || (*hf_status.recordings)[index].path.find(hf_filter) != std::string::npos)
                                visible.push_back(index);
                        ImGui::BeginDisabled(hf_status.running);
                        if (ImGui::BeginListBox("##Recordings", {-1, 160.f * dpi})) {
                            ImGuiListClipper clipper;
                            clipper.Begin(static_cast<int>(visible.size()));
                            while (clipper.Step())
                                for (int row = clipper.DisplayStart; row < clipper.DisplayEnd; ++row) {
                                    const auto& entry = (*hf_status.recordings)[visible[static_cast<size_t>(row)]];
                                    ImGui::PushID(entry.path.c_str());
                                    const auto label = entry.is_dataset()
                                        ? (entry.dataset_root.empty() ? std::string("Dataset")
                                           : std::filesystem::path(entry.dataset_root).filename().string())
                                        : entry.path;
                                    if (ImGui::Selectable(label.c_str(), hf_selected == entry.path))
                                        hf_selected = entry.path;
                                    ui::help((entry.path + "\n" + std::to_string(entry.bytes / 1048576) + " MiB").c_str());
                                    ImGui::PopID();
                                }
                            ImGui::EndListBox();
                        }
                        if (visible.empty()) ui::muted("No matching recordings");
                        ImGui::BeginDisabled(hf_selected.empty() || record_status.recording ||
                                             pending_recording.has_value() || source_job.valid());
                        if (ui::primary_button("Load into player")) {
                            for (const auto& entry : *hf_status.recordings)
                                if (entry.path == hf_selected) {
                                    hugging_face.download(entry, std::filesystem::path(data_path) / "downloads" / "hugging-face");
                                    break;
                                }
                        }
                        ImGui::EndDisabled();
                        ImGui::EndDisabled();
                    }
                    hf_account_controls();
                    ImGui::PopID();
                }
                ImGui::PopID();
                end_body();
            }
            if (section("Publish", "08", PaneSection::publish)) {
                begin_body("Publish body");
                end_body();
            }
            if (section("Telemetry", "09", PaneSection::telemetry)) {
                begin_body("Telemetry body");
                ImGui::PushID("Telemetry");
                ImFont* cadence_font =
                    ImGui::GetContentRegionAvail().x / 3.f < readout_font->FontSize * 3.5f
                        ? mono_font
                        : readout_font;
                if (ImGui::BeginTable("Cadence", 3, ImGuiTableFlags_SizingStretchSame)) {
                    const std::array<const char*, 3> labels{"Render", "Video", "Track"};
                    const std::array<double, 3> rates{render_hz, video_fps, pose_hz};
                    for (size_t i = 0; i < rates.size(); ++i) {
                        ImGui::TableNextColumn();
                        ui::field_label(labels[i]);
                        ImGui::PushFont(cadence_font);
                        if (rates[i] > 0)
                            ImGui::Text("%03.0f", rates[i]);
                        else
                            ImGui::TextUnformatted("---");
                        ImGui::PopFont();
                        ImGui::SameLine(0, 3.f * dpi);
                        ImGui::TextDisabled("%s", i == 1 ? "fps" : "Hz");
                    }
                    ImGui::EndTable();
                }
                ImGui::Separator();
                metric_value("GPU", renderer->gpu_ms(), "ms", 2);
                metric_value("Decode", decoder_status.decode_ms, "ms", 2);
                if (dual_camera) {
                    metric_value("Decode 2", secondary_status.decode_ms, "ms", 2);
                    metric_value("Primary", video_fps, "Hz", 1);
                    metric_value("Second", secondary_fps, "Hz", 1);
                    if (!secondary_status.error.empty())
                        ImGui::TextWrapped("%s", secondary_status.error.c_str());
                }
                if (view.depth) {
                    metric_value("Map memory", renderer->depth_map_bytes(view.environment_depth) / 1048576., "MiB", 1);
                    if (view.environment_depth) {
                        metric_value("Depth GPU", renderer->environment_depth_ms(), "ms", 2);
                        metric_value("Updates", environment_hz, "Hz", 1);
                        metric_value("Rejected", double(snap.depth_rejected), "", 0);
                        const auto& timing = renderer->environment_depth_timing();
                        if (timing.valid) {
                            if (timing.readback_ms)
                                metric_value("Readback", *timing.readback_ms, "ms", 2);
                            if (timing.callback_to_arrival_ms) {
                                metric_value("Arrival age", *timing.callback_to_arrival_ms, "ms", 2);
                                ui::help(timing.replay
                                             ? "Recorded XR callback to complete depth arrival, including readback and transport."
                                             : "XR callback to complete depth arrival, including readback and transport.");
                            }
                            metric_value("Depth queue", timing.arrival_to_submit_ms, "ms", 2);
                            metric_value("Depth ready", timing.submit_to_ready_ms, "ms", 2);
                            ui::help("Submission to observed CUDA completion, including the wait for the next viewer frame.");
                            if (timing.target_lead_ms) {
                                metric_value("Pose lead", *timing.target_lead_ms, "ms", 2);
                                ui::help("XR target time minus the capture callback time. The browser does not expose the sensor's exposure timestamp.");
                            }
                        }
                    } else {
                        metric_value("Stereo", renderer->stereo_ms(), "ms", 2);
                        metric_value("Updates", stereo_hz, "Hz", 1);
                        metric_value("Pair skew", stereo_pair_skew_ms, "ms", 2);
                    }
                }
                metric_value("Latency", renderer->video_latency_ms(), "ms");
                ui::help("Complete camera frame arrival to presentation");
                metric_value("Clock", snap.clock.uncertainty_us / 1000, "ms", 2);
                ui::help("Clock uncertainty");
                for (size_t i = 0; i < snap.poses.size(); ++i)
                    if (snap.poses[i])
                        metric_value(i == 0   ? "Head age"
                                     : i == 1 ? "Left age"
                                              : "Right age",
                                     (snap.now_us - (snap.poses[i]->observed_us * snap.clock.rate +
                                                     snap.clock.offset_us)) /
                                         1000,
                                     "ms");
                metric_value("Write", record_mib_s, "MiB/s", 2);
                metric_value("Queue", record_status.queued_bytes / 1048576.0, "MiB", 2);
                ui::muted(decoder_status.gpu.c_str());
                ui::muted(decoder_status.backend.c_str());
                if (!decoder_status.error.empty())
                    ImGui::TextWrapped("%s", decoder_status.error.c_str());
                ImGui::PopID();
                end_body();
            }
            if (section("Calibration", "10", PaneSection::calibration)) {
                begin_body("Calibration body");
                ImGui::PushID("Calibration");
                ui::subsection("Camera", true);
                ImGui::TextWrapped("%s", calibration.name.c_str());
                pane_text_input("Profile", profile_path, sizeof(profile_path),
                                "Calibration JSON path");
                if (ImGui::Button("Load")) {
                    try {
                        calibration = Calibration::load(profile_path);
                        custom_calibration = true;
                        preferences.profile_path = profile_path;
                        calibration_changed();
                    } catch (const std::exception& e) {
                        ui_error = e.what();
                    }
                }
                same_line_if_room("Quest preset");
                if (ImGui::Button("Quest preset")) {
                    custom_calibration = false;
                    calibration = Calibration::quest(
                        snap.camera.width > 0 ? snap.camera.width : calibration.width,
                        snap.camera.height > 0 ? snap.camera.height : calibration.height,
                        snap.camera.side == "left" ? "left" : "right");
                    preferences.profile_path.clear();
                    profile_path[0] = '\0';
                    calibration_changed();
                }
                ImGui::Checkbox("Undistort image", &view.undistort);
                bool flipped = ImGui::Checkbox("Flip horizontal", &calibration.flip_x);
                flipped |= ImGui::Checkbox("Flip vertical", &calibration.flip_y);
                if (flipped)
                    calibration_changed();
                ui::subsection("Stereo");
                if (stereo_profile) {
                    ImGui::TextWrapped("%s", stereo_profile->name.c_str());
                    if (!stereo_profile->measured)
                        ui::help("Nominal Quest 3 camera geometry. Load a measured profile for "
                                 "calibrated depth.");
                } else
                    ui::muted("No stereo profile");
                pane_text_input("Profile##Stereo", stereo_path, sizeof(stereo_path),
                                "Stereo calibration JSON");
                if (ImGui::Button("Load##Stereo")) {
                    try {
                        auto loaded = StereoCalibration::load(stereo_path);
                        stereo_profile = std::move(loaded);
                        if (!replay) {
                            preferences.stereo = stereo_profile;
                            preferences.stereo_path = stereo_path;
                        }
                        reset_stereo_acquisition();
                        recorder.push(calibration_event(snap.epoch, snap.space_epoch));
                    } catch (const std::exception& error) {
                        ui_error = error.what();
                    }
                }
                same_line_if_room("Quest preset");
                if (ImGui::Button("Quest preset##Stereo")) {
                    stereo_profile = quest_stereo();
                    stereo_path[0] = '\0';
                    reset_stereo_acquisition();
                    if (!replay) {
                        preferences.stereo = stereo_profile;
                        preferences.stereo_path.clear();
                    }
                    recorder.push(calibration_event(snap.epoch, snap.space_epoch));
                }
                ImGui::PopID();
                end_body();
            }
            previous_section = accordion.displayed();
            ImGui::PopItemWidth();
            ImGui::EndChild();
            ImGui::SetCursorPos({0, io.DisplaySize.y - footer_height});
            ImGui::PushStyleVar(ImGuiStyleVar_ItemSpacing, ImVec2(0, 0));
            ImGui::BeginChild("Visibility", {0, footer_height}, 0,
                              ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoScrollWithMouse);
            if (focus_visibility) {
                ImGui::SetWindowFocus();
                ImGui::SetKeyboardFocusHere();
                ImGui::SetNavCursorVisible(true);
            }
            const auto footer_map = renderer->saved_map_state();
            bool fuse = footer_map.fusing;
            const std::array<const char*, 5> labels{"HAND", "HMD", "TRL", "RGB", footer_map.loaded ? "FUSE" : "DEPTH"};
            const std::array<const char*, 5> help{
                "Show hands", "Show headset", "Show hand trails", "Show camera image and frustum",
                footer_map.loaded ? "Fuse incoming depth into the placed map" : "Show spatial map"};
            const std::array<bool*, 5> values{&view.hands, &view.headset, &view.trails,
                                              &view.projection, footer_map.loaded ? &fuse : &view.depth};
            const float width = ImGui::GetContentRegionAvail().x;
            const auto origin = ImGui::GetCursorScreenPos();
            Json cells;
            if (!options.metrics.empty())
                cells = Json::array();
            for (size_t i = 0; i < labels.size(); ++i) {
                if (i)
                    ImGui::SameLine(0, 0);
                const float left = std::floor(width * float(i) / float(labels.size()));
                const float right = std::floor(width * float(i + 1) / float(labels.size()));
                const bool fuse_unavailable = i == 4 && footer_map.loaded &&
                    (source_job.valid() || !footer_map.placed || map_loader || !saved_map_binding ||
                     *saved_map_binding != current_map_binding || (replay && !recorded_spatial_data));
                ImGui::BeginDisabled(fuse_unavailable);
                const auto toggle = ui::visibility_toggle(labels[i], *values[i],
                                                           {right - left, footer_height});
                ImGui::EndDisabled();
                ui::help(help[i]);
                if (fuse_unavailable && ImGui::IsItemHovered(ImGuiHoveredFlags_AllowWhenDisabled))
                    ImGui::SetTooltip("%s", replay && !recorded_spatial_data ? "The recording contains no depth frames"
                                                                         : "Place the map before enabling fusion");
                if (toggle.pressed) {
                    if (i == 4 && footer_map.loaded) {
                        if (set_map_fusion(fuse)) ++scene_spatial_actions["fuse"];
                    }
                    ++visibility_actions[labels[i]];
                }
                if (!options.metrics.empty())
                    cells.push_back({{"label", labels[i]}, {"visible", *values[i]},
                                     {"bounds", {{toggle.first.x, toggle.first.y},
                                                  {toggle.last.x, toggle.last.y}}}});
            }
            if (!options.metrics.empty()) {
                sidebar_metrics = {
                    {"position", {scene_width, 0}}, {"size", {io.DisplaySize.x - scene_width, io.DisplaySize.y}},
                    {"heading_bounds", {{sidebar_heading_first.x, sidebar_heading_first.y},
                                         {sidebar_heading_last.x, sidebar_heading_last.y}}},
                    {"section", static_cast<int>(preferences.section)},
                    {"headers", section_metrics}};
                visibility_metrics = {
                    {"position", {origin.x, origin.y}}, {"size", {width, footer_height}},
                    {"cells", cells}, {"actions", visibility_actions}};
            }
            ImGui::EndChild();
            ImGui::PopStyleVar();
            ImGui::End();
            ImGui::PopStyleVar(2);
        }
        {
            const auto widths = detail::recording_bar_widths(scene_width, dpi);
            ImGui::SetNextWindowPos({0, 0}, ImGuiCond_Always);
            ImGui::SetNextWindowSize({scene_width, instrument_height}, ImGuiCond_Always);
            ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0, 0));
            ImGui::PushStyleVar(ImGuiStyleVar_ItemSpacing, ImVec2(0, 0));
            ImGui::PushStyleVar(ImGuiStyleVar_WindowRounding, 0);
            ImGui::PushStyleVar(ImGuiStyleVar_WindowBorderSize, 0);
            ImGui::PushStyleVar(ImGuiStyleVar_FrameRounding, 0);
            ImGui::PushStyleVar(ImGuiStyleVar_FrameBorderSize, 0);
            ImGui::PushStyleColor(ImGuiCol_Button, ui::colour::surface);
            ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ui::colour::overlay);
            ImGui::PushStyleColor(ImGuiCol_ButtonActive, ui::colour::raised);
            ImGui::Begin("Recording toolbar", nullptr,
                         ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize |
                             ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoSavedSettings |
                             ImGuiWindowFlags_NoDocking | ImGuiWindowFlags_NoFocusOnAppearing |
                             ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoScrollWithMouse);
            float cell_x = 0;
            size_t cell_index = 0;
            const auto cell = [&](const char* id, bool interactive = false, bool recording = false) {
                ImGui::SetCursorPos({cell_x, 0});
                const auto result = ui::instrument_cell(
                    id, {widths[cell_index], instrument_height}, interactive, recording);
                cell_x += widths[cell_index++];
                return result;
            };
            const auto clocks = clock_labels();
            const auto clock_cell = cell("##Clocks");
            ui::instrument_text(clock_cell, clocks[0].c_str(), mono_font, mono_font->FontSize,
                                .33f, ui::colour::text, false);
            ui::instrument_text(clock_cell, clocks[1].c_str(), mono_font, mono_font->FontSize,
                                .69f, ui::colour::muted, false);
            ui::help("Local time and universal time");

            const bool can_record =
                !recovery_job.valid() && !source_job.valid() && !task_load.valid() && !replay &&
                (options.fixture || (snap.connected && snap.connection == "Streaming"));
            const bool record_enabled = pending_recording || record_status.recording || can_record;
            if (focus_record) {
                ImGui::SetWindowFocus();
                ImGui::SetKeyboardFocusHere();
                ImGui::SetNavCursorVisible(true);
            }
            ImGui::BeginDisabled(!record_enabled);
            const bool capturing = record_status.recording && !record_status.paused;
            const auto record_cell = cell("##Record", true, capturing);
            if (ImGui::IsItemActivated())
                record_keyboard_gesture = record_cell.pressed;
            const auto action = record_press.update(
                {ImGui::GetTime(), record_cell.pressed, ImGui::IsItemActive(),
                 record_keyboard_gesture ? ImGui::IsItemFocused()
                                         : ImGui::IsItemHovered(ImGuiHoveredFlags_NoNavOverride),
                 record_enabled,
                 record_status.recording,
                 ImGui::IsKeyPressed(ImGuiKey_Escape, false) || io.AppFocusLost ||
                     !ImGui::IsWindowFocused(ImGuiFocusedFlags_RootAndChildWindows)});
            const char* record_label = pending_recording ? "CANCEL"
                                       : record_status.recording && !manual_recording_pause
                                           ? "PAUSE"
                                           : "REC";
            const bool stopping = record_status.recording && record_press.progress() > 0;
            const auto symbol = pending_recording ? ui::RecordSymbol::Cancel
                                : stopping ? ui::RecordSymbol::Stop
                                : record_status.recording && !manual_recording_pause
                                    ? ui::RecordSymbol::Pause
                                : record_status.recording ? ui::RecordSymbol::Resume
                                                          : ui::RecordSymbol::Record;
            const auto record_colour = capturing || stopping ? ui::colour::red
                                       : manual_recording_pause || pending_recording
                                           ? ui::colour::amber
                                       : record_enabled ? ui::colour::text : ui::colour::muted;
            ui::instrument_symbol(record_cell, symbol, record_colour);
            ui::instrument_hold(record_cell, record_press.progress());
            ui::help(pending_recording ? "Cancel the count-in"
                     : record_status.recording
                         ? "Click to pause or resume. Hold for 0.8 seconds to stop. F7 focuses this control."
                     : can_record ? "Start recording after the count-in. F7 focuses this control."
                                  : "Connect a live source to record");
            ImGui::EndDisabled();
            if (action != detail::HoldPress::Action::None) {
                try {
                    if (pending_recording) {
                        cancel_count_in();
                        ++recording_actions["cancel"];
                    } else {
                        std::lock_guard lock(recording_mutex);
                        const auto at = monotonic_us();
                        if (action == detail::HoldPress::Action::Stop && record_status.recording) {
                            if (task_specification)
                                apply_task_transitions(task_run.stop(at));
                            finish_recording();
                            ++recording_actions["stop"];
                        } else if (record_status.recording && !manual_recording_pause) {
                            if (task_specification)
                                apply_task_transitions(task_run.pause(at));
                            else {
                                end_episode(at - record_origin);
                                recorder.set_paused(true);
                            }
                            manual_recording_pause = true;
                            ++recording_actions["pause"];
                        } else if (record_status.recording) {
                            if (task_specification)
                                apply_task_transitions(task_run.resume(at));
                            else {
                                recorder.set_paused(false);
                                if (!recorder.status().failed) {
                                    if (auto live_bridge =
                                            std::dynamic_pointer_cast<BridgeClient>(source))
                                        live_bridge->request_keyframe();
                                    start_episode(at, task[0] ? task : "Capture", Json::object());
                                }
                            }
                            manual_recording_pause = false;
                            ++recording_actions["resume"];
                        } else {
                            if (!recording_destination[0])
                                throw std::runtime_error("Choose a recording destination");
                            queue_recording(std::filesystem::path(recording_destination) /
                                                (time_name() + ".mcap"), snap);
                            ++recording_actions["start"];
                        }
                    }
                    record_status = recorder.status();
                } catch (const std::exception& error) {
                    ui_error = error.what();
                }
            }

            const auto replay_position = replay ? replay->position_us() : 0;
            const auto* replay_task = replay ? replay_tasks.at(replay_position) : nullptr;
            const auto elapsed = elapsed_label(replay ? replay_position : record_status.active_duration_us);
            const auto time_cell = cell("##Recorded");
            ui::instrument_text(time_cell, replay ? "REPLAY" : manual_recording_pause ? "PAUSED" : "RECORDED",
                                instrument_label_font,
                                instrument_label_font->FontSize, .23f, ui::colour::muted);
            ui::instrument_text(time_cell, elapsed.c_str(), timer_font, timer_font->FontSize,
                                .64f, manual_recording_pause ? ui::colour::amber : ui::colour::text);
            ui::help(replay ? "Position in the recording" : record_status.failed
                ? record_status.error.c_str() : "Recorded time, excluding pauses");

            const auto progress = task_run.progress(monotonic_us());
            const auto* step = task_run.current_task();
            const bool ready = progress.phase == TaskRunPhase::stopped;
            const bool have_spec = task_specification && !task_specification->tasks.empty();
            if (have_spec && ready)
                step = &task_specification->tasks.front();
            std::string counters = "--";
            if (replay) {
                counters = replay_task_counters(replay_task);
            } else if (have_spec) {
                std::ostringstream text;
                text << 'C' << (ready ? 1 : progress.cycle) << '/' << task_specification->cycle_count;
                if (step)
                    text << " T" << (ready ? 1 : progress.task_index + 1) << '/'
                         << task_specification->tasks.size() << " R" << (ready ? 1 : progress.repetition)
                         << '/' << std::max<uint64_t>(1, step->repeat_count);
                else
                    text << " T-- R--";
                counters = text.str();
            }
            const bool task_running = !replay && record_status.recording && have_spec &&
                                      progress.phase != TaskRunPhase::stopped &&
                                      progress.phase != TaskRunPhase::complete;
            const bool repeat_enabled = task_running && task_run.can_restart();
            ImGui::BeginDisabled(!repeat_enabled);
            const auto repeat_cell = cell("##Repeat", true);
            if (ImGui::IsItemActivated())
                repeat_keyboard_gesture = repeat_cell.pressed;
            const auto repeat_action = repeat_press.update(
                {ImGui::GetTime(), repeat_cell.pressed, ImGui::IsItemActive(),
                 repeat_keyboard_gesture ? ImGui::IsItemFocused()
                                         : ImGui::IsItemHovered(ImGuiHoveredFlags_NoNavOverride),
                 repeat_enabled, true,
                 ImGui::IsKeyPressed(ImGuiKey_Escape, false) || io.AppFocusLost ||
                     !ImGui::IsWindowFocused(ImGuiFocusedFlags_RootAndChildWindows)});
            ui::instrument_text(repeat_cell, "REPLAY", instrument_label_font,
                                instrument_label_font->FontSize, .5f,
                                repeat_enabled ? ui::colour::text : ui::colour::muted);
            ui::instrument_hold(repeat_cell, repeat_press.progress());
            ui::help("Restart the current repetition. Hold for 0.8 seconds to restart the task. "
                     "During a pause, return to the preceding repetition or task.");
            ImGui::EndDisabled();
            if (repeat_action != detail::HoldPress::Action::None) {
                try {
                    std::lock_guard lock(recording_mutex);
                    const auto at = monotonic_us();
                    const bool whole_task = repeat_action == detail::HoldPress::Action::Stop;
                    apply_task_transitions(whole_task ? task_run.restart_task(at)
                                                      : task_run.restart_repetition(at));
                    manual_recording_pause = false;
                    ++recording_actions[whole_task ? "restart_task" : "restart_repetition"];
                } catch (const std::exception& error) {
                    ui_error = error.what();
                }
            }
            const auto progress_cell = cell("##Progress");
            ui::instrument_text(progress_cell, "CYCLE / TASK / REP", instrument_label_font,
                                instrument_label_font->FontSize,
                                .23f, ui::colour::muted);
            ui::instrument_text(progress_cell, counters.c_str(), compact_readout_font,
                                compact_readout_font->FontSize, .64f);
            ui::help(replay ? (replay_task ? replay_task->description.c_str() : "No current recorded task")
                     : step && !step->instructions.empty() ? step->instructions.c_str()
                     : step ? step->label.c_str() : "No task specification");

            const auto advance_task = [&](std::optional<bool> success) {
                try {
                    std::lock_guard lock(recording_mutex);
                    const auto at = monotonic_us();
                    apply_task_transitions(task_run.update(at));
                    const auto current = task_run.progress(at);
                    // A timed boundary can pass between drawing and activation. Keep
                    // a judgement attached to the repetition shown to the capture director.
                    if (current.phase != progress.phase || current.task_index != progress.task_index ||
                        current.repetition != progress.repetition || current.cycle != progress.cycle ||
                        current.paused)
                        return;
                    if (success) {
                        if (!episode_open || current.phase != TaskRunPhase::active_task)
                            return;
                        episode_attributes["outcome"] = *success ? "pass" : "fail";
                        episode_attributes["success"] = *success;
                    }
                    if (episode_open)
                        episode_attributes["completion"] = "done";
                    apply_task_transitions(task_run.advance(at));
                    ++recording_actions[success ? (*success ? "pass" : "fail") : "advance"];
                } catch (const std::exception& error) {
                    ui_error = error.what();
                }
            };
            const bool advance_enabled = task_running && !progress.paused;
            const bool outcome_enabled = advance_enabled && progress.phase == TaskRunPhase::active_task;
            const char* advance_label = progress.phase == TaskRunPhase::active_task ? "DONE" : "NEXT";
            ImGui::BeginDisabled(!advance_enabled);
            const auto next_cell = cell("##Advance", true);
            ui::instrument_text(next_cell, advance_label, instrument_label_font,
                                instrument_label_font->FontSize, .5f,
                                advance_enabled ? ui::colour::text : ui::colour::muted);
            ui::help(progress.phase == TaskRunPhase::active_task
                         ? "Complete this repetition and advance"
                         : "Finish this pause and advance");
            ImGui::EndDisabled();
            if (next_cell.pressed)
                advance_task(std::nullopt);
            ImGui::BeginDisabled(!outcome_enabled);
            const auto pass_cell = cell("##Pass", true);
            ui::instrument_text(pass_cell, "PASS", instrument_label_font,
                                instrument_label_font->FontSize, .5f,
                                outcome_enabled ? ui::colour::green : ui::colour::muted);
            ui::help("Mark this repetition as passed and advance");
            const auto fail_cell = cell("##Fail", true);
            ui::instrument_text(fail_cell, "FAIL", instrument_label_font,
                                instrument_label_font->FontSize, .5f,
                                outcome_enabled ? ui::colour::red : ui::colour::muted);
            ui::help("Mark this repetition as failed and advance");
            ImGui::EndDisabled();
            if (pass_cell.pressed || fail_cell.pressed)
                advance_task(pass_cell.pressed);

            const char* remaining_title = "REMAINING";
            std::string remaining = "OPEN";
            if (replay) {
                remaining_title = "REP REMAINING";
                remaining = replay_task ? elapsed_label(replay_task->end_us - replay_position + 999999) : "--";
            } else if (progress.phase == TaskRunPhase::complete) {
                remaining_title = "COMPLETE";
                remaining = "--";
            } else if (record_status.recording && progress.phase_remaining_us) {
                remaining = elapsed_label(*progress.phase_remaining_us + 999999);
                if (progress.phase == TaskRunPhase::post_task_pause)
                    remaining_title = "RESET";
                else if (progress.phase == TaskRunPhase::task_pause)
                    remaining_title = "WAIT";
                else if (progress.phase == TaskRunPhase::cycle_pause)
                    remaining_title = "CYCLE REST";
            } else if (step && step->type != TaskType::open) {
                remaining = elapsed_label(int64_t(std::ceil(step->duration_s * 1000000)) + 999999);
            }
            const auto remaining_cell = cell("##Remaining");
            ui::instrument_text(remaining_cell, remaining_title, instrument_label_font,
                                instrument_label_font->FontSize, .23f,
                                ui::colour::muted);
            ui::instrument_text(remaining_cell, remaining.c_str(), readout_font,
                                readout_font->FontSize, .64f,
                                 ui::colour::text);
            ui::help("Time remaining in the current repetition or labelled rest");

            const std::array<const char*, 3> rate_labels{"Pose", "Image", "Render"};
            const std::array<double, 3> rates{head_fps, video_fps, render_hz};
            for (size_t i = 0; i < rate_labels.size(); ++i) {
                const auto rate_cell = cell(rate_labels[i]);
                std::array<float, 60> values{};
                const auto count = fps_history[i].size();
                for (size_t j = 0; j < count; ++j)
                    values[j] = fps_history[i].sample(j);
                char reading[64];
                if (count)
                    std::snprintf(reading, sizeof(reading), "%s %.0f fps", rate_labels[i], rates[i]);
                else
                    std::snprintf(reading, sizeof(reading), "%s -- fps", rate_labels[i]);
                ui::instrument_text(rate_cell, reading, mono_font, mono_font->FontSize, .27f);
                const float maximum = std::max(60.f, std::ceil(fps_history[i].maximum() / 30.f) * 30.f);
                ui::instrument_trace(rate_cell, {values.data(), count}, maximum);
                ui::help(i == 0 ? "Head observations per second. Last 60 readings."
                         : i == 1 ? "Decoded camera images per second. Last 60 readings."
                                  : "Rendered frames per second. Last 60 readings.");
            }
            ImGui::GetWindowDrawList()->AddLine(
                {0, instrument_height - dpi}, {scene_width, instrument_height - dpi},
                ImGui::GetColorU32(ui::colour::border), dpi);
            if (!options.metrics.empty())
                instrument_bar_metrics = {
                    {"position", {0, 0}}, {"size", {scene_width, instrument_height}},
                    {"widths", widths}, {"header_height", instrument_height}, {"panels", panels},
                    {"clocks", clocks}, {"record_label", record_label}, {"recording", record_status.recording},
                    {"record_symbol", pending_recording ? "cancel" : stopping ? "stop"
                                         : symbol == ui::RecordSymbol::Pause ? "pause"
                                         : symbol == ui::RecordSymbol::Resume ? "resume" : "record"},
                    {"capturing", capturing}, {"hold_progress", record_press.progress()},
                    {"sidebar_heading_bounds", {{sidebar_heading_first.x, sidebar_heading_first.y},
                                                  {sidebar_heading_last.x, sidebar_heading_last.y}}},
                    {"paused", manual_recording_pause}, {"count_in", pending_recording.has_value()},
                    {"elapsed_label", elapsed}, {"counters", counters},
                    {"replay_task", replay ? replay_tasks.to_json(replay_position) : Json()},
                    {"replay_task_count", replay_tasks.tasks().size()},
                    {"remaining_label", remaining}, {"remaining_title", remaining_title},
                    {"task_controls", {{"repeat_enabled", repeat_enabled},
                        {"advance_enabled", advance_enabled}, {"outcome_enabled", outcome_enabled},
                        {"advance_label", advance_label}, {"repeat_hold_progress", repeat_press.progress()},
                        {"replay_bounds", {{repeat_cell.first.x, repeat_cell.first.y}, {repeat_cell.last.x, repeat_cell.last.y}}},
                        {"progress_bounds", {{progress_cell.first.x, progress_cell.first.y}, {progress_cell.last.x, progress_cell.last.y}}},
                        {"next_bounds", {{next_cell.first.x, next_cell.first.y}, {next_cell.last.x, next_cell.last.y}}},
                        {"pass_bounds", {{pass_cell.first.x, pass_cell.first.y}, {pass_cell.last.x, pass_cell.last.y}}},
                        {"fail_bounds", {{fail_cell.first.x, fail_cell.first.y}, {fail_cell.last.x, fail_cell.last.y}}}}},
                    {"spark_samples", {fps_history[0].size(), fps_history[1].size(), fps_history[2].size()}},
                    {"fps", rates}, {"actions", recording_actions}};
            ImGui::End();
            ImGui::PopStyleColor(3);
            ImGui::PopStyleVar(6);
        }
        if (replay) {
            ImGui::SetNextWindowPos({0, io.DisplaySize.y - replay_transport_height}, ImGuiCond_Always);
            ImGui::SetNextWindowSize({scene_width, replay_transport_height}, ImGuiCond_Always);
            ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0, 0));
            ImGui::PushStyleVar(ImGuiStyleVar_ItemSpacing, ImVec2(0, 0));
            ImGui::PushStyleVar(ImGuiStyleVar_WindowRounding, 0);
            ImGui::PushStyleVar(ImGuiStyleVar_WindowBorderSize, 0);
            ImGui::PushStyleVar(ImGuiStyleVar_FrameRounding, 0);
            ImGui::PushStyleVar(ImGuiStyleVar_FrameBorderSize, 0);
            ImGui::PushStyleColor(ImGuiCol_Button, ui::colour::surface);
            ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ui::colour::overlay);
            ImGui::PushStyleColor(ImGuiCol_ButtonActive, ui::colour::raised);
            ImGui::Begin("Replay transport", nullptr,
                         ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize |
                             ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoSavedSettings |
                             ImGuiWindowFlags_NoDocking | ImGuiWindowFlags_NoFocusOnAppearing |
                             ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoScrollWithMouse);
            float x = 0;
            const auto cell = [&](const char* id, float width, bool interactive = false) {
                ImGui::SetCursorPos({x, task_track_height});
                x += width;
                return ui::instrument_cell(id, {width, instrument_height}, interactive);
            };
            const auto clear_replay_frames = [&] {
                try {
                    capture_final_maps();
                } catch (const std::exception& error) {
                    map_error = error.what();
                }
                decoder->cancel_replay();
                secondary_decoder->cancel_replay();
                reset_stereo_acquisition();
                renderer->invalidate_video();
            };
            task_timeline_metrics = Json();
            if (task_track_height > 0 && replay->duration_us() > 0) {
                const auto origin = ImGui::GetWindowPos();
                const float track_left = origin.x + 12.f * dpi;
                const float track_width = std::max(1.f, scene_width - 24.f * dpi);
                const float track_top = origin.y + 4.f * dpi;
                const float track_height = task_track_height - 8.f * dpi;
                const auto position = replay->position_us();
                const auto* current = replay_tasks.at(position);
                const auto timeline_x = [&](int64_t at) {
                    return track_left + track_width * static_cast<float>(
                        std::clamp(double(at) / double(replay->duration_us()), 0., 1.));
                };
                auto* draw = ImGui::GetWindowDrawList();
                draw->AddRectFilled({track_left, track_top}, {track_left + track_width, track_top + track_height},
                                    ImGui::GetColorU32(ui::colour::raised));
                Json ranges = Json::array();
                for (size_t index = 0; index < replay_tasks.visible_spans().size(); ++index) {
                    const auto& span = replay_tasks.visible_spans()[index];
                    const auto& interval = replay_tasks.tasks()[span.task_index];
                    const float left = timeline_x(span.start_us), right = timeline_x(span.end_us);
                    if (right <= left) continue;
                    const bool active = &interval == current && position >= span.start_us && position < span.end_us;
                    const ImVec2 span_first{left, track_top}, span_last{right, track_top + track_height};
                    ImGui::PushID(static_cast<int>(index));
                    ImGui::SetCursorScreenPos(span_first);
                    const bool selected = ImGui::InvisibleButton("##RecordedTask", {right - left, track_height},
                                                                 ImGuiButtonFlags_EnableNav);
                    const bool hovered = ImGui::IsItemHovered() || ImGui::IsItemFocused();
                    draw->AddRectFilled(span_first, {std::max(left, right - dpi), span_last.y},
                        ImGui::GetColorU32(active || hovered ? ui::colour::overlay : ui::colour::surface));
                    draw->AddRect(span_first, {std::max(left, right - dpi), span_last.y},
                        ImGui::GetColorU32(active ? ui::colour::amber : ui::colour::border));
                    const auto counters = replay_task_counters(&interval);
                    const auto text_size = ImGui::CalcTextSize(counters.c_str());
                    if (text_size.x + 8.f * dpi <= right - left)
                        draw->AddText({left + ((right - left) - text_size.x) * .5f,
                                       track_top + (track_height - text_size.y) * .5f},
                                      ImGui::GetColorU32(active ? ui::colour::amber : ui::colour::text), counters.c_str());
                    if (hovered || ImGui::IsItemFocused()) {
                        ImGui::BeginTooltip();
                        ImGui::PushTextWrapPos(ImGui::GetFontSize() * 28.f);
                        ImGui::TextUnformatted(counters.c_str());
                        if (interval.take) ImGui::Text("Take %llu", static_cast<unsigned long long>(*interval.take));
                        ImGui::TextUnformatted(interval.title.c_str());
                        if (!interval.description.empty()) ImGui::TextWrapped("%s", interval.description.c_str());
                        ImGui::Text("%s to %s", replay_timestamp(interval.start_us).c_str(),
                                    replay_timestamp(interval.end_us).c_str());
                        ImGui::PopTextWrapPos();
                        ImGui::EndTooltip();
                    }
                    if (selected) {
                        clear_replay_frames();
                        replay->seek(span.start_us);
                    }
                    if (!options.metrics.empty())
                        ranges.push_back({{"start_us", span.start_us}, {"end_us", span.end_us},
                                          {"counters", counters}, {"title", interval.title}, {"active", active},
                                          {"bounds", {{span_first.x, span_first.y}, {span_last.x, span_last.y}}}});
                    ImGui::PopID();
                }
                const float playhead = timeline_x(position);
                draw->AddLine({playhead, track_top}, {playhead, track_top + track_height},
                              ImGui::GetColorU32(ui::colour::text), 2.f * dpi);
                if (!options.metrics.empty())
                    task_timeline_metrics = {{"ranges", std::move(ranges)}, {"position_us", position},
                                             {"counters", replay_task_counters(current)}};
            }
            const float play_width = std::min(100.f * dpi, scene_width * .13f);
            const float step_width = std::min(60.f * dpi, scene_width * .075f);
            const float speed_width = std::min(100.f * dpi, scene_width * .13f);
            const float time_width = std::min(175.f * dpi, scene_width * .22f);
            const auto play_cell = cell("##Playback", play_width, true);
            ui::instrument_text(play_cell, "PLAYBACK", instrument_label_font,
                                instrument_label_font->FontSize, .23f, ui::colour::muted);
            ui::instrument_text(play_cell, replay->playing() ? "PAUSE" : "PLAY", compact_readout_font, compact_readout_font->FontSize,
                                .64f, replay->playing() ? ui::colour::amber : ui::colour::green);
            if (play_cell.pressed) replay->set_playing(!replay->playing());
            for (const int direction : {-1, 1}) {
                const auto step_cell = cell(direction < 0 ? "##PreviousFrame" : "##NextFrame", step_width, true);
                ui::instrument_text(step_cell, "FRAME", instrument_label_font,
                                instrument_label_font->FontSize, .23f, ui::colour::muted);
                ui::instrument_text(step_cell, direction < 0 ? "-1" : "+1", readout_font,
                                    22.f * dpi, .64f);
                if (step_cell.pressed) {
                    replay->set_playing(false);
                    clear_replay_frames();
                    replay->step_frame(direction);
                }
            }
            const auto timeline = cell("##TimelineCell", scene_width - play_width - step_width * 2 - speed_width - time_width);
            const auto timeline_counters = replay_task_counters(replay_tasks.at(replay->position_us()));
            ui::instrument_text(timeline, replay_tasks.tasks().empty() ? "TIMELINE" : timeline_counters.c_str(),
                                instrument_label_font, instrument_label_font->FontSize, .22f, ui::colour::muted, false);
            ImGui::SetCursorScreenPos({timeline.first.x + 12.f * dpi, timeline.first.y + instrument_height * .47f});
            ImGui::SetNextItemWidth(std::max(1.f, timeline.last.x - timeline.first.x - 24.f * dpi));
            double position = replay->position_us() / 1e6, duration = replay->duration_us() / 1e6, zero = 0;
            ImGui::BeginDisabled(duration <= 0);
            ImGui::PushStyleColor(ImGuiCol_FrameBg, ui::colour::raised);
            ImGui::PushStyleColor(ImGuiCol_FrameBgHovered, ui::colour::overlay);
            ImGui::PushStyleColor(ImGuiCol_FrameBgActive, ui::colour::overlay);
            ImGui::PushStyleColor(ImGuiCol_SliderGrab, ui::colour::green);
            ImGui::PushStyleColor(ImGuiCol_SliderGrabActive, ui::colour::amber);
            if (ImGui::SliderScalar("##ReplayPosition", ImGuiDataType_Double, &position,
                                    &zero, &duration, "%.2f s", ImGuiSliderFlags_AlwaysClamp)) {
                clear_replay_frames();
                replay->seek(int64_t(position * 1e6));
            }
            ImGui::PopStyleColor(5);
            ImGui::EndDisabled();
            const auto speed_cell = cell("##SpeedCell", speed_width);
            ui::instrument_text(speed_cell, "SPEED", instrument_label_font, instrument_label_font->FontSize, .22f, ui::colour::muted);
            ImGui::SetCursorScreenPos({speed_cell.first.x + 8.f * dpi, speed_cell.first.y + instrument_height * .47f});
            ImGui::SetNextItemWidth(std::max(1.f, speed_width - 16.f * dpi));
            char speed_label[32]{};
            std::snprintf(speed_label, sizeof(speed_label), "%.2gx", replay->speed());
            if (ImGui::BeginCombo("##PlaybackSpeed", speed_label)) {
                for (double speed : {.25, .5, 1., 1.5, 2., 4.}) {
                    char label[32]{}; std::snprintf(label, sizeof(label), "%.2gx", speed);
                    if (ImGui::Selectable(label, replay->speed() == speed)) replay->set_speed(speed);
                }
                ImGui::EndCombo();
            }
            const auto time_cell = cell("##ReplayTime", time_width);
            const auto elapsed = elapsed_label(replay->position_us());
            const auto total = elapsed_label(replay->duration_us());
            ui::instrument_text(time_cell, elapsed.c_str(), readout_font, readout_font->FontSize, .35f);
            ui::instrument_text(time_cell, ("/ " + total).c_str(), mono_font, mono_font->FontSize, .72f, ui::colour::muted);
            ImGui::End();
            ImGui::PopStyleColor(3);
            ImGui::PopStyleVar(6);
        }
        if (!replay) task_timeline_metrics = Json();
        if (hf_status.authenticating && !hf_status.user_code.empty() && !hf_auth_popup) {
            ImGui::OpenPopup("Hugging Face sign-in");
            hf_auth_popup = true;
        }
        ImGui::SetNextWindowSize({420.f * dpi, 0}, ImGuiCond_Appearing);
        if (ImGui::BeginPopupModal("Hugging Face sign-in", nullptr, ImGuiWindowFlags_AlwaysAutoResize)) {
            if (!hf_status.authenticating) ImGui::CloseCurrentPopup();
            else {
                ImGui::TextWrapped("Enter this code in the Hugging Face browser window.");
                ImGui::PushFont(readout_font);
                ImGui::TextUnformatted(hf_status.user_code.c_str());
                ImGui::PopFont();
                ImGui::Text("Code expires in %d:%02d", hf_status.seconds_remaining / 60,
                            hf_status.seconds_remaining % 60);
                if (ImGui::Button("Copy code")) ImGui::SetClipboardText(hf_status.user_code.c_str());
                ImGui::SameLine();
                if (ImGui::Button("Open browser")) hf::open_browser(hf_status.verification_url);
                ImGui::SameLine();
                if (ImGui::Button("Cancel sign-in")) { hugging_face.cancel(); ImGui::CloseCurrentPopup(); }
                if (ImGui::Button("Get a new code")) { hf_new_code = true; hugging_face.cancel(); }
                ui::muted("Waiting for authorisation");
            }
            ImGui::EndPopup();
        }
        if (!hf_status.authenticating) hf_auth_popup = false;
        if (pending_recording) {
            auto current = source ? source->snapshot() : snap;
            if (glfwWindowShouldClose(window) ||
                (options.seconds && now - first >= options.seconds))
                cancel_count_in();
            else if (source_job.valid() || recovery_job.valid() || replay ||
                     pending_recording->source != source.get() ||
                     (!options.fixture &&
                      (!current.connected || current.connection != "Streaming")) ||
                     current.epoch != pending_recording->epoch ||
                     current.space_epoch != pending_recording->space_epoch)
                cancel_count_in("Recording cancelled: live source changed");
        }
        if (pending_recording) {
            const auto remaining = std::max<int64_t>(
                0, recording_count_in_us - (monotonic_us() - pending_recording->requested_us));
            const int beat = std::max(1, int((remaining + 999999) / 1000000));
            ImGui::SetNextWindowPos(
                {io.DisplaySize.x * (panels ? .4f : .5f), io.DisplaySize.y * .4f}, ImGuiCond_Always,
                {.5f, .5f});
            ImGui::SetNextWindowBgAlpha(.94f);
            ImGui::Begin("Recording count-in", nullptr,
                         ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_AlwaysAutoResize |
                             ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoSavedSettings |
                             ImGuiWindowFlags_NoDocking);
            ImGui::TextUnformatted("Count-in");
            ImGui::PushFont(count_in_font);
            const auto digit = std::to_string(beat);
            ImGui::SetCursorPosX((ImGui::GetWindowWidth() - ImGui::CalcTextSize(digit.c_str()).x) *
                                 .5f);
            ImGui::TextColored(ui::colour::amber, "%s", digit.c_str());
            ImGui::PopFont();
            if (ImGui::Button("Cancel", {160.f * dpi, 0}))
                cancel_count_in();
            ui::help("Escape cancels recording.");
            ImGui::End();
            if (pending_recording && remaining == 0) {
                const auto request = std::move(*pending_recording);
                pending_recording.reset();
                try {
                    begin_recording(request.path, snap);
                    std::lock_guard lock(recording_mutex);
                    if (task_specification)
                        apply_task_transitions(task_run.start(*task_specification, record_origin));
                    else
                        start_episode(record_origin, task[0] ? task : "Capture", Json::object());
                    recording_start_delay_seconds = (record_origin - request.requested_us) / 1e6;
                } catch (const std::exception& error) {
                    ui_error = error.what();
                    if (request.automatic)
                        automatic_record_error = error.what();
                }
            }
        }
        scene_camera_preview(*renderer, snap, !replay, view.projection, explicit_video_preview,
                             scene_width, instrument_height, dpi,
                             options.metrics.empty() ? nullptr : &camera_inset_metrics);
        auto ui_submit_started = std::chrono::steady_clock::now();
        ImGui::Render();
        ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());
        renderer->finish_frame();
        auto ui_submit_finished = std::chrono::steady_clock::now();
        if (!options.screenshot.empty() && !screenshot_taken &&
            now - first > std::max(1.0, options.seconds * .7)) {
            renderer->screenshot(options.screenshot);
            screenshot_bar_metrics = instrument_bar_metrics;
            screenshot_navigation_metrics = navigation_metrics;
            screenshot_task_overlay_metrics = task_overlay_metrics;
            screenshot_task_timeline_metrics = task_timeline_metrics;
            screenshot_spatial_controls = scene_spatial_controls;
            screenshot_sidebar_metrics = sidebar_metrics;
            screenshot_visibility_metrics = visibility_metrics;
            screenshot_export_ui_metrics = export_ui_metrics;
            screenshot_camera_inset_metrics = camera_inset_metrics;
            screenshot_taken = true;
        }
        auto swap_started = std::chrono::steady_clock::now();
        glfwSwapBuffers(window);
        auto swap_finished = std::chrono::steady_clock::now();
        renderer->notify_presented();
        if (now - first > 1) {
            poll_times.add(
                std::chrono::duration<double, std::milli>(poll_finished - frame_started).count());
            snapshot_times.add(
                std::chrono::duration<double, std::milli>(snapshot_finished - snapshot_started)
                    .count());
            video_update_times.add(std::chrono::duration<double, std::milli>(video_update_finished -
                                                                             video_update_started)
                                       .count());
            scene_cpu_times.add(
                std::chrono::duration<double, std::milli>(scene_finished - scene_started).count());
            ui_cpu_times.add(
                std::chrono::duration<double, std::milli>(ui_submit_finished - ui_submit_started)
                    .count());
            cpu_times.add(
                std::chrono::duration<double, std::milli>(swap_started - frame_started).count());
            swap_times.add(
                std::chrono::duration<double, std::milli>(swap_finished - swap_started).count());
            gpu_times.add(renderer->gpu_ms());
            frame_times.add(elapsed_frame * 1000);
            if (renderer->presented_frames() != last_presented) {
                last_presented = renderer->presented_frames();
                video_latencies.add(renderer->video_latency_ms());
            }
        }
        if (now >= preferences_due) {
            try {
                persist_preferences();
                persist_episodes();
            } catch (const std::exception& error) {
                ui_error = error.what();
            }
            preferences_due = now + 1;
        }
        ++frames;
        if (options.seconds && now - first >= options.seconds)
            glfwSetWindowShouldClose(window, GLFW_TRUE);
        auto pacing_started = std::chrono::steady_clock::now();
        if (glfwGetWindowAttrib(window, GLFW_ICONIFIED))
            glfwWaitEventsTimeout(.1);
        else if (!options.vsync)
            pacer.wait_until(frame_started +
                             std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                                 std::chrono::duration<double>(1. / options.fps)));
        if (now - first > 1)
            pacing_times.add(std::chrono::duration<double, std::milli>(
                                 std::chrono::steady_clock::now() - pacing_started)
                                 .count());
    }
    cancel_count_in();
    task_load_cancel.request_stop();
    if (task_load.valid()) {
        try {
            task_load.get();
        } catch (...) {
        }
    }
    auto final_receiver = source ? source->snapshot() : fixture;
    const auto final_stereo_update_age_ms =
        stereo_last_pair_us ? (monotonic_us() - stereo_last_pair_us) / 1000. : -1.;
    accepting = false;
    decoder->cancel_replay();
    secondary_decoder->cancel_replay();
    reset_stereo_acquisition();
    if (source_job.valid()) {
        try {
            source = source_job.get();
        } catch (...) {
        }
    }
    if (source)
        source->stop();
    if (recorder.status().recording) {
        end_episode(monotonic_us() - record_origin);
        recorder.stop();
    }
    exporter.cancel();
    try {
        capture_final_maps();
        for (auto& [path, store] : map_stores) {
            store->flush();
            if (!store->status().error.empty())
                map_error = store->status().error;
        }
    } catch (const std::exception& error) {
        map_error = error.what();
    }
    try {
        persist_preferences();
        persist_episodes();
    } catch (const std::exception& error) {
        std::cerr << "Preferences: " << error.what() << '\n';
    }
    int framebuffer_width = 0, framebuffer_height = 0;
    glfwGetFramebufferSize(window, &framebuffer_width, &framebuffer_height);
    auto* final_monitor = window_monitor(window);
    auto* final_mode = final_monitor ? glfwGetVideoMode(final_monitor) : nullptr;
    bool remote_session = false;
#ifdef _WIN32
    remote_session = GetSystemMetrics(SM_REMOTESESSION) != 0;
#endif
    if (!options.record.empty() && !auto_record_requested)
        automatic_record_error = "Requested recording source did not become ready";
    auto final_record = recorder.status();
    bool record_failed = final_record.failed || !automatic_record_error.empty();
    auto final_decoder = decoder->status();
    auto final_secondary = secondary_decoder->status();
    Json metrics = {
        {"opengl_vendor", reinterpret_cast<const char*>(glGetString(GL_VENDOR))},
        {"opengl_renderer", reinterpret_cast<const char*>(glGetString(GL_RENDERER))},
        {"opengl_version", reinterpret_cast<const char*>(glGetString(GL_VERSION))},
        {"render_frames", frames},
        {"secondary_decoded_frames", final_secondary.decoded},
        {"secondary_decoder_error", final_secondary.error},
        {"stereo_pairs", stereo_pair_count},
        {"environment_depth_updates", environment_updates},
        {"environment_depth_ms", renderer->environment_depth_ms()},
        {"environment_depth_source", environment_usage},
        {"environment_depth_timing", [&] {
            const auto& timing = renderer->environment_depth_timing();
            const auto optional_value = [](const std::optional<double>& value) {
                return value ? Json(*value) : Json();
            };
            return Json{{"valid", timing.valid}, {"replay", timing.replay},
                        {"sequence", timing.sequence}, {"geometry_source", timing.geometry_source},
                        {"readback_ms", optional_value(timing.readback_ms)},
                        {"target_lead_ms", optional_value(timing.target_lead_ms)},
                        {"callback_to_arrival_ms", optional_value(timing.callback_to_arrival_ms)},
                        {"arrival_to_submit_ms", timing.arrival_to_submit_ms},
                        {"submit_to_ready_ms", timing.submit_to_ready_ms}, {"gpu_ms", timing.gpu_ms}};
        }()},
        {"environment_depth_received", final_receiver.depth_frames},
        {"environment_depth_rejected", final_receiver.depth_rejected},
        {"environment_depth_status", final_receiver.depth_status},
        {"depth_source", view.depth_source},
        {"stereo_acquisition_windows", stereo_window_count},
        {"stereo_update_attempts", stereo_attempt_count},
        {"stereo_update_hz", view.stereo_update_hz},
        {"stereo_last_update_age_ms", final_stereo_update_age_ms},
        {"voxel_size", view.voxel_size},
        {"map_persistence", "tsdf-surface-cache"},
        {"map_frozen", view.map_frozen},
        {"map_shader", static_cast<int>(view.map_shader)},
        {"map_gradient", static_cast<int>(view.map_gradient)},
        {"map_style", static_cast<int>(view.map_style)},
        {"map_relief_strength", view.map_relief_strength},
        {"map_density", view.map_density},
        {"map_max_bytes", preferences.map_max_bytes},
        {"map_point_count", renderer->map_point_count(view.environment_depth) + renderer->saved_map_state().points},
        {"map_point_budget", map_point_budget()},
        {"map_point_capacity", renderer->map_point_capacity(view.environment_depth)},
        {"map_applied_point_budget", renderer->map_point_budget(view.environment_depth)},
        {"map_update_interval_seconds", renderer->map_update_interval(view.environment_depth)},
        {"depth_capture_enabled", depth_capture_enabled.load()},
        {"recording_has_depth", [&] {
            const auto recording = std::dynamic_pointer_cast<ReplaySource>(source);
            return recording && recording->has_depth_frames();
        }()},
        {"saved_map", [&] {
            const auto saved = renderer->saved_map_state();
            Json transform = Json::array();
            for (int column = 0; column < 4; ++column)
                for (int row = 0; row < 4; ++row) transform.push_back(saved.world_from_map[column][row]);
            return Json{{"loaded", saved.loaded}, {"placed", saved.placed}, {"fusing", saved.fusing},
                         {"points", saved.points}, {"generation", saved.generation},
                         {"capacity", saved.capacity}, {"point_budget", saved.point_budget},
                         {"update_interval_seconds", saved.update_interval_seconds},
                         {"world_from_map", std::move(transform)}, {"source", loaded_map_file.string()},
                         {"saved_file", saved_map_file.string()}, {"visible", view.saved_map_visible},
                         {"opacity", saved.placed ? view.saved_map_opacity : .12f * view.saved_map_opacity}};
        }()},
        {"scene_spatial_controls", scene_spatial_controls},
        {"scene_spatial_controls_at_screenshot", screenshot_spatial_controls},
        {"scene_spatial_actions", scene_spatial_actions},
        {"map_file", preferences.last_map.string()},
        {"map_error", map_error},
        {"map_freeze_environment_updates", frozen_environment_updates},
        {"map_freeze_stereo_pairs", frozen_stereo_pairs},
        {"map_memory_bytes", renderer->depth_map_bytes(view.environment_depth)},
        {"mask_hands", view.mask_hands},
        {"depth_lod", view.depth_lod},
        {"depth_opacity", view.depth_opacity},
        {"stereo_last_skew_ms", stereo_pair_skew_ms},
        {"stereo_gpu_ms", renderer->stereo_ms()},
        {"stereo_state", stereo_state},
        {"scene_assets", renderer->scene_assets()},
        {"presentation", renderer->presentation_metrics()},
        {"video_received_frames", final_receiver.video_frames},
        {"tracking_received_packets", final_receiver.received},
        {"receiver_rejected_packets", final_receiver.rejected},
        {"decoder_dropped_frames", final_decoder.dropped},
        {"seconds", glfwGetTime() - first},
        {"framebuffer_width", framebuffer_width},
        {"framebuffer_height", framebuffer_height},
        {"refresh_rate", final_mode ? final_mode->refreshRate : 0},
        {"remote_session", remote_session},
        {"pacing_timer_active", pacer.high_resolution_active()},
        {"render_limit_fps", options.fps},
        {"poll_events_p95_ms", poll_times.percentile(.95)},
        {"source_snapshot_p95_ms", snapshot_times.percentile(.95)},
        {"video_update_p95_ms", video_update_times.percentile(.95)},
        {"scene_draw_cpu_p95_ms", scene_cpu_times.percentile(.95)},
        {"ui_submit_cpu_p95_ms", ui_cpu_times.percentile(.95)},
        {"cpu_work_p95_ms", cpu_times.percentile(.95)},
        {"swap_p95_ms", swap_times.percentile(.95)},
        {"pacing_p95_ms", pacing_times.percentile(.95)},
        {"gpu_p50_ms", gpu_times.percentile(.5)},
        {"gpu_p95_ms", gpu_times.percentile(.95)},
        {"frame_p95_ms", frame_times.percentile(.95)},
        {"video_arrival_to_view_p95_ms", video_latencies.percentile(.95)},
        {"decoded_frames", final_decoder.decoded},
        {"presented_frames", renderer->presented_frames()},
        {"record_written_events", final_record.written_events},
        {"record_duration_us", final_record.duration_us},
        {"record_active_duration_us", final_record.active_duration_us},
        {"record_path", final_record.path.string()},
        {"task_specification", task_specification ? task_specification->to_json() : Json()},
        {"task_run_complete", task_run.progress(monotonic_us()).phase == TaskRunPhase::complete},
        {"task_cycle", task_run.progress(monotonic_us()).cycle},
        {"task_index", task_run.progress(monotonic_us()).task_index},
        {"task_repetition", task_run.progress(monotonic_us()).repetition},
        {"instrument_bar", instrument_bar_metrics},
        {"instrument_bar_at_screenshot", screenshot_bar_metrics},
        {"scene_navigation", navigation_metrics},
        {"scene_navigation_at_screenshot", screenshot_navigation_metrics},
        {"task_overlay", task_overlay_metrics},
        {"task_overlay_at_screenshot", screenshot_task_overlay_metrics},
        {"task_timeline", task_timeline_metrics},
        {"task_timeline_at_screenshot", screenshot_task_timeline_metrics},
        {"sidebar", sidebar_metrics},
        {"sidebar_at_screenshot", screenshot_sidebar_metrics},
        {"visibility", visibility_metrics},
        {"visibility_at_screenshot", screenshot_visibility_metrics},
        {"exporter_present", exporter_present},
        {"export_ui", export_ui_metrics},
        {"export_ui_at_screenshot", screenshot_export_ui_metrics},
        {"camera_inset", camera_inset_metrics},
        {"camera_inset_at_screenshot", screenshot_camera_inset_metrics},
        {"record_count_in_seconds", recording_count_in_us / 1000000},
        {"record_count_in_cancelled", recording_count_in_cancelled},
        {"record_start_delay_seconds", recording_start_delay_seconds},
        {"record_written_bytes", final_record.written_bytes},
        {"record_failed", record_failed},
        {"record_error",
         automatic_record_error.empty() ? final_record.error : automatic_record_error},
        {"record_status", record_failed               ? "failed"
                          : final_record.recording    ? "recording"
                          : final_record.path.empty() ? "idle"
                                                      : "complete"},
        {"decoder_error", final_decoder.error},
        {"gpu", final_decoder.gpu}, {"decoder_backend", final_decoder.backend}};
    if (!options.metrics.empty()) {
        if (!options.metrics.parent_path().empty())
            std::filesystem::create_directories(options.metrics.parent_path());
        std::ofstream f(options.metrics);
        f << metrics.dump(2) << '\n';
    }
    std::cout << metrics.dump() << '\n';
    source.reset();
    decoder.reset();
    secondary_decoder.reset();
    renderer.reset();
    ImGui_ImplOpenGL3_Shutdown();
    ImGui_ImplGlfw_Shutdown();
    ImGui::DestroyContext();
    glfwDestroyWindow(window);
    glfwTerminate();
    return final_decoder.error.empty() && final_secondary.error.empty() && !record_failed ? 0 : 1;
}
} // namespace ceres
