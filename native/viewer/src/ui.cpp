#include "ceres/ui.hpp"

#include <algorithm>
#include <cmath>
#include <cfloat>

namespace ceres::ui {
namespace {
Metrics dimensions;
ImFont* body_font = nullptr;
ImFont* mono_font = nullptr;

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

void right_aligned_text(const char* text) {
    const float width = ImGui::CalcTextSize(text).x;
    ImGui::SetCursorPosX(ImGui::GetCursorPosX() +
                         std::max(0.f, ImGui::GetContentRegionAvail().x - width));
    ImGui::TextUnformatted(text);
}
} // namespace

void apply_style(float dpi) {
    dpi = std::isfinite(dpi) ? std::clamp(dpi, .75f, 4.f) : 1.f;
    dimensions = {dpi, 4.f * dpi, 12.f * dpi, 12.f * dpi, 28.f * dpi, 6.f * dpi};
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

void set_fonts(ImFont* body, ImFont* mono) {
    body_font = body;
    mono_font = mono ? mono : body;
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
    const float font_size = ImGui::GetFontSize();
    ImGui::PushFont(mono_font);
    const auto number_size = ImGui::CalcTextSize(index);
    const float number_x = last.x - number_size.x - 10.f * dimensions.dpi;
    const float label_end = first.x + ImGui::CalcTextSize(label).x + 36.f * dimensions.dpi;
    if (*index && number_x > label_end && ImGui::IsItemVisible()) {
        auto* draw = ImGui::GetWindowDrawList();
        draw->PushClipRect(first, last, true);
        draw->AddText(ImGui::GetFont(), font_size,
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

void small_label(const char* label) {
    label = safe(label);
    ImGui::PushFont(mono_font);
    ImGui::PushStyleColor(ImGuiCol_Text, colour::muted);
    const char* end = label;
    while (*end && !(end[0] == '#' && end[1] == '#'))
        ++end;
    ImGui::TextUnformatted(label, end);
    ImGui::PopStyleColor();
    ImGui::PopFont();
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

    auto* font = mono_font ? mono_font : ImGui::GetFont();
    const char* label_end = label;
    while (*label_end && !(label_end[0] == '#' && label_end[1] == '#'))
        ++label_end;
    float text_size = std::min(font->FontSize, 13.f * dimensions.dpi);
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
