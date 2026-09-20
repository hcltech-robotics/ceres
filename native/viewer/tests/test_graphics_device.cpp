#include "ceres/graphics_device.hpp"
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>

namespace {
using namespace ceres;

void check(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}

GraphicsEnvironment hybrid() {
    GraphicsEnvironment environment;
    environment.nvidia_driver = true;
    environment.glx_vendor = true;
    environment.egl_vendor = "/usr/share/glvnd/egl_vendor.d/10_nvidia.json";
    return environment;
}

std::string value(const std::vector<GraphicsVariable>& variables, const std::string& name) {
    for (const auto& variable : variables)
        if (variable.name == name)
            return variable.value;
    return {};
}

void selects_the_nvidia_gpu() {
    const auto variables = select_nvidia_graphics(hybrid());
    check(variables.size() == 3, "A complete driver offers GLX and EGL selection");
    check(value(variables, "__NV_PRIME_RENDER_OFFLOAD") == "1", "Render offload is requested");
    check(value(variables, "__GLX_VENDOR_LIBRARY_NAME") == "nvidia", "GLX uses the NVIDIA vendor");
    check(value(variables, "__EGL_VENDOR_LIBRARY_FILENAMES") == hybrid().egl_vendor,
          "EGL uses the installed NVIDIA vendor description");
}

void follows_the_installed_vendor_libraries() {
    auto environment = hybrid();
    environment.egl_vendor.clear();
    auto variables = select_nvidia_graphics(environment);
    check(variables.size() == 2 && value(variables, "__EGL_VENDOR_LIBRARY_FILENAMES").empty(),
          "A missing EGL vendor leaves EGL alone");
    environment.glx_vendor = false;
    environment.egl_vendor = hybrid().egl_vendor;
    variables = select_nvidia_graphics(environment);
    check(variables.size() == 2 && value(variables, "__GLX_VENDOR_LIBRARY_NAME").empty(),
          "A missing GLX vendor leaves GLX alone");
}

void retains_an_existing_choice() {
    auto environment = hybrid();
    environment.selected = true;
    check(select_nvidia_graphics(environment).empty(),
          "An explicit choice by the session is retained");
}

void leaves_other_systems_alone() {
    GraphicsEnvironment environment;
    check(select_nvidia_graphics(environment).empty(),
          "A system without an NVIDIA driver keeps its vendor");
    environment.nvidia_driver = true;
    check(select_nvidia_graphics(environment).empty(),
          "A driver without vendor libraries selects nothing");
}

void explains_a_mismatched_gpu() {
    const auto message =
        graphics_mismatch_message("Intel", "Mesa Intel(R) Graphics (RPL-S)", "unknown error");
    check(message.find("Mesa Intel(R) Graphics (RPL-S)") != std::string::npos,
          "The message names the OpenGL device");
    check(message.find("Intel") != std::string::npos, "The message names the OpenGL vendor");
    check(message.find("unknown error") != std::string::npos, "The message keeps the CUDA error");
    check(graphics_mismatch_message("", "", "unknown error").find("unidentified") !=
              std::string::npos,
          "An unnamed device is still described");
}

void applies_to_this_process() {
    const auto expected = select_nvidia_graphics(inspect_graphics_environment());
    const auto applied = prefer_nvidia_graphics();
    check(applied.size() == expected.size(), "The applied selection matches the inspected system");
    for (const auto& variable : applied) {
        const char* value = std::getenv(variable.name.c_str());
        check(value && variable.value == value, "Each selected variable reaches the process");
    }
    check(prefer_nvidia_graphics().empty() || applied.empty(),
          "A second call retains the applied selection");
}
} // namespace

int main() {
    try {
        selects_the_nvidia_gpu();
        follows_the_installed_vendor_libraries();
        retains_an_existing_choice();
        leaves_other_systems_alone();
        explains_a_mismatched_gpu();
        applies_to_this_process();
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
    std::cout << "Graphics device selection passed: hybrid selection, installed vendors, "
                 "retained choices and mismatch reporting\n";
    return 0;
}
