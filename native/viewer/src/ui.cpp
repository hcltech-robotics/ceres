#include "ceres/ui.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cfloat>
#include <cstring>

namespace ceres::ui {
namespace {
Metrics dimensions;
ImFont* body_font = nullptr;
ImFont* mono_font = nullptr;
ImFont* label_font = nullptr;

const ImVec4 amber_surface{.290f, .251f, .165f, 1.f};
const ImVec4 amber_hover{.345f, .294f, .184f, 1.f};
const ImVec4 amber_active{.247f, .212f, .137f, 1.f};
const ImVec4 red_surface{.341f, .204f, .176f, 1.f};
const ImVec4 red_hover{.400f, .239f, .208f, 1.f};
const ImVec4 red_active{.294f, .173f, .149f, 1.f};
const ImVec4 transparent{0.f, 0.f, 0.f, 0.f};

const char* safe(const char* text) {
    return text ? text : "";
}

const char* visible_end(const char* text) {
    while (*text && !(text[0] == '#' && text[1] == '#'))
        ++text;
    return text;
}

void right_aligned_text(const char* text) {
    const float width = ImGui::CalcTextSize(text).x;
    ImGui::SetCursorPosX(ImGui::GetCursorPosX() +
                         std::max(0.f, ImGui::GetContentRegionAvail().x - width));
    ImGui::TextUnformatted(text);
}

struct GradientChoice {
    DepthGradient gradient;
    const char* label;
};

constexpr std::array gradient_choices{
    GradientChoice{DepthGradient::spectral, "Spectral"},
    GradientChoice{DepthGradient::viridis, "Viridis"},
    GradientChoice{DepthGradient::plasma, "Plasma"},
    GradientChoice{DepthGradient::inferno, "Inferno"},
    GradientChoice{DepthGradient::greys, "Greys"},
};

void gradient_swatch(ImDrawList* draw, ImVec2 first, ImVec2 last, DepthGradient gradient) {
    if (last.x <= first.x || last.y <= first.y)
        return;
    constexpr int segments = 32;
    const auto tone = [gradient](float fraction) {
        const auto value = depth_gradient_colour(gradient, fraction);
        return ImGui::GetColorU32({value.r, value.g, value.b, 1.f});
    };
    for (int index = 0; index < segments; ++index) {
        const float start = float(index) / segments;
        const float end = float(index + 1) / segments;
        draw->AddRectFilledMultiColor(
            {first.x + (last.x - first.x) * start, first.y},
            {first.x + (last.x - first.x) * end, last.y},
            tone(start), tone(end), tone(end), tone(start));
    }
}
} // namespace

void apply_style(float dpi) {
    dpi = std::isfinite(dpi) ? std::clamp(dpi, .75f, 4.f) : 1.f;
    dimensions = {dpi, 4.f * dpi, 12.f * dpi, 12.f * dpi, 28.f * dpi, 6.f * dpi,
                  96.f * dpi, 152.f * dpi};
    auto& style = ImGui::GetStyle();
    style = ImGuiStyle{};
    style.WindowPadding = {12.f, 12.f};
    style.FramePadding = {8.f, 4.f};
    style.CellPadding = {0.f, 2.f};
    style.ItemSpacing = {8.f, 4.f};
    style.ItemInnerSpacing = {6.f, 4.f};
    style.IndentSpacing = 16.f;
    style.ScrollbarSize = 10.f;
    style.GrabMinSize = 8.f;
    style.WindowRounding = 1.f;
    style.ChildRounding = 1.f;
    style.PopupRounding = 2.f;
    style.FrameRounding = 1.f;
    style.ScrollbarRounding = 1.f;
    style.GrabRounding = 1.f;
    style.TabRounding = 1.f;
    style.WindowBorderSize = 1.f;
    style.ChildBorderSize = 1.f;
    style.PopupBorderSize = 1.f;
    style.FrameBorderSize = 1.f;
    style.TabBorderSize = 1.f;
    style.DisabledAlpha = .82f;
    style.SeparatorTextBorderSize = 1.f;
    style.SeparatorTextPadding = {0.f, 6.f};
    style.WindowMenuButtonPosition = ImGuiDir_None;
    style.ColorButtonPosition = ImGuiDir_Right;
    style.ButtonTextAlign = {.5f, .5f};
    style.SelectableTextAlign = {0.f, .5f};

    auto* colours = style.Colors;
    colours[ImGuiCol_Text] = colour::text;
    colours[ImGuiCol_TextDisabled] = colour::muted;
    colours[ImGuiCol_WindowBg] = colour::surface;
    colours[ImGuiCol_ChildBg] = colour::surface;
    colours[ImGuiCol_PopupBg] = colour::raised;
    colours[ImGuiCol_Border] = colour::border;
    colours[ImGuiCol_BorderShadow] = transparent;
    colours[ImGuiCol_FrameBg] = colour::surface;
    colours[ImGuiCol_FrameBgHovered] = colour::raised;
    colours[ImGuiCol_FrameBgActive] = colour::overlay;
    colours[ImGuiCol_TitleBg] = colour::surface;
    colours[ImGuiCol_TitleBgActive] = colour::raised;
    colours[ImGuiCol_TitleBgCollapsed] = colour::surface;
    colours[ImGuiCol_MenuBarBg] = colour::raised;
    colours[ImGuiCol_ScrollbarBg] = colour::surface;
    colours[ImGuiCol_ScrollbarGrab] = colour::border;
    colours[ImGuiCol_ScrollbarGrabHovered] = colour::muted;
    colours[ImGuiCol_ScrollbarGrabActive] = colour::amber;
    colours[ImGuiCol_CheckMark] = colour::green;
    colours[ImGuiCol_SliderGrab] = colour::green;
    colours[ImGuiCol_SliderGrabActive] = colour::amber;
    colours[ImGuiCol_Button] = colour::raised;
    colours[ImGuiCol_ButtonHovered] = colour::overlay;
    colours[ImGuiCol_ButtonActive] = colour::surface;
    colours[ImGuiCol_Header] = colour::raised;
    colours[ImGuiCol_HeaderHovered] = colour::overlay;
    colours[ImGuiCol_HeaderActive] = colour::surface;
    colours[ImGuiCol_Separator] = colour::border;
    colours[ImGuiCol_SeparatorHovered] = colour::muted;
    colours[ImGuiCol_SeparatorActive] = colour::amber;
    colours[ImGuiCol_ResizeGrip] = colour::border;
    colours[ImGuiCol_ResizeGripHovered] = colour::muted;
    colours[ImGuiCol_ResizeGripActive] = colour::amber;
    colours[ImGuiCol_Tab] = colour::surface;
    colours[ImGuiCol_TabHovered] = colour::overlay;
    colours[ImGuiCol_TabSelected] = colour::raised;
    colours[ImGuiCol_TabSelectedOverline] = colour::amber;
    colours[ImGuiCol_TabDimmed] = colour::surface;
    colours[ImGuiCol_TabDimmedSelected] = colour::raised;
    colours[ImGuiCol_TabDimmedSelectedOverline] = colour::border;
#ifdef IMGUI_HAS_DOCK
    colours[ImGuiCol_DockingPreview] = {colour::green.x, colour::green.y, colour::green.z, .3f};
    colours[ImGuiCol_DockingEmptyBg] = colour::surface;
#endif
    colours[ImGuiCol_PlotLines] = colour::green;
    colours[ImGuiCol_PlotLinesHovered] = colour::amber;
    colours[ImGuiCol_PlotHistogram] = colour::green;
    colours[ImGuiCol_PlotHistogramHovered] = colour::amber;
    colours[ImGuiCol_TableHeaderBg] = colour::raised;
    colours[ImGuiCol_TableBorderStrong] = colour::border;
    colours[ImGuiCol_TableBorderLight] = colour::border;
    colours[ImGuiCol_TableRowBg] = transparent;
    colours[ImGuiCol_TableRowBgAlt] = colour::raised;
    colours[ImGuiCol_TextLink] = colour::green;
    colours[ImGuiCol_TextSelectedBg] = {.35f, .32f, .22f, .65f};
    colours[ImGuiCol_DragDropTarget] = colour::amber;
    colours[ImGuiCol_NavCursor] = colour::amber;
    colours[ImGuiCol_NavWindowingHighlight] = colour::text;
    colours[ImGuiCol_NavWindowingDimBg] = {0.f, 0.f, 0.f, .4f};
    colours[ImGuiCol_ModalWindowDimBg] = {0.f, 0.f, 0.f, .65f};
    // ImGui 1.91.9b has no FontScaleDpi. The host rebuilds its atlas for DPI changes.
    style.ScaleAllSizes(dpi);
}

void set_fonts(ImFont* body, ImFont* mono, ImFont* instrument_label) {
    body_font = body;
    mono_font = mono ? mono : body;
    label_font = instrument_label ? instrument_label : body;
}

const Metrics& metrics() {
    return dimensions;
}

bool section(const char* label, const char* index, bool& open) {
    label = safe(label);
    index = safe(index);
    ImGui::PushFont(body_font);
    ImGui::PushID(label);
    ImGui::SetNextItemOpen(open, ImGuiCond_Always);
    ImGui::PushStyleVar(ImGuiStyleVar_FramePadding,
                        ImVec2(8.f * dimensions.dpi, 6.f * dimensions.dpi));
    open = ImGui::CollapsingHeader(label, ImGuiTreeNodeFlags_SpanFullWidth);
    ImGui::PopStyleVar();
    const auto first = ImGui::GetItemRectMin();
    const auto last = ImGui::GetItemRectMax();
    const float label_end =
        first.x + ImGui::CalcTextSize(label, visible_end(label)).x + 36.f * dimensions.dpi;
    ImGui::PushFont(mono_font);
    const auto number_size = ImGui::CalcTextSize(index);
    const float number_x = last.x - number_size.x - 10.f * dimensions.dpi;
    if (*index && number_x > label_end && ImGui::IsItemVisible()) {
        auto* draw = ImGui::GetWindowDrawList();
        draw->PushClipRect(first, last, true);
        draw->AddText(ImGui::GetFont(), ImGui::GetFontSize(),
                      {number_x, first.y + (last.y - first.y - number_size.y) * .5f},
                      ImGui::GetColorU32(colour::muted), index);
        draw->PopClipRect();
    }
    ImGui::PopFont();
    ImGui::PopID();
    ImGui::PopFont();
    return open;
}

bool disclosure(const char* label, ImGuiTreeNodeFlags flags) {
    ImGui::PushStyleColor(ImGuiCol_Header, transparent);
    ImGui::PushStyleVar(ImGuiStyleVar_FrameBorderSize, 0.f);
    const bool open =
        ImGui::CollapsingHeader(safe(label), flags | ImGuiTreeNodeFlags_SpanFullWidth);
    ImGui::PopStyleVar();
    ImGui::PopStyleColor();
    return open;
}

void indicator(const char* label, bool active, bool warning) {
    label = safe(label);
    const auto position = ImGui::GetCursorScreenPos();
    const float line_height = ImGui::GetTextLineHeight();
    const float lamp = dimensions.lamp_size;
    const ImVec2 first{position.x, position.y + (line_height - lamp) * .5f};
    const ImVec2 last{first.x + lamp, first.y + lamp};
    ImGui::Dummy({lamp, line_height});
    if (ImGui::IsItemVisible()) {
        auto* draw = ImGui::GetWindowDrawList();
        draw->PushClipRect(position, {position.x + lamp, position.y + line_height}, true);
        const auto signal = warning ? colour::amber : colour::green;
        if (active || warning)
            draw->AddRectFilled(first, last, ImGui::GetColorU32(signal));
        else
            draw->AddRect(first, last, ImGui::GetColorU32(colour::muted), 0.f, 0, dimensions.dpi);
        draw->PopClipRect();
    }
    ImGui::SameLine(0.f, dimensions.unit * 2.f);
    ImGui::TextUnformatted(label);
}

void metric(const char* label, const char* value, const char* unit) {
    label = safe(label);
    value = value && *value ? value : "--";
    unit = safe(unit);
    ImGui::PushID(label);
    if (ImGui::BeginTable("##metric", 3,
                          ImGuiTableFlags_SizingStretchProp | ImGuiTableFlags_NoSavedSettings)) {
        ImGui::TableSetupColumn("Label", ImGuiTableColumnFlags_WidthStretch, .55f);
        ImGui::TableSetupColumn("Value", ImGuiTableColumnFlags_WidthStretch, .45f);
        ImGui::TableSetupColumn("Unit", ImGuiTableColumnFlags_WidthFixed, 48.f * dimensions.dpi);
        ImGui::TableNextRow();
        ImGui::TableSetColumnIndex(0);
        ImGui::TextColored(colour::muted, "%s", label);
        help(label);
        ImGui::TableSetColumnIndex(1);
        ImGui::PushFont(mono_font);
        right_aligned_text(value);
        help(value);
        ImGui::PopFont();
        ImGui::TableSetColumnIndex(2);
        ImGui::SetCursorPosX(ImGui::GetCursorPosX() + dimensions.unit * 1.5f);
        ImGui::TextColored(colour::muted, "%s", unit);
        ImGui::EndTable();
    }
    ImGui::PopID();
}

bool primary_button(const char* label, bool recording) {
    ImGui::PushStyleColor(ImGuiCol_Button, recording ? red_surface : amber_surface);
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, recording ? red_hover : amber_hover);
    ImGui::PushStyleColor(ImGuiCol_ButtonActive, recording ? red_active : amber_active);
    ImGui::PushStyleColor(ImGuiCol_Border, recording ? colour::red : colour::amber);
    ImGui::PushStyleColor(ImGuiCol_Text, colour::text);
    const bool pressed =
        ImGui::Button(safe(label), {-1.f, dimensions.row_height + dimensions.unit * 2.f});
    ImGui::PopStyleColor(5);
    return pressed;
}

