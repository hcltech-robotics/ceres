# Instrument design system

Ceres viewer uses a quiet instrument panel beside a dominant spatial display. Its visual language follows aircraft and early spacecraft controls: ordered markings, precise values, restrained signals and an obvious recording control.

## Workspace

The instrument strip is anchored to the top edge above the scene and is 66 pixels high at standard display scale. It ends where the right sidebar begins, at 80% of the window width. The sidebar reaches the top edge, with its Ceres/Bridge title and tracking lamps in a header of the same height. Ten exclusive sections follow: Connection, Hands, Spatial map, Scene, Task, Recording, Replay, Publish, Telemetry and Calibration. Opening a section closes the previous one, and the active section can also be closed. The selection persists between runs. Section numbers provide orientation. Tab hides the sidebar when the scene has focus and expands the scene and instrument strip to the full width.

All ten headers remain visible and span the pane edge to edge. Expanded content uses its natural height until it reaches the available space, then scrolls with the wheel, touchpad or keyboard without a visible scrollbar. Tracking signals and recording controls remain outside the scrolling content. Section contents retain twelve-pixel horizontal padding. Secondary disclosures have a quieter treatment. F6 focuses the inspector, F7 focuses recording and F8 focuses the layer controls. Tab and Shift+Tab traverse controls, while Escape returns focus to the scene.

Sections collapse over 120 milliseconds and expand over 160 milliseconds with cubic easing. Switching sections closes the current body before revealing the requested one. Reversing a transition continues from its current height, and rapid selection changes open only the last requested section. Headers remain interactive throughout the transition. Each section retains its scroll position.

Telemetry groups render, video and tracking rates with GPU and decoder timings, latency, pose age, clock uncertainty and recording throughput. The fixed sidebar footer contains five equal visibility buttons: HAND, HMD, TRL, RGB and DEPTH. A filled lamp and bottom rule mark an enabled layer, while an outlined lamp marks a hidden layer. F8 focuses the first button. Hand geometry and trail representation persist when hidden. RGB controls the camera image, its frustum and its preview together. Calibration contains the Quest camera preset, image corrections and stereo profiles, including the default Quest 3 stereo preset.

Pairing, framing the scene and recording are the principal tasks. Advanced calibration, file paths and detailed measurements sit behind disclosure controls. Camera and tracking states remain distinct. Every signal describes actual application state.

Hands contains Level and Colours selectors, followed by trail representation, trail colour, span and inspection delay. Hand and trail colouring are independent. Tracking gaps interrupt paths and source or replay changes clear them. Spatial map groups acquisition, appearance and storage controls. Acquisition pairs Freeze/Resume with Clear and shows retained points against the live limit on a full-width gauge. Appearance contains the map view, colour settings and a paired Near/Far row. Selecting the gradient opens a named palette list to the left. Storage places the recalculating live limit beside Max size and labels the map folder. Saved maps open under Scene, alongside placement and fusion controls. Scene contains framing, grid, image projection and preview controls. Appearance settings remain editable while their layer is hidden.

Task contains the task description and CERES specification import. Recording begins with the destination folder. The top strip orders local and universal clocks labelled LOCT and UTC, recording control, the large recorded-time reading, cycle/task/repetition progress, repetition time and three cadence traces. Every field meets the top and bottom edges and is separated by a single divider. Clock and counter text uses fixed-width numerals. Recorded time has the strongest type hierarchy. The strip remains visible while the side pane is hidden.

The recording control uses a circle to start, pause bars while capturing and a play triangle when paused. It is red while capturing. A short press starts, pauses or resumes recording. Holding the same control for 0.8 seconds stops recording, with a stop square and a progress indicator along its bottom edge. The count-in uses a cross for cancellation. Releasing outside the control or pressing Escape cancels the gesture. F7 focuses the recording control for keyboard use. OPEN is the full-height advance control during an active open repetition. Timed repetitions advance automatically. Reset and cycle pauses have explicit labels. No specification displays `--` instead of invented cycle/task/repetition counts.

Pose, image and render traces use actual one-second rate samples, retain the latest 60 readings and show zero when a stream stops. Pose cadence counts head observations once per update, independent of hand packets. The trace scale includes zero and expands in 30 fps increments. A source change starts a new history. The scene viewport and navigation region exclude the strip.

The Depth layer accumulates a persistent map in the tracking world. Adaptive detail preserves confident surfaces and groups weaker observations. Memory pressure merges uncertain regions before reliable detail. Spectral is the default colour gradient, with Viridis, Plasma, Inferno and Greys available from the gradient strip. Opacity reflects confidence and new observations fade in over one acquisition interval. Video and rendering retain their own cadence.

An input gap leaves the map intact. A newer valid depth measurement weakens surfaces in measured empty space, while geometry outside the view or behind an occluder remains supported by its earlier observations. Hand volumes are excluded using tracking associated with the capture time, and their shadows protect background surfaces. Hiding depth retains the map and continues processing observations at the configured cadence. Hand masking remains active when hand geometry is hidden. Seeking, epoch changes, a changed voxel size and source or calibration changes clear the affected map. Recording and export retain the source streams and their existing formats.

