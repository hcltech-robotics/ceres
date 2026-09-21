#include "ceres/pairing_qr.hpp"
#include <algorithm>
#include <cmath>
#include <imgui.h>
#include <iostream>
#include <qrcodegen.hpp>
#include <stdexcept>
#include <vector>

namespace {
const std::string self_hosted_url = "https://192.168.90.194:4317/bridge/?code=NWAAUUWEN";

void check(bool value, const char* reason) {
    if (!value)
        throw std::runtime_error(reason);
}

struct Rect {
    ImVec2 first, last;
};
struct Symbol {
    Rect paper{};
    std::vector<Rect> modules;
};

bool near(float a, float b) {
    return std::abs(a - b) < .002f;
}

Symbol largest_symbol() {
    Symbol result;
    const auto* data = ImGui::GetDrawData();
    for (const auto* list : data->CmdLists) {
        Symbol candidate;
        for (int i = 0; i + 3 < list->VtxBuffer.Size; ++i) {
            const auto* v = &list->VtxBuffer[i];
            if (v[0].col != IM_COL32(255, 255, 255, 255) && v[0].col != IM_COL32(0, 0, 0, 255))
                continue;
            bool flat = true;
            for (int j = 1; j < 4; ++j)
                flat &= v[j].col == v[0].col && near(v[j].uv.x, v[0].uv.x) &&
                        near(v[j].uv.y, v[0].uv.y);
            if (!flat || !near(v[0].pos.y, v[1].pos.y) || !near(v[1].pos.x, v[2].pos.x) ||
                !near(v[2].pos.y, v[3].pos.y) || !near(v[3].pos.x, v[0].pos.x) ||
                v[2].pos.x <= v[0].pos.x || v[2].pos.y <= v[0].pos.y)
                continue;
            const Rect rect{v[0].pos, v[2].pos};
            if (v[0].col == IM_COL32(255, 255, 255, 255))
                candidate.paper = rect;
            else
                candidate.modules.push_back(rect);
            i += 3;
        }
        if (candidate.paper.last.x - candidate.paper.first.x >
            result.paper.last.x - result.paper.first.x)
            result = std::move(candidate);
    }
    return result;
}

void verify_symbol(const Symbol& symbol, const std::string& url, ImVec2 scale) {
    const auto expected =
        qrcodegen::QrCode::encodeText(url.c_str(), qrcodegen::QrCode::Ecc::MEDIUM);
    const float cell =
        (symbol.paper.last.x - symbol.paper.first.x) * scale.x / float(expected.getSize() + 8);
    check(cell >= 1.f && near(cell, std::round(cell)), "Modules occupy whole framebuffer pixels");
    check(near((symbol.paper.last.y - symbol.paper.first.y) * scale.y,
               (symbol.paper.last.x - symbol.paper.first.x) * scale.x),
          "The symbol remains square in framebuffer pixels");
    for (const auto& rect : symbol.modules) {
        for (const auto point : {rect.first, rect.last}) {
            check(near(point.x * scale.x, std::round(point.x * scale.x)) &&
                      near(point.y * scale.y, std::round(point.y * scale.y)),
                  "Module edges align to framebuffer pixels");
        }
        check(near((rect.last.x - rect.first.x) * scale.x, cell) &&
                  near((rect.last.y - rect.first.y) * scale.y, cell),
              "Every module has the same physical size");
        const int x = int(std::round((rect.first.x - symbol.paper.first.x) * scale.x / cell)) - 4;
        const int y = int(std::round((rect.first.y - symbol.paper.first.y) * scale.y / cell)) - 4;
        check(x >= 0 && y >= 0 && x < expected.getSize() && y < expected.getSize(),
              "The four-module quiet zone stays empty on every side");
        check(expected.getModule(x, y), "The rendered symbol encodes the complete pairing URL");
    }
    size_t expected_count = 0;
    for (int y = 0; y < expected.getSize(); ++y)
        for (int x = 0; x < expected.getSize(); ++x)
            expected_count += expected.getModule(x, y) ? 1 : 0;
    check(symbol.modules.size() == expected_count, "Every encoded module is drawn exactly once");
}

struct Harness {
    std::string url = self_hosted_url, code = "NWAAUUWEN";
    ImVec2 display{1280.f, 900.f}, scale{1.f, 1.f};
    float pane_width = 280.f;
    bool show_pane = true, focus_qr = false;
    Rect image{}, enlarge{};

    Harness() {
        IMGUI_CHECKVERSION();
        ImGui::CreateContext();
        auto& io = ImGui::GetIO();
        io.IniFilename = nullptr;
        io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
        unsigned char* pixels = nullptr;
        int width = 0, height = 0;
        io.Fonts->GetTexDataAsRGBA32(&pixels, &width, &height);
        io.Fonts->SetTexID(1);
        ImGui::GetStyle().Colors[ImGuiCol_Text] = {.9f, .9f, .9f, 1.f};
    }
    ~Harness() {
        ImGui::DestroyContext();
    }