void muted(const char* text) {
    ImGui::PushStyleColor(ImGuiCol_Text, colour::muted);
    ImGui::PushTextWrapPos(0.f);
    ImGui::TextUnformatted(safe(text));
    ImGui::PopTextWrapPos();
    ImGui::PopStyleColor();
}

void help(const char* text) {
    if (text && *text &&
        ImGui::IsItemHovered(ImGuiHoveredFlags_DelayNormal | ImGuiHoveredFlags_AllowWhenDisabled)) {
        ImGui::BeginTooltip();
        ImGui::PushTextWrapPos(ImGui::GetFontSize() * 22.f);
        ImGui::TextUnformatted(text);
        ImGui::PopTextWrapPos();
        ImGui::EndTooltip();
    }
}

void field_label(const char* label) {
    label = safe(label);
    ImGui::PushFont(body_font);
    ImGui::PushStyleColor(ImGuiCol_Text, colour::muted);
    ImGui::PushTextWrapPos(0.f);
    ImGui::TextUnformatted(label, visible_end(label));
    ImGui::PopTextWrapPos();
    ImGui::PopStyleColor();
    ImGui::PopFont();
}

bool path_input(const char* label, char* value, size_t capacity,
                ImGuiInputTextFlags flags, const char* hint) {
    IM_ASSERT(value && capacity > 0);
    ImGui::PushID(safe(label));
    const float right = ImGui::GetCursorScreenPos().x + ImGui::GetContentRegionAvail().x;
    ImGui::AlignTextToFramePadding();
    field_label(label);
    const auto& style = ImGui::GetStyle();
    const float button_width = ImGui::CalcTextSize("Copy path").x + style.FramePadding.x * 2.f;
    if (ImGui::GetItemRectMax().x + style.ItemSpacing.x + button_width <= right)
        ImGui::SameLine();
    auto* storage = ImGui::GetStateStorage();
    const auto feedback_id = ImGui::GetID("##copied_until");
    const bool copied = storage->GetFloat(feedback_id) > ImGui::GetTime();
    ImGui::BeginDisabled(!*value);
    if (ImGui::Button(copied ? "Copied###copy" : "Copy path###copy", {button_width, 0.f})) {
        ImGui::SetClipboardText(value);
        storage->SetFloat(feedback_id, static_cast<float>(ImGui::GetTime() + 1.5));
    }
    ImGui::EndDisabled();
    ImGui::SetNextItemWidth(-1.f);
    const bool changed = ImGui::InputTextWithHint("##value", safe(hint), value, capacity, flags);
    ImGui::PopID();
    return changed;
}

