#include "ceres/pairing_qr.hpp"
#include <algorithm>
#include <cmath>
#include <imgui.h>
#include <optional>
#include <qrcodegen.hpp>
#include <stdexcept>

namespace ceres::ui {
namespace {
constexpr int quiet_zone = 4;
constexpr ImU32 paper = IM_COL32(255, 255, 255, 255);
constexpr ImU32 ink = IM_COL32(0, 0, 0, 255);
constexpr const char* popup_title = "Pairing QR code";

const std::optional<qrcodegen::QrCode>& encoded_qr(const std::string& url) {
    static std::string cached_url;
    static std::optional<qrcodegen::QrCode> cached;
    if (cached_url != url) {
        cached_url = url;
        cached.reset();
        if (!url.empty()) {
            try {
                cached = qrcodegen::QrCode::encodeText(url.c_str(), qrcodegen::QrCode::Ecc::MEDIUM);
            } catch (const std::length_error&) {
                // The access code remains available when the URL exceeds QR capacity.
            }
        }
    }
    return cached;
}

void draw_qr(const qrcodegen::QrCode& qr, ImVec2 first, ImVec2 last) {
    const auto scale = ImGui::GetIO().DisplayFramebufferScale;
    const float scale_x = scale.x > 0.f ? scale.x : 1.f;
    const float scale_y = scale.y > 0.f ? scale.y : 1.f;
    const float left = std::ceil(first.x * scale_x), top = std::ceil(first.y * scale_y);
    const float width = std::floor(last.x * scale_x) - left;
    const float height = std::floor(last.y * scale_y) - top;
    const int modules = qr.getSize() + quiet_zone * 2;
    const float cell = std::floor(std::min(width, height) / float(modules));
    if (cell < 1.f)
        return;
    const float side = cell * float(modules);
    const float x0 = left + std::floor((width - side) * .5f);
    const float y0 = top + std::floor((height - side) * .5f);
    auto* draw = ImGui::GetWindowDrawList();
    draw->AddRectFilled({x0 / scale_x, y0 / scale_y},
                        {(x0 + side) / scale_x, (y0 + side) / scale_y}, paper);
    for (int y = 0; y < qr.getSize(); ++y)
        for (int x = 0; x < qr.getSize(); ++x)
            if (qr.getModule(x, y)) {
                const float left_pixel = x0 + float(x + quiet_zone) * cell;
                const float top_pixel = y0 + float(y + quiet_zone) * cell;
                draw->AddRectFilled({left_pixel / scale_x, top_pixel / scale_y},
                                    {(left_pixel + cell) / scale_x, (top_pixel + cell) / scale_y},
                                    ink);
            }
}
} // namespace

bool pairing_qr_button(const std::string& url, float available_side) {
    const auto& qr = encoded_qr(url);
    if (!qr) {
        ImGui::TextWrapped("Use the access code to pair this headset.");
        return false;
    }
    const float side = std::max(1.f, available_side);
    bool pressed = ImGui::Button("##PairingQr", {side, side});
    const auto first = ImGui::GetItemRectMin(), last = ImGui::GetItemRectMax();
    const auto padding = ImGui::GetStyle().FramePadding;
    draw_qr(*qr, {first.x + padding.x, first.y + padding.y},
            {last.x - padding.x, last.y - padding.y});
    if (ImGui::IsItemHovered()) {
        ImGui::SetMouseCursor(ImGuiMouseCursor_Hand);
        ImGui::SetTooltip("Open a larger QR code");
    }
    pressed |= ImGui::Button("Enlarge QR code", {side, 0});
    return pressed;
}

void pairing_qr_popup(bool requested, const std::string& url, const std::string& code,
                      ImFont* code_font) {
    if (requested && !url.empty() && !code.empty())
        ImGui::OpenPopup(popup_title);
    const auto* viewport = ImGui::GetMainViewport();
    const auto& style = ImGui::GetStyle();
    const float margin = std::max(style.WindowPadding.x, style.WindowPadding.y);
    ImGui::SetNextWindowPos({viewport->WorkPos.x + viewport->WorkSize.x * .5f,
                             viewport->WorkPos.y + viewport->WorkSize.y * .5f},
                            ImGuiCond_Always, {.5f, .5f});
    ImGui::SetNextWindowSize({std::max(1.f, viewport->WorkSize.x - margin * 2.f),
                              std::max(1.f, viewport->WorkSize.y - margin * 2.f)});
    bool open = true;
    if (ImGui::BeginPopupModal(popup_title, &open,
                               ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoMove |
                                   ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoDocking)) {
        if (url.empty() || code.empty() || ImGui::IsKeyPressed(ImGuiKey_Escape, false)) {
            ImGui::CloseCurrentPopup();
        } else {
            ImGui::TextWrapped("Scan with your headset to open Ceres Bridge.");
            ImGui::PushFont(code_font);
            ImGui::Text("Access code: %s", code.c_str());
            ImGui::PopFont();
            const auto available = ImGui::GetContentRegionAvail();
            const float footer = ImGui::GetFrameHeightWithSpacing();
            const float side = std::max(1.f, std::min(available.x, available.y - footer));
            const auto cursor = ImGui::GetCursorScreenPos();
            const ImVec2 first{cursor.x + (available.x - side) * .5f, cursor.y};
            if (const auto& qr = encoded_qr(url); qr)
                draw_qr(*qr, first, {first.x + side, first.y + side});
            else
                ImGui::TextWrapped("Use the access code to pair this headset.");
            ImGui::SetCursorScreenPos({cursor.x, cursor.y + side + style.ItemSpacing.y});
            if (ImGui::Button("Close"))
                ImGui::CloseCurrentPopup();
            ImGui::SetItemDefaultFocus();
            ImGui::SameLine();
            ImGui::TextUnformatted("Escape to close");
        }
        ImGui::EndPopup();
    }
}
} // namespace ceres::ui