    bool frame(bool request = false) {
        auto& io = ImGui::GetIO();
        io.DisplaySize = display;
        io.DisplayFramebufferScale = scale;
        io.DeltaTime = 1.f / 60.f;
        ImGui::NewFrame();
        bool pressed = false;
        if (show_pane) {
            ImGui::SetNextWindowPos({17.25f, 19.25f});
            ImGui::SetNextWindowSize({pane_width + 16.f, display.y - 40.f});
            ImGui::Begin("Connection", nullptr, ImGuiWindowFlags_NoSavedSettings);
            image.first = ImGui::GetCursorScreenPos();
            image.last = {image.first.x + pane_width, image.first.y + pane_width};
            if (focus_qr) {
                ImGui::SetKeyboardFocusHere();
                ImGui::SetNavCursorVisible(true);
                focus_qr = false;
            }
            pressed = ceres::ui::pairing_qr_button(url, pane_width);
            enlarge = {ImGui::GetItemRectMin(), ImGui::GetItemRectMax()};
            ImGui::End();
        }
        ceres::ui::pairing_qr_popup(request || pressed, url, code);
        const bool open = ImGui::IsPopupOpen("Pairing QR code");
        ImGui::Render();
        return open;
    }

    bool click(Rect rect) {
        auto& io = ImGui::GetIO();
        io.AddMousePosEvent((rect.first.x + rect.last.x) * .5f, (rect.first.y + rect.last.y) * .5f);
        frame();
        io.AddMouseButtonEvent(0, true);
        frame();
        io.AddMouseButtonEvent(0, false);
        return frame();
    }

    bool key(ImGuiKey key) {
        auto& io = ImGui::GetIO();
        io.AddKeyEvent(key, true);
        const bool on_press = frame();
        io.AddKeyEvent(key, false);
        const bool on_release = frame();
        return on_press || on_release;
    }
};

void preview_sizes_and_pixels() {
    Harness harness;
    for (const float width : {160.f, 280.f, 460.f}) {
        harness.pane_width = width;
        for (const auto scale : {ImVec2{1.f, 1.f}, ImVec2{1.25f, 1.25f}, ImVec2{2.f, 2.f},
                                 ImVec2{.75f, .75f}, ImVec2{1.25f, 1.5f}}) {
            harness.scale = scale;
            harness.frame();
            harness.frame();
            const auto symbol = largest_symbol();
            verify_symbol(symbol, harness.url, scale);
            check(symbol.paper.first.x >= harness.image.first.x &&
                      symbol.paper.last.x <= harness.image.last.x &&
                      symbol.paper.first.y >= harness.image.first.y &&
                      symbol.paper.last.y <= harness.image.last.y,
                  "The preview fits its button at every pane width and display scale");
            if (width == 280.f && scale.x == 1.f && scale.y == 1.f)
                check(symbol.paper.last.x - symbol.paper.first.x > 200.f,
                      "The pane preview uses the available width beyond the old 132 pixel cap");
        }
    }
}

void enlarge_and_refresh() {
    Harness harness;
    harness.frame();
    harness.frame();
    check(harness.click(harness.image), "Clicking the QR image opens the large view");
    harness.frame();
    auto symbol = largest_symbol();
    verify_symbol(symbol, harness.url, harness.scale);
    check(symbol.paper.last.x - symbol.paper.first.x > 700.f,
          "The large view uses the full window beyond the control pane");
    harness.show_pane = false;
    harness.display = {640.f, 480.f};
    harness.url =
        "https://a-much-longer-self-hosted-bridge.example.test:4317/bridge/?code=ABCDEFGHJ";
    harness.code = "ABCDEFGHJ";
    check(harness.frame(), "The view stays available when the control pane is hidden");
    harness.frame();
    symbol = largest_symbol();
    verify_symbol(symbol, harness.url, harness.scale);
    check(symbol.paper.first.x >= 0.f && symbol.paper.last.x <= harness.display.x &&
              symbol.paper.first.y >= 0.f && symbol.paper.last.y < harness.display.y - 30.f,
          "Resizing retains the full quiet zone and space for dismissal");
    harness.key(ImGuiKey_Escape);
    check(!harness.frame(), "Escape dismisses the large view");
    harness.show_pane = true;
    harness.frame();
    harness.frame();
    check(harness.click(harness.enlarge), "The labelled enlarge action also opens the view");
    harness.code.clear();
    check(!harness.frame(), "Removing the pairing invitation closes the large view");
}

void keyboard_and_empty_states() {
    Harness harness;
    harness.frame();
    harness.focus_qr = true;
    harness.frame();
    harness.frame();
    check(harness.key(ImGuiKey_Space), "Keyboard activation of the image opens the large view");
    harness.frame();
    harness.key(ImGuiKey_Enter);
    check(!harness.frame(), "The default Close action dismisses the view from the keyboard");
    harness.url.clear();
    check(!harness.frame(true), "An empty invitation does not open a popup");
    harness.url.assign(10000, 'x');
    harness.frame();
    check(largest_symbol().modules.empty(), "An oversized URL leaves the access code fallback");
}
} // namespace

int main() {
    try {
        preview_sizes_and_pixels();
        enlarge_and_refresh();
        keyboard_and_empty_states();
        std::cout << "Pairing QR tests passed\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