void path_output(const char* label, const char* value) {
    value = safe(value);
    // Dear ImGui does not write to the caller's buffer for a read-only input.
    path_input(label, const_cast<char*>(value), std::strlen(value) + 1,
               ImGuiInputTextFlags_ReadOnly);
}

void subsection(const char* label, bool first) {
    if (!first) {
        const float spacing = ImGui::GetStyle().ItemSpacing.y;
        ImGui::Dummy({0.f, std::max(0.f, dimensions.section_gap - spacing * 2.f)});
    }
    ImGui::PushFont(body_font);
    ImGui::PushStyleColor(ImGuiCol_Text, colour::text);
    ImGui::PushStyleVar(ImGuiStyleVar_SeparatorTextPadding, ImVec2(0.f, dimensions.unit));
    ImGui::SeparatorText(safe(label));
    ImGui::PopStyleVar();
    ImGui::PopStyleColor();
    ImGui::PopFont();
}

bool begin_field(const char* label) {
    label = safe(label);
    ImGui::PushID(label);
    ImGui::PushFont(body_font);
    const float label_width = ImGui::CalcTextSize(label, visible_end(label)).x;
    const bool stacked =
        ImGui::GetContentRegionAvail().x < dimensions.field_label_width + dimensions.field_min_width ||
        label_width + dimensions.unit * 2.f > dimensions.field_label_width;
    if (!ImGui::BeginTable("##field", stacked ? 1 : 2,
                           ImGuiTableFlags_SizingStretchProp | ImGuiTableFlags_NoSavedSettings)) {
        ImGui::PopFont();
        ImGui::PopID();
        return false;
    }
    if (!stacked) {
        ImGui::TableSetupColumn("Label", ImGuiTableColumnFlags_WidthFixed,
                                dimensions.field_label_width);
        ImGui::TableSetupColumn("Value", ImGuiTableColumnFlags_WidthStretch);
    }
    ImGui::TableNextColumn();
    if (!stacked)
        ImGui::AlignTextToFramePadding();
    field_label(label);
    ImGui::TableNextColumn();
    ImGui::SetNextItemWidth(-1.f);
    return true;
}

