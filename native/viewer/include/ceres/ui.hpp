#pragma once

#include <imgui.h>
#include <span>

namespace ceres::ui {

namespace colour {
inline const ImVec4 surface{.098f, .106f, .102f, 1.f};
inline const ImVec4 raised{.141f, .153f, .137f, 1.f};
inline const ImVec4 overlay{.188f, .200f, .176f, 1.f};
inline const ImVec4 border{.282f, .294f, .259f, 1.f};
inline const ImVec4 text{.894f, .886f, .847f, 1.f};
inline const ImVec4 muted{.643f, .655f, .608f, 1.f};
inline const ImVec4 amber{.867f, .737f, .470f, 1.f};
inline const ImVec4 green{.655f, .729f, .545f, 1.f};
inline const ImVec4 red{.914f, .604f, .537f, 1.f};
} // namespace colour

struct Metrics {
    float dpi = 1.f;
    float unit = 4.f;
    float panel_padding = 12.f;
    float section_gap = 12.f;
    float row_height = 28.f;
    float lamp_size = 6.f;
};

// The host owns the font atlas. Reapply only when the host's DPI changes.
void apply_style(float dpi = 1.f);
void set_fonts(ImFont* body, ImFont* mono);
const Metrics& metrics();

// Open state belongs to the caller. Repeated components need a surrounding PushID.
bool section(const char* label, const char* index, bool& open);
bool disclosure(const char* label, ImGuiTreeNodeFlags flags = 0);
void indicator(const char* label, bool active, bool warning = false);
void metric(const char* label, const char* value, const char* unit = "");
bool primary_button(const char* label, bool recording = false);
void muted(const char* text);
void help(const char* text);
void small_label(const char* label);

// Full-height instrument fields share their hit area, text clip and dividers.
struct InstrumentCell {
    ImVec2 first, last;
    bool pressed = false;
};
InstrumentCell instrument_cell(const char* id, ImVec2 size, bool interactive = false,
                               bool recording = false);
InstrumentCell visibility_toggle(const char* label, bool& visible, ImVec2 size);
enum class RecordSymbol { Record, Pause, Resume, Stop, Cancel };
void instrument_symbol(const InstrumentCell& cell, RecordSymbol symbol, ImVec4 colour);
void instrument_text(const InstrumentCell& cell, const char* text, ImFont* font, float size,
                     float centre_y, ImVec4 colour = colour::text, bool centred = true);
void instrument_trace(const InstrumentCell& cell, std::span<const float> samples, float maximum);
void instrument_hold(const InstrumentCell& cell, float progress);

} // namespace ceres::ui
