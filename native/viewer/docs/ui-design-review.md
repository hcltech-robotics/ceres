# UI design review

The viewer gives the 3D scene 80% of the window and places its controls in the remaining 20% on the right. Connection, View and Recording are independent accordions. This arrangement supports three frequent tasks: pair a headset, inspect the live scene and record a session for replay or export.

## Workspace contract

| Area | Behaviour |
|---|---|
| Scene | Uses its own viewport and aspect ratio, so the controls do not obscure or distort the scene. |
| Connection | Shows connection state, the pairing QR code, access code and connection actions. |
| View | Groups scene appearance, camera projection, preview, calibration and optional performance information. |
| Recording | Keeps the recording action near the task description, followed by replay, episode editing, export and storage controls. |
| Active recording | Keeps Stop or Cancel available outside the scrolling accordion content. |
| Errors | Appear above the accordions and can be dismissed after inspection. |
| Presentation state | Remembers which accordions are open and whether the controls are visible. |

The scene remains the visual focus. Neutral surfaces separate controls, an accent identifies focus and selection and recording actions have a distinct treatment with explicit text. Labels sit above full-width fields in the narrow pane. Secondary controls share a row only when both fit.

## Review priorities

| Priority | Issue | Required behaviour | Verification |
|---|---|---|---|
| High | Tab competes with keyboard navigation. | Tab traverses focused controls, while scene focus permits Tab to hide the pane. F6 focuses the controls and Escape returns focus to the scene. | Traverse accordions, fields and buttons with Tab and Shift+Tab, then return to the scene and hide or restore the pane. |
| High | A long or collapsed section can hide the active Stop or Cancel action. | Active recording controls remain outside scrolling content. | Start the count-in, fold Recording and scroll View, then cancel. Repeat while recording and stop successfully. |
| High | An error can be hidden inside an unrelated closed accordion. | Persistent errors appear outside accordion bodies. | Load an invalid calibration path while Recording is closed. |
| Medium | A fixed 20% pane can clip fields and button rows. | Fields and primary actions use the available width. Secondary rows wrap as required, button labels stay concise and the footer reserves its measured wrapped height. | Inspect 1280 by 720 and 2560 by 1440 windows with long task text and paths. |
| Medium | Font scaling can magnify a low-resolution font while leaving spacing unchanged. | Bake fonts at the current content scale, reset and scale the style once per scale change and refresh the font texture when required. | Inspect at 100%, 125%, 150% and 200% scaling and move the window between monitors. |
| Medium | Repeated QR encoding adds avoidable frame work. | Rebuild the cached QR matrix when its URL changes. | Verify a fresh pairing updates the QR code and steady rendering reuses the matrix. |
| Medium | Empty and disabled controls give little guidance. | Give recording, replay, episodes and export a concise empty or disabled explanation. | Open without a source, open a recording with no episodes and attempt export without a task. |
| Low | Conditional stack operations complicate static checking and maintenance. | Use one balanced scope around each episode editor and remove an episode after closing that scope. | Run the ImGui scope checker and remove an episode while editing the list. |

## Interaction states

| State | Feedback and next action |
|---|---|
| Disconnected | Shows Disconnected and an explicit connection action. Recording explains that a live stream is required. |
| Pairing | Shows a QR code and readable access code with a copy action. |
| Opening a source | Preserves the scene and shows that the source is opening. |
| Live | Shows connection state and enables recording. |
| No camera image | The enabled preview explains that it is waiting for a camera image. |
| Count-in | Shows the remaining count over the scene and offers Cancel, including Escape. |
| Recording | Shows elapsed time and an always-reachable Stop action. |
| Replay | Exposes playback, timeline, speed, frame stepping and episode editing. |
| No episodes | Explains how to mark a range or use the whole session. |
| Exporting | Shows progress and permits cancellation. |
| Failed operation | Shows a persistent error with the operation's cause. |

Scene mouse operations start only inside the scene while ImGui is not capturing input. A drag that starts in the controls cannot become a scene drag by crossing the boundary. Scrolling the controls cannot zoom the scene. The recording count-in remains centred over the scene when the controls are visible or hidden.

## ImGui compatibility

The application pins Dear ImGui 1.91.9b docking at revision `52fe0a05a7b1aa180a202bb24f0f2a049a9c1b7d`. The theme uses that revision's public APIs and keeps font scale ownership in the application.

The UI engineering skill's reference templates require ImGui 1.92 or newer. Its structural checks, contrast checks and 30 semantic contracts pass, as does template compilation against official v1.92.0 and master. Compilation of those unadapted templates against the viewer's pinned headers correctly rejects their `FontScaleDpi` dependency. The viewer adapts the design tokens and DPI approach to its pinned API instead of importing the newer template unchanged.

The application scope checker, native build and task-level window checks validate the product implementation. Template checks alone do not establish the viewer's behaviour.

## Review evidence

| Check | Result |
|---|---|
| Application ImGui scope checker | `src/app.cpp` and `src/renderer.cpp` pass. |
| Default text contrast | Primary text is 15.77:1 and secondary text is 8.69:1 against the pane background. |
| Interactive control contrast | Button hover is 6.62:1 and the active accordion is 6.91:1. Recording button states remain at or above 6.07:1. |
| Focus-only activation | A native headless harness built against the pinned ImGui implementation keeps all three accordions closed after the F6 focus operation and Tab, without generating a navigation activation. |
| Source formatting | `git diff --check` passes. |

The focus harness exercises ImGui's event and navigation logic without a graphics backend. Window-level checks cover the GLFW input path, actual pane geometry, scrolling and rendered text.