void end_field() {
    ImGui::EndTable();
    ImGui::PopFont();
    ImGui::PopID();
}

bool gradient_picker(const char* label, DepthGradient& gradient) {
    label = safe(label);
    ImGui::PushID(label);
    ImGui::PushFont(body_font);
    const auto& style = ImGui::GetStyle();
    const float row_height = ImGui::GetFrameHeight();
    const bool pressed = ImGui::Button("##gradient", {-1.f, row_height});
    const auto first = ImGui::GetItemRectMin();
    const auto last = ImGui::GetItemRectMax();
    const bool hovered = ImGui::IsItemHovered();
    const bool focused = ImGui::IsItemFocused();
    if (ImGui::IsItemVisible()) {
        auto* draw = ImGui::GetWindowDrawList();
        draw->PushClipRect(first, last, true);
        const float inset = dimensions.dpi * 2.f;
        const char* name = gradient_choices.front().label;
        for (const auto& choice : gradient_choices)
            if (choice.gradient == gradient)
                name = choice.label;
        const auto name_size = ImGui::CalcTextSize(name);
        const float padding = dimensions.unit * 2.f;
        const float arrow_width = row_height;
        const float name_right = std::min(first.x + name_size.x + padding * 2.f,
                                          last.x - arrow_width);
        gradient_swatch(draw, {name_right, first.y + inset},
                         {last.x - arrow_width, last.y - inset}, gradient);
        const ImU32 backing = ImGui::GetColorU32(
            {colour::surface.x, colour::surface.y, colour::surface.z, .92f});
        draw->AddRectFilled({first.x + inset, first.y + inset},
                             {name_right, last.y - inset}, backing);
        draw->AddRectFilled({last.x - arrow_width, first.y + inset},
                             {last.x - inset, last.y - inset}, backing);
        draw->PushClipRect({first.x + inset, first.y}, {name_right, last.y}, true);
        draw->AddText({first.x + padding, first.y + (row_height - name_size.y) * .5f},
                       ImGui::GetColorU32(colour::text), name);
        draw->PopClipRect();
        const float arrow = dimensions.unit;
        const ImVec2 centre{last.x - arrow_width * .5f, first.y + row_height * .5f};
        draw->AddTriangleFilled({centre.x - arrow, centre.y},
                                 {centre.x + arrow * .5f, centre.y - arrow},
                                 {centre.x + arrow * .5f, centre.y + arrow},
                                 ImGui::GetColorU32(colour::text));
        draw->AddRect(first, last,
                       ImGui::GetColorU32(focused ? colour::amber
                                          : hovered ? colour::muted : colour::border),
                       style.FrameRounding, 0, dimensions.dpi);
        draw->PopClipRect();
    }
    help("Choose the map colour gradient");
    if (pressed)
        ImGui::OpenPopup("##gradient_choices");

    bool changed = false;
    if (ImGui::IsPopupOpen("##gradient_choices")) {
        const auto* viewport = ImGui::GetWindowViewport();
        const float margin_x = std::min(dimensions.unit * 2.f, viewport->WorkSize.x * .05f);
        const float margin_y = std::min(dimensions.unit * 2.f, viewport->WorkSize.y * .05f);
        const float popup_width = std::min(220.f * dimensions.dpi,
                                           std::max(1.f, viewport->WorkSize.x - margin_x * 2.f));
        const float content_height = float(gradient_choices.size()) *
                                         (row_height + style.ItemSpacing.y) - style.ItemSpacing.y;
        const float popup_height = std::min(content_height + style.WindowPadding.y * 2.f,
                                            std::max(1.f, viewport->WorkSize.y - margin_y * 2.f));
        const ImVec2 minimum{viewport->WorkPos.x + margin_x, viewport->WorkPos.y + margin_y};
        const ImVec2 maximum{viewport->WorkPos.x + viewport->WorkSize.x - margin_x - popup_width,
                              viewport->WorkPos.y + viewport->WorkSize.y - margin_y - popup_height};
        const float anchor_left = std::min(first.x, ImGui::GetWindowPos().x);
        ImGui::SetNextWindowPos(
            {std::clamp(anchor_left - dimensions.unit - popup_width, minimum.x, maximum.x),
             std::clamp(first.y, minimum.y, maximum.y)});
        ImGui::SetNextWindowSize({popup_width, popup_height});
    }
    if (ImGui::BeginPopup("##gradient_choices", ImGuiWindowFlags_NoMove |
                                                  ImGuiWindowFlags_NoResize |
                                                  ImGuiWindowFlags_NoSavedSettings)) {
        const float name_width = ImGui::CalcTextSize("Spectral").x;
        for (const auto& choice : gradient_choices) {
            ImGui::PushID(static_cast<int>(choice.gradient));
            const bool selected = gradient == choice.gradient;
            if (ImGui::Selectable("##choice", selected, 0, {0.f, row_height})) {
                changed = gradient != choice.gradient;
                gradient = choice.gradient;
                ImGui::CloseCurrentPopup();
            }
            if (selected && ImGui::IsWindowAppearing())
                ImGui::SetItemDefaultFocus();
            const auto row_first = ImGui::GetItemRectMin();
            const auto row_last = ImGui::GetItemRectMax();
            if (ImGui::IsItemVisible()) {
                auto* draw = ImGui::GetWindowDrawList();
                draw->PushClipRect(row_first, row_last, true);
                const float marker = dimensions.unit;
                const float centre_y = (row_first.y + row_last.y) * .5f;
                if (selected)
                    draw->AddRectFilled({row_first.x + marker, centre_y - marker * .5f},
                                         {row_first.x + marker * 2.f, centre_y + marker * .5f},
                                         ImGui::GetColorU32(colour::green));
                const float text_x = row_first.x + marker * 4.f;
                draw->AddText({text_x, centre_y - ImGui::GetTextLineHeight() * .5f},
                               ImGui::GetColorU32(colour::text), choice.label);
                const ImVec2 swatch_first{text_x + name_width + marker * 2.f,
                                           row_first.y + dimensions.unit};
                const ImVec2 swatch_last{row_last.x - dimensions.unit,
                                          row_last.y - dimensions.unit};
                gradient_swatch(draw, swatch_first, swatch_last, choice.gradient);
                if (swatch_last.x > swatch_first.x && swatch_last.y > swatch_first.y)
                    draw->AddRect(swatch_first, swatch_last, ImGui::GetColorU32(colour::border),
                                   0.f, 0, dimensions.dpi);
                draw->PopClipRect();
            }
            ImGui::PopID();
        }
        ImGui::EndPopup();
    }
    ImGui::PopFont();
    ImGui::PopID();
    return changed;
}

