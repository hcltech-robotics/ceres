#include "ceres/graphics_device.hpp"
#include <cstdlib>
#include <filesystem>
#ifndef _WIN32
#include <dlfcn.h>
#endif

namespace ceres {
namespace {
#ifndef _WIN32
bool variable_set(const char* name) {
    const char* value = std::getenv(name);
    return value && *value;
}

bool driver_owns_a_gpu() {
    std::error_code error;
    std::filesystem::directory_iterator gpus("/proc/driver/nvidia/gpus", error);
    return !error && gpus != std::filesystem::directory_iterator{};
}

bool vendor_library_loads() {
    void* library = dlopen("libGLX_nvidia.so.0", RTLD_LAZY | RTLD_LOCAL);
    if (!library)
        return false;
    dlclose(library);
    return true;
}

// libglvnd reads the vendor descriptions from these directories, the first overriding the second.
std::string egl_vendor_description() {
    for (const auto* directory : {"/etc/glvnd/egl_vendor.d", "/usr/share/glvnd/egl_vendor.d"}) {
        std::error_code error;
        for (const auto& entry : std::filesystem::directory_iterator(directory, error)) {
            const auto name = entry.path().filename().string();
            if (name.find("nvidia") != std::string::npos && entry.path().extension() == ".json")
                return entry.path().string();
        }
    }
    return {};
}
#endif
} // namespace

GraphicsEnvironment inspect_graphics_environment() {
    GraphicsEnvironment environment;
#ifndef _WIN32
    environment.selected = variable_set("__NV_PRIME_RENDER_OFFLOAD") ||
                           variable_set("__GLX_VENDOR_LIBRARY_NAME") ||
                           variable_set("__EGL_VENDOR_LIBRARY_FILENAMES");
    environment.nvidia_driver = driver_owns_a_gpu();
    if (environment.nvidia_driver) {
        environment.glx_vendor = vendor_library_loads();
        environment.egl_vendor = egl_vendor_description();
    }
#endif
    return environment;
}

std::vector<GraphicsVariable> select_nvidia_graphics(const GraphicsEnvironment& environment) {
    std::vector<GraphicsVariable> variables;
    if (environment.selected || !environment.nvidia_driver ||
        (!environment.glx_vendor && environment.egl_vendor.empty()))
        return variables;
    variables.push_back({"__NV_PRIME_RENDER_OFFLOAD", "1"});
    if (environment.glx_vendor)
        variables.push_back({"__GLX_VENDOR_LIBRARY_NAME", "nvidia"});
    if (!environment.egl_vendor.empty())
        variables.push_back({"__EGL_VENDOR_LIBRARY_FILENAMES", environment.egl_vendor});
    return variables;
}

std::vector<GraphicsVariable> prefer_nvidia_graphics() {
    const auto variables = select_nvidia_graphics(inspect_graphics_environment());
#ifndef _WIN32
    for (const auto& variable : variables)
        setenv(variable.name.c_str(), variable.value.c_str(), 0);
#endif
    return variables;
}

std::string graphics_mismatch_message(const std::string& vendor, const std::string& renderer,
                                      const std::string& error) {
    std::string message = "OpenGL runs on ";
    message += renderer.empty() ? "an unidentified device" : "\"" + renderer + "\"";
    if (!vendor.empty())
        message += " from " + vendor;
    message += ", which shares no images with CUDA (" + error +
               "). The viewer needs OpenGL and CUDA on the same NVIDIA GPU.";
#ifndef _WIN32
    message += " On hybrid graphics, start it with __NV_PRIME_RENDER_OFFLOAD=1 "
               "__GLX_VENDOR_LIBRARY_NAME=nvidia, or give the session the NVIDIA GPU.";
#else
    message += " Assign the viewer to the NVIDIA GPU in the graphics settings of the system.";
#endif
    return message;
}
} // namespace ceres
