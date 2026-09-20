#pragma once
#include <string>
#include <vector>

namespace ceres {
// CUDA shares images with OpenGL only when both run on the same NVIDIA GPU. Hybrid-graphics
// systems give a process the integrated GPU unless it asks for the discrete one, and the request
// has to be made before the first OpenGL context exists.

// One environment variable that selects the graphics vendor for this process.
struct GraphicsVariable {
    std::string name, value;
};

// What the local system offers. Gathered from the driver and the loader, or supplied by tests.
struct GraphicsEnvironment {
    bool nvidia_driver = false; // The NVIDIA kernel driver owns at least one GPU.
    bool glx_vendor = false;    // The NVIDIA GLX vendor library loads.
    bool selected = false;      // The session already chose a vendor.
    std::string egl_vendor;     // The NVIDIA EGL vendor description, empty when absent.
};

GraphicsEnvironment inspect_graphics_environment();
// The variables to set, empty when the selection is left alone.
std::vector<GraphicsVariable> select_nvidia_graphics(const GraphicsEnvironment& environment);
// Applies the selection to this process. Call before initialising GLFW. Existing variables are
// retained, so an explicit choice by the session or the launcher always wins.
std::vector<GraphicsVariable> prefer_nvidia_graphics();
// The failure shown when OpenGL and CUDA end up on different GPUs.
std::string graphics_mismatch_message(const std::string& vendor, const std::string& renderer,
                                      const std::string& error);
} // namespace ceres
