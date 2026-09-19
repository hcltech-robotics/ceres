#include "ceres/app.hpp"
#include "ceres/depth_display.hpp"
#include "ceres/depth.hpp"
#include "ceres/hand_mask.hpp"
#include "ceres/bridge.hpp"
#include "ceres/detail/accordion_motion.hpp"
#include "ceres/detail/recording_bar.hpp"
#include "ceres/detail/stereo_cadence.hpp"
#include "ceres/detail/stereo_pairing.hpp"
#include "ceres/stereo.hpp"
#include "ceres/export_job.hpp"
#include "ceres/mesh.hpp"
#include "ceres/protocol.hpp"
#include "ceres/renderer.hpp"
#include "ceres/session.hpp"
#include "ceres/task_specification.hpp"
#include "ceres/ui.hpp"
#include <GLFW/glfw3.h>
#include <algorithm>
#include <atomic>
#include <bit>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <fstream>
#include <future>
#include <glad/gl.h>
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
enum class PaneSection { none = -1, connection, hands, depth, task, recording, telemetry, calibration };
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
    std::string task_description, task_specification_path;
    std::optional<TaskSpecification> task_specification;
    Json to_json() const {
        return {
            {"schema", "ceres-viewer-preferences"},
            {"version", 1},
            {"data_directory", data_path.string()},
            {"recording_destination", recording_destination.string()},
            {"task",
             {{"description", task_description},
              {"path", task_specification_path},
              {"specification", task_specification ? task_specification->to_json() : Json()}}},
            {"stereo", {{"profile", stereo ? stereo->to_json() : Json()}, {"path", stereo_path}}},
            {"sections",
             {{"connection", section == PaneSection::connection},
               {"hands", section == PaneSection::hands},
               {"depth", section == PaneSection::depth},
              {"task", section == PaneSection::task},
              {"recording", section == PaneSection::recording},
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
              {"depth_min", view.depth_min},
              {"depth_max", view.depth_max},
              {"point_size", view.point_size},
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
    v.depth_min = view.value("depth_min", .2f);
    v.depth_max = view.value("depth_max", 5.f);
    v.point_size = view.value("point_size", 2.f);
    if (!std::isfinite(v.stereo_skew_ms) || !std::isfinite(v.depth_min) ||
        !std::isfinite(v.depth_max) || !std::isfinite(v.point_size) ||
        !std::isfinite(v.stereo_update_hz) || !std::isfinite(v.voxel_size) ||
        !std::isfinite(v.depth_opacity))
        throw std::runtime_error("Invalid stereo settings");
    v.stereo_skew_ms = std::clamp(v.stereo_skew_ms, 1.f, 20.f);
    v.stereo_update_hz = std::clamp(v.stereo_update_hz, .2f, 5.f);
    v.voxel_size = std::clamp(v.voxel_size, .01f, .1f);
    v.depth_opacity = std::clamp(v.depth_opacity, .1f, 1.f);
    v.depth_min = std::clamp(v.depth_min, .1f, 2.f);
    v.depth_max = std::clamp(v.depth_max, v.depth_min + .1f, 10.f);
    v.point_size = std::clamp(v.point_size, 1.f, 5.f);
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
                         : sections.value("task", false)        ? PaneSection::task
                         : sections.value("recording", false)   ? PaneSection::recording
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
    ui::small_label(label);
    ImGui::SetNextItemWidth(-1);
    const bool changed = ImGui::InputTextWithHint("##value", hint, value, capacity);
    ImGui::PopID();
    return changed;
}
bool pane_slider(const char* label, float* value, float minimum, float maximum,
                 const char* format = "%.3f") {
    ImGui::PushID(label);
    bool changed = false;
    const float label_width =
        std::max(ImGui::CalcTextSize("Trail span").x, ImGui::CalcTextSize(label).x) +
        ui::metrics().unit * 2.f;
    const bool stacked =
        ImGui::GetContentRegionAvail().x < label_width + ImGui::GetFontSize() * 7.f;
    if (ImGui::BeginTable("##slider", stacked ? 1 : 2,
                          ImGuiTableFlags_SizingStretchProp | ImGuiTableFlags_NoSavedSettings)) {
        if (!stacked) {
            ImGui::TableSetupColumn("Label", ImGuiTableColumnFlags_WidthFixed, label_width);
            ImGui::TableSetupColumn("Value", ImGuiTableColumnFlags_WidthStretch);
        }
        ImGui::TableNextColumn();
        if (!stacked)
            ImGui::AlignTextToFramePadding();
        ImGui::TextColored(ui::colour::muted, "%s", label);
        ImGui::TableNextColumn();
        ImGui::SetNextItemWidth(-1);
        changed = ImGui::SliderFloat("##value", value, minimum, maximum, format);
        ImGui::EndTable();
    }
    ImGui::PopID();
    return changed;
}
template <typename Mode, size_t N>
void pane_selector(const char* label, Mode& mode, const char* const (&choices)[N]) {
    ImGui::PushID(label);
    ui::small_label(label);
    ImGui::SetNextItemWidth(-1);
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
    ImGui::PopID();
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
};
std::filesystem::path episode_sidecar(const std::filesystem::path& session) {
    auto path = session;
    path += ".episodes.json";
    return path;
}
struct EpisodeSelection {
    std::vector<Episode> episodes;
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
    for (const auto& event : replay.episodes()) {
        const auto& a = event.attributes;
        if (a.value("action", std::string{}) == "stop" && a.contains("start_us") &&
            a.contains("end_us")) {
            Episode episode{a.at("start_us").get<int64_t>(), a.at("end_us").get<int64_t>(),
                            a.value("name", std::string{})};
            if (episode.start_us >= 0 && episode.end_us > episode.start_us)
                result.episodes.push_back(std::move(episode));
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
                            item.at("task").get<std::string>()};
            if (episode.start_us < 0 || episode.end_us <= episode.start_us ||
                episode.end_us > replay.duration_us())
                throw std::runtime_error("Episode sidecar contains an invalid range");
            episodes.push_back(std::move(episode));
        }
        result.episodes = std::move(episodes);
    } catch (const std::exception& error) {
        result.error = error.what();
    }
    return result;
}
void save_episodes(const std::filesystem::path& session, const std::vector<Episode>& episodes) {
    Json ranges = Json::array();
    for (const auto& episode : episodes) {
        if (episode.start_us < 0 || episode.end_us <= episode.start_us)
            throw std::runtime_error(
                "Episode ranges must have a non-negative start and a later end");
        ranges.push_back(
            {{"start_us", episode.start_us}, {"end_us", episode.end_us}, {"task", episode.task}});
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
        io.FontDefault = add_font(16);
        mono_font = std::filesystem::exists(mono_path)
                        ? io.Fonts->AddFontFromFileTTF(mono_path.string().c_str(), 15.f * dpi)
                        : io.FontDefault;
        readout_font = std::filesystem::exists(mono_path)
                           ? io.Fonts->AddFontFromFileTTF(mono_path.string().c_str(), 24.f * dpi)
                            : add_font(24);
        timer_font = std::filesystem::exists(mono_path)
                         ? io.Fonts->AddFontFromFileTTF(mono_path.string().c_str(), 32.f * dpi)
                         : add_font(32);
        count_in_font = std::filesystem::exists(mono_path)
                            ? io.Fonts->AddFontFromFileTTF(mono_path.string().c_str(), 60.f * dpi)
                            : add_font(60);
        ui::set_fonts(io.FontDefault, mono_font);
    };
    load_fonts();
    auto asset_directory = application_directory() / "assets";
    if (!std::filesystem::exists(asset_directory / "local"))
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
    std::atomic<bool> accepting{true};
    std::atomic<uint64_t> accepted_head_frames{0};
    detail::HoldPress record_press;
    bool record_keyboard_gesture = false;
    auto event_sink = [&](const SessionEvent& e) {
        if (!accepting.load())
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
        record_keyboard_gesture = false;
        decoder->cancel_replay();
        secondary_decoder->cancel_replay();
        reset_stereo_acquisition();
        reset_environment();
        renderer->invalidate_video();
        auto old = source;
        source_job = std::async(std::launch::async,
                                [&, old, replay, connect]() -> std::shared_ptr<SessionSource> {
                                    if (old)
                                        old->stop();
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
                                        o.identity_path = config / "receiver.identity";
                                        next = std::make_shared<BridgeClient>(o);
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
    int64_t fixture_pose_due = 0, fixture_video_due = 0;
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
            episodes.push_back({episode_begin, t, episode_task});
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
    std::array<float, 7> section_heights{}, section_scroll{};
    float section_width = 0.f;
    int previous_section = -1;
    int restore_x = 80, restore_y = 60, restore_w = options.width, restore_h = options.height;
    bool screenshot_taken = false, auto_record_requested = false;
    Json instrument_bar_metrics, screenshot_bar_metrics;
    Json sidebar_metrics, screenshot_sidebar_metrics, visibility_metrics, screenshot_visibility_metrics;
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
        auto poll_finished = std::chrono::steady_clock::now();
        double now = glfwGetTime(), elapsed_frame = now - previous,
               dt = std::min(.1, elapsed_frame);
        previous = now;
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
        if (!replay)
            view.pose_time_offset_ms = std::max(0.f, view.pose_time_offset_ms);
        if (replay != episode_replay) {
            try {
                persist_episodes();
            } catch (const std::exception& error) {
                ui_error = error.what();
            }
            episodes.clear();
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
                    if (!selected.error.empty())
                        ui_error = selected.error;
                }
            } catch (const std::exception& error) {
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
        if (view.pose_time_offset_ms != 0) {
            inspection.poses = {};
            auto offset = int64_t(
                (replay ? view.pose_time_offset_ms : std::max(0.f, view.pose_time_offset_ms)) *
                1000);
            if (replay) {
                auto target = replay->position_us() - offset;
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
                                snap.now_us +
                                    event.attributes.at("session_receive_us").get<int64_t>() -
                                    target);
                            pose.observed_us = snap.now_us + sample_time - target;
                            inspection.poses.at(pose.kind - 1) = std::move(pose);
                        } catch (const std::exception& error) {
                            ui_error = error.what();
                        }
                    }
                    inspection.clock.rate = 1;
                    inspection.clock.offset_us = 0;
                }
            } else {
                auto target = snap.now_us - offset;
                inspection.now_us = target;
                std::array<int64_t, 3> selected{};
                selected.fill(std::numeric_limits<int64_t>::min());
                std::lock_guard lock(history_mutex);
                for (const auto& timed : live_history) {
                    const auto& pose = timed.sample;
                    if (pose.epoch != snap.epoch || pose.space_epoch != snap.space_epoch ||
                        timed.time_us > target || timed.time_us < target - 50000)
                        continue;
                    auto index = pose.kind - 1;
                    if (timed.time_us >= selected[index]) {
                        selected[index] = timed.time_us;
                        inspection.poses[index] = pose;
                    }
                }
            }
        }
        auto calibration_changed = [&] {
            preferences.calibration = calibration;
            preferences.custom_calibration = custom_calibration;
            reset_stereo_acquisition();
            renderer->clear_stereo();
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
                        renderer->clear_stereo();
                    } else if (e.kind == EventKind::Epoch && !recording_marker(e)) {
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
            renderer->clear_stereo();
            renderer->clear_environment_depth();
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
        view.environment_depth =
            view.depth_source == 1 || (view.depth_source == 0 && environment_available);
        if (view.environment_depth && environment_event && !source_job.valid() &&
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
            renderer->clear_stereo();
            recorder.push(calibration_event(snap.epoch, snap.space_epoch));
        }
        const auto stereo_now_us = monotonic_us();
        const auto acquisition =
            stereo_cadence.update(stereo_now_us, view.stereo_update_hz,
                                  !view.environment_depth && dual_camera &&
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
        if (!dual_camera || !stereo_profile || view.environment_depth) {
            stereo_state = !dual_camera    ? "Two cameras required"
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
        auto scene_started = std::chrono::steady_clock::now();
        renderer->set_scene_width_fraction(panels ? .8f : 1.f);
        renderer->set_scene_top_fraction(instrument_height / std::max(1.f, io.DisplaySize.y));
        renderer->process_input(dt, io.WantCaptureMouse, io.WantCaptureKeyboard);
        const auto trail_time =
            replay ? std::max<int64_t>(0, replay->position_us() -
                                              int64_t(view.pose_time_offset_ms * 1000))
                   : inspection.now_us;
        const auto scene_time = replay ? replay->position_us() : snap.now_us;
        renderer->update_headset_position(snap, replay ? replay->speed() : 1.);
        renderer->draw(inspection, calibration, view, trail_time,
                       replay && view.pose_time_offset_ms == 0 ? replay->speed() : 1., scene_time);
        auto scene_finished = std::chrono::steady_clock::now();
        auto record_status = recorder.status();
        auto export_status = exporter.status();
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
            ImGui::PushFont(readout_font);
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
                                  ImGuiWindowFlags_NoScrollbar |
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
                    ui::small_label("Access code");
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
                pane_slider("Delay", &view.pose_time_offset_ms, replay ? -500.f : 0.f, 500.f,
                            "%+.0f ms");
                ui::help("Positive values inspect earlier tracking. Recording and export retain source timestamps.");
                ImGui::PopID();
                end_body();
            }
            if (section("Depth", "03", PaneSection::depth)) {
                begin_body("Depth body");
                ImGui::PushID("Depth");
                ImGui::PushID("Map");
                const char* sources[] = {"Automatic", "Quest depth", "Stereo"};
                ImGui::SetNextItemWidth(-1);
                ImGui::Combo("##Depth source", &view.depth_source, sources, 3);
                ui::help(
                    "Automatic uses Quest depth when available, with stereo as a fallback.");
                if (view.environment_depth) {
                    ui::muted(environment_available
                                  ? (environment_usage == "gpu-optimized" ? "Quest depth / GPU"
                                                                          : "Quest depth / CPU")
                                  : (snap.depth_status == "unsupported"
                                         ? "Quest depth unavailable"
                                         : "Waiting for Quest depth"));
                } else {
                    ui::muted(stereo_state.c_str());
                    pane_slider("Update", &view.stereo_update_hz, .2f, 5.f, "%.1f Hz");
                    ui::help("Paired captures per second. Video keeps its source cadence.");
                }
                const char* detail[] = {"Full", "Adaptive"};
                pane_selector("Detail", view.depth_lod, detail);
                float voxel_cm = view.voxel_size * 100.f;
                if (pane_slider("Voxel", &voxel_cm, 1.f, 10.f, "%.1f cm"))
                    view.voxel_size = voxel_cm / 100.f;
                ui::help("Scene cell size. Changing it starts a new volume.");
                ImGui::Checkbox("Mask hands", &view.mask_hands);
                ui::help("Exclude tracked fingers and palms while preserving the surfaces behind them.");
                if (ImGui::Button("Clear map", {-1, 0})) {
                    renderer->clear_stereo();
                    renderer->clear_environment_depth();
                    reset_stereo_acquisition();
                    environment_seen.reset();
                }
                ui::help("The map persists until new observations contradict it or its memory budget requires less detail.");
                float depth_opacity = view.depth_opacity * 100.f;
                if (pane_slider("Opacity", &depth_opacity, 10.f, 100.f, "%.0f %%"))
                    view.depth_opacity = depth_opacity / 100.f;
                if (!view.environment_depth) {
                    pane_slider("Pair limit", &view.stereo_skew_ms, 1.f, 20.f, "%.0f ms");
                    ui::help("Maximum difference between camera media timestamps. The cameras "
                             "expose independently.");
                }
                pane_slider("Near", &view.depth_min, .1f, 2.f, "%.2f m");
                view.depth_max = std::max(view.depth_max, view.depth_min + .1f);
                pane_slider("Far", &view.depth_max, view.depth_min + .1f, 10.f, "%.1f m");
                if (view.environment_depth) {
                    const ImVec2 start = ImGui::GetCursorScreenPos();
                    const float width = ImGui::GetContentRegionAvail().x;
                    const float height = 6.f * dpi;
                    const auto colour = [](float t) {
                        const auto c = spectral_depth_colour(t);
                        return ImGui::ColorConvertFloat4ToU32({c.r, c.g, c.b, 1.f});
                    };
                    for (int i = 0; i < 7; ++i)
                        ImGui::GetWindowDrawList()->AddRectFilledMultiColor(
                            {start.x + width * i / 7.f, start.y},
                            {start.x + width * (i + 1) / 7.f, start.y + height},
                            colour(i / 7.f), colour((i + 1) / 7.f),
                            colour((i + 1) / 7.f), colour(i / 7.f));
                    ImGui::Dummy({width, height});
                    ui::help("Spectral depth: warm nearby, cool farther away. Conflicting observations reduce opacity.");
                }
                pane_slider("Points", &view.point_size, 1.f, 5.f, "%.0f px");
                ImGui::PopID();
                ImGui::Separator();
                ui::small_label("Scene");
                ImGui::Checkbox("Grid", &view.grid);
                same_line_if_room("Frustum", true);
                ImGui::Checkbox("Frustum", &view.frusta);
                ImGui::Separator();
                ui::small_label("Image");
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
                    if (ImGui::Button("Hands", {-1, 0}))
                        renderer->frame_hands(inspection);
                    ImGui::TableNextColumn();
                    if (ImGui::Button("Headset", {-1, 0}))
                        renderer->headset_view(inspection);
                    ImGui::EndTable();
                }

                ImGui::PopID();
                end_body();
            }
            if (section("Task", "04", PaneSection::task)) {
                begin_body("Task body");
                ImGui::PushID("Task");
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
                ImGui::PopID();
                end_body();
            }
            if (section("Recording", "05", PaneSection::recording)) {
                begin_body("Recording body");
                ImGui::PushID("Recording");
                ImGui::BeginDisabled(record_status.recording || pending_recording.has_value());
                pane_text_input("Destination", recording_destination,
                                sizeof(recording_destination));
                ImGui::EndDisabled();
                if (!recording_start_notice.empty())
                    ImGui::TextWrapped("%s", recording_start_notice.c_str());
                if (record_status.failed)
                    ImGui::TextWrapped("%s", record_status.error.c_str());
                if (ui::disclosure("Replay", replay ? ImGuiTreeNodeFlags_DefaultOpen : 0)) {
                    ImGui::PushID("Replay");
                    pane_text_input("File", session_path, sizeof(session_path), ".mcap");
                    if (ImGui::Button("Open"))
                        change_source(session_path, false);
                    if (replay) {
                        same_line_if_room(replay->playing() ? "Pause" : "Play");
                        if (ImGui::Button(replay->playing() ? "Pause###Playback"
                                                            : "Play###Playback"))
                            replay->set_playing(!replay->playing());
                        double position = replay->position_us() / 1e6,
                               duration = replay->duration_us() / 1e6, zero = 0;
                        ImGui::TextUnformatted("Timeline");
                        ImGui::SetNextItemWidth(-1);
                        if (ImGui::SliderScalar("##Timeline", ImGuiDataType_Double, &position,
                                                &zero, &duration, "%.3f s")) {
                            decoder->cancel_replay();
                            secondary_decoder->cancel_replay();
                            reset_stereo_acquisition();
                            renderer->invalidate_video();
                            replay->seek(int64_t(position * 1e6));
                        }
                        float speed = float(replay->speed());
                        if (pane_slider("Speed", &speed, .1f, 4.f, "%.1fx"))
                            replay->set_speed(speed);
                        if (ImGui::Button("Previous")) {
                            replay->set_playing(false);
                            decoder->cancel_replay();
                            secondary_decoder->cancel_replay();
                            reset_stereo_acquisition();
                            renderer->invalidate_video();
                            replay->step_frame(-1);
                        }
                        same_line_if_room("Next");
                        if (ImGui::Button("Next")) {
                            replay->set_playing(false);
                            decoder->cancel_replay();
                            secondary_decoder->cancel_replay();
                            reset_stereo_acquisition();
                            renderer->invalidate_video();
                            replay->step_frame(1);
                        }
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
                    ImGui::PopID();
                }
                if (ui::disclosure("Episodes")) {
                    if (episode_load.valid())
                        ui::muted("Loading");
                    else if (episodes.empty())
                        ui::muted("No ranges. Mark in replay.");
                    ImGui::BeginDisabled(episode_load.valid());
                    for (size_t i = 0; i < episodes.size(); ++i) {
                        ImGui::PushID(int(i));
                        auto& e = episodes[i];
                        char label[512]{};
                        text_buffer(label, e.task);
                        if (pane_text_input("Task", label, sizeof(label))) {
                            e.task = label;
                            episodes_dirty = true;
                        }
                        double start = e.start_us / 1e6, end = e.end_us / 1e6;
                        ImGui::TextUnformatted("Start (s)");
                        ImGui::SetNextItemWidth(-1);
                        if (ImGui::InputDouble("##Start (s)", &start) && std::isfinite(start)) {
                            e.start_us = int64_t(std::clamp(start, 0., 9e9) * 1e6);
                            episodes_dirty = true;
                        }
                        ImGui::TextUnformatted("End (s)");
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
                if (ui::disclosure("Export")) {
                    pane_text_input("Destination", export_path, sizeof(export_path));
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
                        ImGui::BeginDisabled(episodes.empty() || record_status.recording ||
                                             episode_load.valid());
                        if (ui::primary_button("Export###RunExport")) {
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
            if (section("Telemetry", "06", PaneSection::telemetry)) {
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
                        ui::small_label(labels[i]);
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
                        metric_value("Depth", renderer->environment_depth_ms(), "ms", 2);
                        metric_value("Updates", environment_hz, "Hz", 1);
                        metric_value("Rejected", double(snap.depth_rejected), "", 0);
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
                if (!decoder_status.error.empty())
                    ImGui::TextWrapped("%s", decoder_status.error.c_str());
                ImGui::PopID();
                end_body();
            }
            if (section("Calibration", "07", PaneSection::calibration)) {
                begin_body("Calibration body");
                ImGui::PushID("Calibration");
                ui::small_label("Camera");
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
                ImGui::Separator();
                ui::small_label("Stereo");
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
                        renderer->clear_stereo();
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
                    renderer->clear_stereo();
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
            const std::array<const char*, 5> labels{"HAND", "HMD", "TRL", "RGB", "DEPTH"};
            const std::array<const char*, 5> help{
                "Show hands", "Show headset", "Show hand trails", "Show camera image and frustum",
                "Show spatial map"};
            const std::array<bool*, 5> values{&view.hands, &view.headset, &view.trails,
                                              &view.projection, &view.depth};
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
                const auto toggle = ui::visibility_toggle(labels[i], *values[i],
                                                          {right - left, footer_height});
                ui::help(help[i]);
                if (toggle.pressed)
                    ++visibility_actions[labels[i]];
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

            const auto elapsed = elapsed_label(record_status.active_duration_us);
            const auto time_cell = cell("##Recorded");
            ui::instrument_text(time_cell, manual_recording_pause ? "PAUSED" : "RECORDED",
                                mono_font, 11.f * dpi, .23f, ui::colour::muted);
            ui::instrument_text(time_cell, elapsed.c_str(), timer_font, timer_font->FontSize,
                                .64f, manual_recording_pause ? ui::colour::amber : ui::colour::text);
            ui::help(record_status.failed ? record_status.error.c_str() : "Recorded time, excluding pauses");

            const auto progress = task_run.progress(monotonic_us());
            const auto* step = task_run.current_task();
            const bool ready = progress.phase == TaskRunPhase::stopped;
            const bool have_spec = task_specification && !task_specification->tasks.empty();
            if (have_spec && ready)
                step = &task_specification->tasks.front();
            std::string counters = "--";
            if (have_spec) {
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
            const auto progress_cell = cell("##Progress");
            ui::instrument_text(progress_cell, "CYCLE / TASK / REP", mono_font, 11.f * dpi,
                                .23f, ui::colour::muted);
            ui::instrument_text(progress_cell, counters.c_str(), mono_font, 18.f * dpi, .64f);
            ui::help(step && !step->instructions.empty() ? step->instructions.c_str()
                     : step ? step->label.c_str() : "No task specification");

            const bool next_open = record_status.recording && !record_status.paused && step &&
                                   step->type == TaskType::open &&
                                   progress.phase == TaskRunPhase::active_task;
            const char* remaining_title = next_open ? "NEXT REP" : "REMAINING";
            std::string remaining = "OPEN";
            if (progress.phase == TaskRunPhase::complete) {
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
            const auto remaining_cell = cell("##Remaining", next_open);
            ui::instrument_text(remaining_cell, remaining_title, mono_font, 11.f * dpi, .23f,
                                ui::colour::muted);
            ui::instrument_text(remaining_cell, remaining.c_str(), readout_font,
                                readout_font->FontSize, .64f,
                                next_open ? ui::colour::amber : ui::colour::text);
            ui::help(next_open ? "Complete this open repetition and advance"
                              : "Time remaining in the current repetition or labelled rest");
            if (remaining_cell.pressed) {
                std::lock_guard lock(recording_mutex);
                apply_task_transitions(task_run.advance(monotonic_us()));
            }

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
                ui::instrument_text(rate_cell, reading, mono_font, 14.f * dpi, .27f);
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
                    {"remaining_label", remaining}, {"remaining_title", remaining_title},
                    {"spark_samples", {fps_history[0].size(), fps_history[1].size(), fps_history[2].size()}},
                    {"fps", rates}, {"actions", recording_actions}};
            ImGui::End();
            ImGui::PopStyleColor(3);
            ImGui::PopStyleVar(6);
        }
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
        auto ui_submit_started = std::chrono::steady_clock::now();
        ImGui::Render();
        ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());
        renderer->finish_frame();
        auto ui_submit_finished = std::chrono::steady_clock::now();
        if (!options.screenshot.empty() && !screenshot_taken &&
            now - first > std::max(1.0, options.seconds * .7)) {
            renderer->screenshot(options.screenshot);
            screenshot_bar_metrics = instrument_bar_metrics;
            screenshot_sidebar_metrics = sidebar_metrics;
            screenshot_visibility_metrics = visibility_metrics;
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
        {"environment_depth_received", final_receiver.depth_frames},
        {"environment_depth_rejected", final_receiver.depth_rejected},
        {"environment_depth_status", final_receiver.depth_status},
        {"depth_source", view.depth_source},
        {"stereo_acquisition_windows", stereo_window_count},
        {"stereo_update_attempts", stereo_attempt_count},
        {"stereo_update_hz", view.stereo_update_hz},
        {"stereo_last_update_age_ms", final_stereo_update_age_ms},
        {"voxel_size", view.voxel_size},
        {"map_persistence", "evidence"},
        {"map_memory_bytes", renderer->depth_map_bytes(view.environment_depth)},
        {"mask_hands", view.mask_hands},
        {"depth_lod", view.depth_lod},
        {"depth_opacity", view.depth_opacity},
        {"stereo_last_skew_ms", stereo_pair_skew_ms},
        {"stereo_gpu_ms", renderer->stereo_ms()},
        {"stereo_state", stereo_state},
        {"scene_assets", renderer->scene_assets()},
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
        {"sidebar", sidebar_metrics},
        {"sidebar_at_screenshot", screenshot_sidebar_metrics},
        {"visibility", visibility_metrics},
        {"visibility_at_screenshot", screenshot_visibility_metrics},
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
        {"gpu", final_decoder.gpu}};
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