InstrumentCell instrument_cell(const char* id, ImVec2 size, bool interactive, bool recording) {
    const auto first = ImGui::GetCursorScreenPos();
    bool pressed = false;
    if (recording) {
        ImGui::PushStyleColor(ImGuiCol_Button, red_surface);
        ImGui::PushStyleColor(ImGuiCol_ButtonHovered, red_hover);
        ImGui::PushStyleColor(ImGuiCol_ButtonActive, red_active);
    }
    if (interactive)
        pressed = ImGui::Button(id, size);
    else
        ImGui::Dummy(size);
    if (recording)
        ImGui::PopStyleColor(3);
    const ImVec2 last{first.x + size.x, first.y + size.y};
    auto* draw = ImGui::GetWindowDrawList();
    draw->AddLine({last.x - dimensions.dpi, first.y},
                  {last.x - dimensions.dpi, last.y}, ImGui::GetColorU32(colour::border),
                  dimensions.dpi);
    return {first, last, pressed};
}

InstrumentCell visibility_toggle(const char* label, bool& visible, ImVec2 size) {
    label = safe(label);
    ImGui::PushStyleVar(ImGuiStyleVar_FrameRounding, 0.f);
    ImGui::PushStyleVar(ImGuiStyleVar_FrameBorderSize, 0.f);
    ImGui::PushStyleVar(ImGuiStyleVar_FramePadding, ImVec2(0.f, 0.f));
    ImGui::PushStyleColor(ImGuiCol_Button, visible ? colour::raised : colour::surface);
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, colour::overlay);
    ImGui::PushStyleColor(ImGuiCol_ButtonActive, colour::raised);
    ImGui::PushStyleColor(ImGuiCol_Text, transparent);
    const bool pressed = ImGui::Button(label, size);
    const InstrumentCell cell{ImGui::GetItemRectMin(), ImGui::GetItemRectMax(), pressed};
    ImGui::PopStyleColor(4);
    ImGui::PopStyleVar(3);
    if (pressed)
        visible = !visible;
    if (!ImGui::IsItemVisible())
        return cell;

    const float width = cell.last.x - cell.first.x;
    const float height = cell.last.y - cell.first.y;
    auto* draw = ImGui::GetWindowDrawList();
    draw->PushClipRect(cell.first, cell.last, true);
    draw->AddLine({cell.last.x - dimensions.dpi, cell.first.y},
                  {cell.last.x - dimensions.dpi, cell.last.y},
                  ImGui::GetColorU32(colour::border), dimensions.dpi);

    auto* font = label_font ? label_font : ImGui::GetFont();
    const char* label_end = visible_end(label);
    float text_size = font->FontSize;
    auto extent = font->CalcTextSizeA(text_size, FLT_MAX, 0.f, label, label_end);
    const float padding = std::min(dimensions.unit, width * .1f);
    const float available = std::max(1.f, width - padding * 2.f);
    if (extent.x > available) {
        text_size *= available / extent.x;
        extent = font->CalcTextSizeA(text_size, FLT_MAX, 0.f, label, label_end);
    }
    draw->AddText(font, text_size,
                  {cell.first.x + (width - extent.x) * .5f,
                   cell.first.y + height * .36f - extent.y * .5f},
                  ImGui::GetColorU32(visible ? colour::text : colour::muted), label, label_end);

    const float lamp = std::min({dimensions.lamp_size, width * .15f, height * .18f});
    const ImVec2 lamp_first{cell.first.x + (width - lamp) * .5f,
                            cell.first.y + height * .72f - lamp * .5f};
    const ImVec2 lamp_last{lamp_first.x + lamp, lamp_first.y + lamp};
    if (visible) {
        draw->AddRectFilled(lamp_first, lamp_last, ImGui::GetColorU32(colour::green));
        draw->AddRectFilled({cell.first.x, cell.last.y - dimensions.dpi}, cell.last,
                            ImGui::GetColorU32(colour::green));
    } else {
        draw->AddRect(lamp_first, lamp_last, ImGui::GetColorU32(colour::muted), 0.f, 0,
                      dimensions.dpi);
    }
    draw->PopClipRect();
    return cell;
}

