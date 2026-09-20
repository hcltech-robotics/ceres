#pragma once
#include "ceres/types.hpp"
#include <array>
#include <cmath>
#include <limits>
#include <optional>

namespace ceres {
struct CameraPresentation {
    unsigned texture = 0;
    int width = 0, height = 0;
    uint32_t sequence = 0;
    bool in_current_space = false, spatially_placed = false;

    bool flat_preview(bool live, bool rgb, bool explicit_preview_visible) const {
        return live && rgb && texture && width > 0 && height > 0 && in_current_space &&
               !spatially_placed && !explicit_preview_visible;
    }
};

namespace detail {
// A decoded image can be shown without inventing a spatial association. This
// only reads the recorded association and never adjusts media timestamps.
inline std::optional<std::array<float, 7>> associated_camera_head(
    const SessionEvent& image, uint32_t epoch, uint32_t space_epoch) {
    if (image.epoch != epoch || image.space_epoch != space_epoch)
        return std::nullopt;
    const auto values = image.attributes.find("head_pose");
    if (values == image.attributes.end() || !values->is_array() || values->size() != 7)
        return std::nullopt;
    std::array<float, 7> pose{};
    double rotation_length = 0;
    for (size_t i = 0; i < pose.size(); ++i) {
        if (!(*values)[i].is_number())
            return std::nullopt;
        const auto value = (*values)[i].get<double>();
        if (!std::isfinite(value) || std::abs(value) > std::numeric_limits<float>::max())
            return std::nullopt;
        pose[i] = float(value);
        if (i >= 3)
            rotation_length += value * value;
    }
    return rotation_length >= .5 && rotation_length <= 1.5 ? std::optional{pose} : std::nullopt;
}
} // namespace detail
} // namespace ceres