## Tokens

The shared implementation is `include/ceres/ui.hpp` and `src/ui.cpp`. Measurements use a four-pixel unit at 96 DPI, twelve-pixel panel padding, one-pixel rules and one-pixel control corners. Full-width primary actions have a 36-pixel minimum height. The host owns font sizing and applies style scaling once when DPI changes.

| Token | Use |
|---|---|
| Surface | Graphite panel and inset fields |
| Raised | Section headers and secondary buttons |
| Overlay | Hovered controls |
| Border | Dividers and control outlines |
| Text | Warm off-white labels and values |
| Muted | Supporting labels and units |
| Green | Available signals and enabled settings |
| Amber | Armed recording, active adjustment and keyboard focus |
| Red | Recording and errors |

Typography has named roles in `ui::typography`. Inspector labels, controls, supporting text and subsection headings share Roboto Medium at 16 pixels. Colour, rules and spacing establish the inspector hierarchy without changing the font family or size. The application title and compact instrument captions use the same sans serif family. Cousine Regular is reserved for aligned numerical readings, access codes and section indices. Labels use sentence case and physical units remain next to their values. Text is concise, with additional explanation in tooltips.

| Role | Size at 96 DPI | Use |
|---|---|---|
| Body | 16 px | Inspector controls, field labels, supporting text and subsection headings |
| Mono | 16 px | Aligned numerical values and section indices |
| Title | 20 px | Application title |
| Instrument label | 12 px | Compact labels in the fixed instrument strip and layer controls |
| Compact readout | 18 px | Instrument readings where width is constrained |
| Readout | 24 px | Access codes and prominent numerical readings |
| Timer | 32 px | Recorded time |
| Count-in | 60 px | Recording count-in |

These sizes are unscaled font-atlas inputs. The host multiplies them by the current monitor scale, rebuilds the atlas when that scale changes and resets the style before applying the same scale to its measurements.

## Components

Sections use Dear ImGui's collapsing header, including its full-row hit area, keyboard and focus behaviour. A subtle index shares the header row and disappears before it could overlap the label. The application owns one active section. Older preferences with multiple sections open select the first section in display order.

The pairing code sits beside the QR image when both fit. Inspector selectors and sliders share a 96-pixel label gutter and a full-width control column. The entire field stacks when fewer than 152 pixels remain for its control or when its label outgrows the gutter. Label and control baselines align in the two-column layout. Stacked labels wrap at the available width, while long text and path inputs retain the full pane width below a persistent label.

Field labels use muted body text. Subsection headings use primary body text, a divider and consistent group spacing, with no leading group gap at the start of a section. Supporting status text uses the same body size at muted contrast. Acquisition totals and storage details consequently remain subordinate to their group headings and controls. Repeated labels retain their hidden identity suffixes without displaying them.

The shared field component uses Dear ImGui tables and leaves keyboard navigation to the underlying widgets. A successful field begin owns its table, ID and body font until the matching end. A field that cannot begin closes its scopes immediately. Related controls use tight spacing, while subsection rules separate task groups.

Status indicators pair a small square lamp with a state label. Filled lamps indicate an available or pending state, while an outlined lamp indicates inactivity. The label carries the meaning independently of colour.

Metrics use three aligned columns for label, value and unit. Missing values display `--`. Table clipping contains long values and a tooltip exposes their full text. Metrics are read-only.

The primary recording action spans the pane. An amber outline identifies arming and a red treatment identifies an active recording. The underlying Dear ImGui button retains normal disabled, hover, held and keyboard activation behaviour. Secondary actions use neutral surfaces.

## States and interaction

| State | Treatment |
|---|---|
| Idle | Neutral surfaces, outlined lamps and a concise state label |
| Connected | Green lamp and connection state |
| Pending | Amber lamp with the current operation or count-in |
| Recording | Red primary control and explicit stop action |
| Complete | Completed state with the output available |
| Error | Persistent concise error, with its recovery action nearby |
| Disabled | Reduced emphasis, unavailable interaction and a reason on hover |
| Hover | Raised surface |
| Held | Inset surface |
| Keyboard focus | Amber navigation outline |

Components use built-in interactive widgets. Decorative index text and status lamps share the window's clipping region. Repeated components use stable labels within the caller's ID scope. Model data stays in the application, while the component layer retains only fonts and scaled metrics.

The implementation targets the pinned Dear ImGui 1.91.9b docking build. Font scaling remains host-owned because this version predates `FontScaleDpi`. Normal text and supporting labels maintain at least 4.5:1 contrast against their assigned surfaces. Colour never substitutes for a state label.

| Text pairing | Contrast |
|---|---|
| Body on the brightest neutral surface | 9.87:1 |
| Muted on the brightest neutral surface | 5.24:1 |
| Body on the brightest amber button state | 6.57:1 |
| Body on the brightest red button state | 7.08:1 |