void instrument_symbol(const InstrumentCell& cell, RecordSymbol symbol, ImVec4 tone) {
    const ImVec2 centre{(cell.first.x + cell.last.x) * .5f,
                        (cell.first.y + cell.last.y) * .5f};
    const float radius = std::min({11.f * dimensions.dpi,
                                   (cell.last.x - cell.first.x) * .2f,
                                   (cell.last.y - cell.first.y) * .25f});
    auto* draw = ImGui::GetWindowDrawList();
    const auto colour = ImGui::GetColorU32(tone);
    draw->PushClipRect(cell.first, cell.last, true);
    switch (symbol) {
    case RecordSymbol::Record:
        draw->AddCircleFilled(centre, radius, colour, 32);
        break;
    case RecordSymbol::Pause:
        for (float side : {-1.f, 1.f}) {
            const float x = centre.x + side * radius * .48f;
            draw->AddRectFilled({x - radius * .2f, centre.y - radius},
                                {x + radius * .2f, centre.y + radius}, colour);
        }
        break;
    case RecordSymbol::Resume:
        draw->AddTriangleFilled({centre.x - radius * .6f, centre.y - radius},
                                {centre.x + radius, centre.y},
                                {centre.x - radius * .6f, centre.y + radius}, colour);
        break;
    case RecordSymbol::Stop:
        draw->AddRectFilled({centre.x - radius * .85f, centre.y - radius * .85f},
                            {centre.x + radius * .85f, centre.y + radius * .85f}, colour);
        break;
    case RecordSymbol::Cancel:
        draw->AddLine({centre.x - radius * .7f, centre.y - radius * .7f},
                      {centre.x + radius * .7f, centre.y + radius * .7f}, colour,
                      2.f * dimensions.dpi);
        draw->AddLine({centre.x + radius * .7f, centre.y - radius * .7f},
                      {centre.x - radius * .7f, centre.y + radius * .7f}, colour,
                      2.f * dimensions.dpi);
        break;
    }
    draw->PopClipRect();
}

