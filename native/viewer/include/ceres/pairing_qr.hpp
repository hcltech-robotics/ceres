#pragma once

#include <string>

struct ImFont;

namespace ceres::ui {
// The image and its labelled action both open the enlarged pairing view.
bool pairing_qr_button(const std::string& url, float available_side);

// Submit outside the control pane so the enlarged view can use the whole window.
void pairing_qr_popup(bool requested, const std::string& url, const std::string& code,
                      ImFont* code_font = nullptr);
} // namespace ceres::ui
