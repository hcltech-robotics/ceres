#include "ceres/ui.hpp"
#include <GLFW/glfw3.h>
#include <imgui_impl_glfw.h>
#include <array>
#include <chrono>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>

namespace {
void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}

struct Field {
    ImVec2 input, copy;
};

struct Interface {
    std::array<char, 4096> destination{};
    std::string output = "/home/ceres/recordings/completed session.mcap";
    std::array<Field, 2> fields{};
    bool read_only = false;
    bool native_clipboard = false;
    float width = 480.f;

    Interface() {
        // Keep spaces, punctuation and UTF-8 intact without requiring terminal encoding.
        std::strcpy(destination.data(), "/home/ceres/export folder/%dataset-\xc3\xa9");
    }

    void frame() {
        // Let the desktop clipboard service process updates between UI frames.
        if (native_clipboard)
            std::this_thread::sleep_for(std::chrono::milliseconds(16));
        auto& io = ImGui::GetIO();
        io.DisplaySize = {1000.f, 900.f};
        io.DeltaTime = 1.f / 60.f;
        ImGui::NewFrame();
        ImGui::SetNextWindowPos({0.f, 0.f});
        ImGui::SetNextWindowSize({width, 800.f});
        ImGui::Begin("Paths", nullptr, ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize);
        for (size_t index = 0; index < fields.size(); ++index) {
            const char* label = index == 0 ? "Destination##Recording" : "Destination##LeRobot";
            const auto first = ImGui::GetCursorScreenPos();
            const auto& style = ImGui::GetStyle();
            const float label_width = ImGui::CalcTextSize("Destination").x;
            const float button_width = ImGui::CalcTextSize("Copy path").x + style.FramePadding.x * 2.f;
            const bool inline_button = label_width + style.ItemSpacing.x + button_width <=
                                       ImGui::GetContentRegionAvail().x;
            fields[index].copy = {
                first.x + (inline_button ? label_width + style.ItemSpacing.x : 0.f) + button_width * .5f,
                first.y + ImGui::GetFrameHeight() * .5f +
                    (inline_button ? 0.f : ImGui::GetFrameHeight() + style.ItemSpacing.y)};
            if (index == 0)
                ceres::ui::path_input(label, destination.data(), destination.size(),
                                     read_only ? ImGuiInputTextFlags_ReadOnly : 0);
            else
                ceres::ui::path_output(label, output.c_str());
            const auto minimum = ImGui::GetItemRectMin(), maximum = ImGui::GetItemRectMax();
            fields[index].input = {minimum.x + 12.f, (minimum.y + maximum.y) * .5f};
            require(maximum.x <= width && minimum.x >= 0.f && maximum.x > minimum.x,
                    "A path input exceeds the panel width");
            require(fields[index].copy.x < width, "A copy control exceeds the panel width");
        }
        ImGui::End();
        ImGui::Render();
    }

    void click(ImVec2 point) {
        auto& io = ImGui::GetIO();
        io.AddMouseViewportEvent(ImGui::GetMainViewport()->ID);
        io.AddMousePosEvent(point.x, point.y);
        frame();
        io.AddMouseButtonEvent(0, true);
        frame();
        io.AddMouseButtonEvent(0, false);
        frame();
    }

    void shortcut(ImGuiKey key) {
        auto& io = ImGui::GetIO();
        io.AddKeyEvent(ImGuiMod_Ctrl, true);
        io.AddKeyEvent(key, true);
        frame();
        io.AddKeyEvent(key, false);
        io.AddKeyEvent(ImGuiMod_Ctrl, false);
        frame();
    }
};

std::string clipboard;

void exercise(bool native_clipboard, GLFWwindow* window) {
    auto& io = ImGui::GetIO();
    io.IniFilename = nullptr;
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
    io.ConfigMacOSXBehaviors = false;
    unsigned char* pixels = nullptr;
    int width = 0, height = 0;
    io.Fonts->GetTexDataAsRGBA32(&pixels, &width, &height);
    if (!native_clipboard) {
        auto& platform = ImGui::GetPlatformIO();
        platform.Platform_SetClipboardTextFn = [](ImGuiContext*, const char* value) { clipboard = value; };
        platform.Platform_GetClipboardTextFn = [](ImGuiContext*) { return clipboard.c_str(); };
    }
    const auto read_clipboard = [&] {
        const char* value = native_clipboard ? glfwGetClipboardString(window) : clipboard.c_str();
        return std::string(value ? value : "");
    };
    for (const float dpi : {1.f, 2.f}) {
        ceres::ui::apply_style(dpi);
        for (const float panel_width : {480.f, 180.f}) {
            Interface ui;
            ui.native_clipboard = native_clipboard;
            ui.width = panel_width;
            ui.frame();
            ui.frame();
            for (const bool read_only : {false, true}) {
                ui.read_only = read_only;
                ui.click(ui.fields[0].input);
                ui.shortcut(ImGuiKey_A);
                ImGui::SetClipboardText("before shortcut");
                ui.shortcut(ImGuiKey_C);
                require(read_clipboard() == ui.destination.data(),
                        "Ctrl+C did not copy the complete selected destination");
                if (read_only) {
                    const std::string before = ui.destination.data();
                    io.AddInputCharactersUTF8("must not overwrite the recording destination");
                    ui.frame();
                    require(ui.destination.data() == before, "An active recording destination was editable");
                }
                ImGui::SetClipboardText("before button");
                ui.click(ui.fields[0].copy);
                require(read_clipboard() == ui.destination.data(),
                        "Copy path did not copy the destination");
            }
            ImGui::SetClipboardText("before output button");
            ui.click(ui.fields[1].copy);
            require(read_clipboard() == ui.output, "Copy path used another field's value");
            ui.click(ui.fields[1].input);
            ui.shortcut(ImGuiKey_A);
            ImGui::SetClipboardText("before output shortcut");
            ui.shortcut(ImGuiKey_C);
            require(read_clipboard() == ui.output, "A completed output path was not selectable");
            const std::string long_path = "/export/" + std::string(2000, 'p') + "/dataset";
            std::strcpy(ui.destination.data(), long_path.c_str());
            ui.frame();
            ui.click(ui.fields[0].copy);
            require(read_clipboard() == long_path, "A long path was truncated when copied");
            ui.destination[0] = '\0';
            ui.frame();
            ui.click(ui.fields[0].copy);
            require(read_clipboard() == long_path, "An empty destination overwrote the clipboard");
        }
    }
}
} // namespace

int main(int argc, char** argv) {
    const bool native_clipboard = argc > 1 && std::strcmp(argv[1], "--native-clipboard") == 0;
    GLFWwindow* window = nullptr;
    if (native_clipboard) {
        if (!glfwInit()) {
            std::cout << "A display is required for the native clipboard test\n";
            return 77;
        }
        glfwWindowHint(GLFW_VISIBLE, GLFW_FALSE);
        glfwWindowHint(GLFW_CLIENT_API, GLFW_NO_API);
        window = glfwCreateWindow(1000, 900, "Path clipboard test", nullptr, nullptr);
        if (!window) {
            glfwTerminate();
            return 77;
        }
    }
    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    if (native_clipboard)
        ImGui_ImplGlfw_InitForOther(window, true);
    int result = 0;
    try {
        exercise(native_clipboard, window);
        std::cout << (native_clipboard ? "Native GLFW clipboard" : "Path interaction") << " checks passed\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        result = 1;
    }
    if (native_clipboard)
        ImGui_ImplGlfw_Shutdown();
    ImGui::DestroyContext();
    if (window) {
        glfwDestroyWindow(window);
        glfwTerminate();
    }
    return result;
}