void instrument_text(const InstrumentCell& cell, const char* text, ImFont* font, float size,
                     float centre_y, ImVec4 tone, bool centred) {
    text = safe(text);
    font = font ? font : ImGui::GetFont();
    const float padding = std::min(dimensions.panel_padding, (cell.last.x - cell.first.x) * .08f);
    const float available = std::max(1.f, cell.last.x - cell.first.x - padding * 2);
    auto extent = font->CalcTextSizeA(size, FLT_MAX, 0, text);
    if (extent.x > available) {
        size *= available / extent.x;
        extent = font->CalcTextSizeA(size, FLT_MAX, 0, text);
    }
    const ImVec2 at{centred ? (cell.first.x + cell.last.x - extent.x) * .5f
                           : cell.first.x + padding,
                    cell.first.y + (cell.last.y - cell.first.y) * centre_y - extent.y * .5f};
    auto* draw = ImGui::GetWindowDrawList();
    draw->PushClipRect(cell.first, cell.last, true);
    draw->AddText(font, size, at, ImGui::GetColorU32(tone), text);
    draw->PopClipRect();
}

void instrument_trace(const InstrumentCell& cell, std::span<const float> samples, float maximum) {
    auto* draw = ImGui::GetWindowDrawList();
    const float inset = std::min(dimensions.panel_padding, (cell.last.x - cell.first.x) * .08f);
    const ImVec2 first{cell.first.x + inset, cell.first.y + (cell.last.y - cell.first.y) * .55f};
    const ImVec2 last{cell.last.x - inset, cell.last.y - dimensions.unit * 2};
    if (last.x <= first.x || last.y <= first.y)
        return;
    draw->PushClipRect(cell.first, cell.last, true);
    draw->AddLine({first.x, last.y}, last, ImGui::GetColorU32(colour::border), dimensions.dpi);
    maximum = std::max(1.f, maximum);
    ImVec2 previous{};
    for (size_t i = 0; i < samples.size(); ++i) {
        const float x = last.x - float(samples.size() - 1 - i) / 59.f * (last.x - first.x);
        const float y = last.y - std::clamp(samples[i] / maximum, 0.f, 1.f) * (last.y - first.y);
        if (i)
            draw->AddLine(previous, {x, y}, ImGui::GetColorU32(colour::green), dimensions.dpi);
        previous = {x, y};
    }
    if (!samples.empty())
        draw->AddCircleFilled(previous, dimensions.dpi * 1.5f, ImGui::GetColorU32(colour::green));
    draw->PopClipRect();
}

void instrument_hold(const InstrumentCell& cell, float progress) {
    if (progress <= 0)
        return;
    auto* draw = ImGui::GetWindowDrawList();
    const float right = cell.first.x + (cell.last.x - cell.first.x) * std::clamp(progress, 0.f, 1.f);
    draw->AddRectFilled({cell.first.x, cell.last.y - dimensions.unit}, {right, cell.last.y},
                        ImGui::GetColorU32(colour::red));
}
} // namespace ceres::ui
