# Ceres viewer

Ceres viewer receives Ceres Bridge camera video and tracking in a native 3D scene. Articulated hands, a textured Quest 3 model, calibrated camera planes and optional stereo depth fill the left 80% of the window. A fixed Dear ImGui control pane occupies the right 20%. Reception, hardware decoding, recording and rendering run independently.

Separate release packages support Windows 11 x64, Ubuntu 22.04 or newer on x64 NVIDIA systems and Ubuntu 24.04 or newer on compatible NVIDIA ARM64 SBSA systems. Each includes the native exporter, FFmpeg and runtime libraries. Install the NVIDIA display driver, then extract the archive and launch the viewer. CUDA and OpenGL must use the same GPU. The renderer uses OpenGL 4.5, CUDA image conversion and NVDEC H.264 decoding.

Hugging Face sign-in uses your web browser. On Linux, install `xdg-utils` in the desktop session to open the authorisation window.

## Run

Launch `ceres-viewer` from its distribution directory. **Connection** shows a QR code and access code. Open Ceres Bridge on the headset and enter that code. The receiver identity is retained between launches. **Disconnect** closes the active connection and **Pair again** creates a new pairing identity.

Access codes use unambiguous capital letters and adapt to the length supported by the pairing service. If the service limits requests, **Connection** shows the time until the next attempt. The viewer retains that deadline across restarts and pairing changes. Other rejected requests stop automatic retries until you reconnect or choose **Pair again**.

**Connection**, **Hands**, **Spatial map**, **Scene**, **Task**, **Recording**, **Replay**, **Publish**, **Telemetry** and **Calibration** organise the control pane. **Scene** contains the grid, camera frusta, image controls and saved-map placement. **Recording** contains saving, episode selection and export. **Replay** opens local or Hugging Face recordings, with playback controls along the bottom of the scene. The **Publish** section is empty.

The sidebar reaches the top edge, and the recording strip ends at its left edge. Five buttons in the fixed sidebar footer control visibility: **HAND**, **HMD**, **TRL**, **RGB** and **DEPTH**. With a saved map loaded, **DEPTH** becomes **FUSE** to control acquisition and fusion into the placed map. Hiding a layer preserves its appearance settings, tracking and spatial map. The selected section, display settings, task specification, calibration and recording destination persist between launches. Hiding the control pane lets the scene fill the window while the recording toolbar and replay timeline remain accessible. Text and controls follow the display scale.

| Control | Behaviour |
| --- | --- |
| Left drag | Orbit |
| Middle drag | Pan |
| Wheel | Zoom |
| Right drag | Look around |
| Right button with W/A/S/D | Fly forwards, left, backwards or right |
| Right button with Q/E | Fly down or up |
| Shift while flying | Move faster |
| F11 | Toggle borderless fullscreen on the current monitor |
| Tab from the scene | Hide or show the control pane |
| F6 | Focus the controls for keyboard navigation |
| F7 | Focus the recording control |
| F8 | Focus the visibility buttons |
| Tab/Shift+Tab in controls | Move between controls |
| Escape | Cancel the count-in or return focus to the scene |

Four square buttons form a vertical strip at the upper-left of the scene. The first shows the orbit reference: **W** is the world origin, **M** is the centre of the displayed model, **H** is the visible hands and **C** is the headset camera. Click to cycle through available references or hold for 0.8 seconds to expand the choices. **Shift+F10** also opens the choices when the button has keyboard focus. **Top**, **Left** and **Iso** frame the selected reference from above, the left or an isometric angle. The selected view is retained when changing reference. The reference follows the displayed geometry, and panning offsets the orbit centre. Distance colouring remains relative to the headset. **Scene** also provides reset, frame-hands and headset-view commands, including the headset's orientation and roll. Scrolling or dragging over controls does not move the scene.

The current task title, description and cycle/task/repetition counters appear in the upper-right of the 3D viewing area during live capture and replay. The overlay remains visible when the sidebar is hidden.

## Live view

Hands show the newest available valid joint positions immediately, independently of camera video. Tracking indicators retain the Bridge freshness policy of 50 ms. Missing joints hold their last position for 200 ms, then fade over one second independently of the joints that remain tracked. Renewed tracking updates positions immediately and restores opacity over 80 ms. Mesh mode shows the available joints and bones when the current observations cannot support a palm. When headset tracking is lost, its last accepted position and orientation remain visible until valid tracking returns. The headset-view command also uses this retained pose. Recording and export retain the source validity flags and timestamps.

**Hands > Level** selects **Outline**, **Points**, **Bones** or **Mesh**. **Colours** selects **Side**, **Normals**, **Velocity** or **Motion flow (Middlebury)**. Side colours distinguish left and right hands, normal colours show orientation, velocity shows speed and Middlebury colours show motion in the horizontal plane.

**Trails** selects **Hand (COG)**, **Joints**, **Bones** or **Fingertips**, while **TRL** in the sidebar footer controls visibility. Hand trails follow the centre of gravity, joint trails follow all 25 joints, bone trails retain fading skeletons and fingertip trails follow the five tips. A separate **Colours** selector offers the same four colour choices. **Trail span** sets the visible history from 0.25 to 5 seconds. Paths break at tracking gaps and clear when changing source, reference space or replay position. Display settings persist between launches.

The Quest preset supplies camera intrinsics and camera-to-head placement. A version 1 JSON calibration profile can replace it with measured values. Projection distance changes the size and location of the image plane without changing calibration. See [the calibration profile](docs/calibration.md).

Use **DEPTH** in the sidebar footer to show the persistent TSDF spatial map. **Automatic** prefers Quest environment depth, with stereo images as the fallback. **Freeze map** stops acquisition while points retain their world positions and continue to show distance from the current headset. **Points** sets exact pixel size, **Spacing** controls fusion resolution and **Density** controls visible samples. **View > Shape** adds depth-aware shading with adjustable **Relief** to reveal object boundaries. **View > Points** keeps the unshaded point display. **Colour** independently selects **Distance**, **Recency**, **Confidence** or **Neutral**. Maps save automatically with an adjustable **Max size**. Samples remain unchanged while they fit the file, and weaker regions coarsen first when the file exceeds its budget, preserving finer detail in confident regions. The map folder keeps the three most recent autosaved files across both sources. **Mask hands** excludes tracked fingers and palms.

**Adaptive** detail keeps confident surfaces dense and shows weaker regions more sparsely, with further grouping only when projected cells become smaller than a pixel. **Full** at **Density** 100% shows all retained samples. Confidence grows through agreement across independent captures. **Point budget** uses the full selected file allowance, while **Retained** and **GPU memory** show the map's current size and working allocation.

New points fade in over one measured depth-update interval. Further sweeps refine existing points without restarting their fade, and retained geometry stays visible while acquisition is idle.

In **Scene > Spatial map**, enter a `.cmap` path and select **Open saved map**. Loading stops live depth capture and reconstruction while a very transparent preview shows distance from the current headset. Adjust **X**, **Y** and **Z** above **Yaw**, **Pitch** and **Roll** in the 2x3 grid, with independent **Scale X**, **Scale Y** and **Scale Z** beneath it. Select **Place** to fix the transform in the current tracking world relative to the headset at that moment. The placed map stays in position as the headset moves. **FUSE** resumes depth acquisition and merges incoming observations into that map, preserving its existing geometry. **Unload** removes the saved map and restores normal acquisition. See [environment depth and map storage](docs/environment-depth.md).

**Scene > Spatial map** provides independent visibility and opacity for recording depth and the saved map. The recording layer is available when the recording contains actual depth frames. Camera video or eligibility for stereo reconstruction does not create a recording depth layer. Recorded depth can remain visible while live depth capture is disabled.

Recordings containing both cameras retain independently decoded left/right images. **Preview** shows both images and **RGB** in the sidebar footer places both camera planes in the scene. **Calibration > Stereo** provides the Quest default and measured profiles. Stereo pairs use sender media timestamps within the selected time limit. See [stereo calibration and reconstruction](docs/stereo-calibration.md).

**Scene > Image** contains the camera preview, image distance and opacity. **Telemetry** separates rendering, camera cadence and tracking packet rate, alongside decode time, GPU scene/UI time, depth updates, pose age, clock uncertainty and recorder queue use. The [instrument design system](docs/design-system.md) defines the shared controls, typography and signal colours.

The bundled anatomical SOMA-X hands follow the 25 WebXR joints and retain their original mesh topology and skinning weights. Each hand has 2,859 vertices and 5,692 triangles, with a continuous palm, thumb webbing and articulated fingers. The Apache 2.0 licence, NVIDIA attribution and source provenance accompany the meshes. Users with authorised MANO assets can place their converted files under `assets/local/mano` to use that geometry instead. The MANO loader retains all 16 skinning influences.

The Quest rig uses the supplied USDZ mesh, base colour, normal and material maps. Its visual placement is independent of camera calibration. Asset preparation is described in [the asset guide](assets/README.md).

During replay, **Delay** selects earlier tracking, while negative values inspect later tracking. The adjustment changes the displayed hands and headset. Live hands always use the newest available tracking. Recordings, exported observations and camera frame associations retain their source timestamps.

When a live camera frame has no valid headset association, a compact **Camera** inset shows the image in the scene. Spatial projection resumes when an associated frame arrives. The inset respects **RGB** visibility and gives way to a visible **Scene > Image > Preview**. It preserves the image aspect ratio and does not change recorded timing, camera associations or hand positions.

## Recording

Choose a folder in **Recording > Destination**. Windows defaults to `D:\data\ceres-viewer\sessions`. Linux uses the `sessions` folder beneath the local data directory.

Set the description in **Task**, or paste a JSON file path or HTTP/HTTPS URL into **Specification** and select **Load**. The viewer reads `ceres-task-specification` version 1 and CERES run exports, including timed tasks, open tasks, repetitions, reset intervals and cycles. Loading runs in the background and can be cancelled. The task list shows the imported instructions and repetition counts. `--task-spec FILE.json-or-URL` loads the same format from the command line. The source and the loaded specification persist between launches.

The instrument strip spans the top edge of the scene, ending at the sidebar. It shows **LOCT** and **UTC**, the recording control, recorded time, task controls, cycle/task/repetition counters, repetition time and pose/image/render rate traces. The circle starts recording, pause bars pause it and the play triangle resumes it. Hold for 0.8 seconds to stop, shown by a square during the hold. The control is red while capturing. The hold indicator shows progress towards stopping. **F7** focuses the recording control for Space or Enter. A three-second count-in precedes recording, including when using `--record`. Press Escape or the cross to cancel the count-in. The recording file and elapsed clock begin after the count-in. The task and destination remain locked during the count-in and recording.

Timed tasks advance automatically. The toolbar also provides these controls for the active task run:

| Control | Behaviour |
| --- | --- |
| **Replay**, short press | Restart the current repetition. During a prescribed pause, return to the preceding repetition. |
| **Replay**, hold for 0.8 seconds | Restart the task from its first repetition. During a prescribed pause, return to the preceding task. |
| **Done** | Complete the current repetition and advance. |
| **Next** | Finish the current prescribed pause and advance. |
| **Pass** | Mark the current repetition as passed and advance. |
| **Fail** | Mark the current repetition as failed and advance. |

Restarts retain the captured attempts in the recording and create a new episode boundary. **Done** changes to **Next** during prescribed pauses. Pass/fail outcomes appear beside the episodes in **Recording > Episodes**.

Task repetitions create episode boundaries, and the strip labels reset and cycle pauses separately from repetition time. Counters show `--` when no task specification is loaded. The three traces retain up to 60 readings at one-second intervals, with pose cadence measured from head observations. A completed task run stops recording. Pausing freezes task progress and the elapsed recording clock, then the play control continues them. The recorder omits observations during a manual pause and resumes each video stream at a keyframe while preserving source timestamps.

A recording contains compressed video, original pose packets, stream descriptions, clock mappings, calibration, the task specification, episode markers and replay assets. The recorder writes a `.mcap.partial` file and finalises it to `.mcap` on completion. Storage failure or an exhausted recording queue stops recording and displays the error.

**Recording > Recovery > Recover** writes complete recovered data into a new indexed recording while retaining the original file.

Recorded episode markers populate **Recording > Episodes** when a session opens. Edits to task text and ranges persist beside the recording in `<recording>.mcap.episodes.json`. The sidecar contains episode selection data and identifies its source recording. The recording toolbar remains visible when the control pane is hidden.

The binary envelope, timeline and recovery rules are documented in [the session format](docs/session-format.md).

## Replay

**Replay** has two segments: **Hugging Face** and **Local file**. In **Local file**, enter an MCAP path and choose **Open recording**. In **Hugging Face**, enter a dataset repository such as `hf:chrisvoncsefalvay/ceres-demos`, then choose **Browse recordings**. The list includes MCAP recordings and CERES LeRobot datasets, including episode shards in nested folders. Use **Filter** to find a recording, select it and choose **Load into player**. Public repositories can be browsed directly, while private repositories use the same browser sign-in as uploads.

Hugging Face downloads use the selected repository commit and verify each file's size and content hash before opening it. An accompanying `.episodes.json` sidecar is downloaded from that same revision, preserving saved episode selections.

CERES LeRobot episodes load their recorded video, headset poses, hand joints, task specifications and repetition intervals into the playback timeline. The scene overlay shows the current task and description with its recorded repetition/take. **Task** shows the run description and complete recorded task timeline, including start/end times. The toolbar follows the current cycle/task/repetition and time remaining while playing or seeking. Original repetition numbers and source timestamps are retained when a dataset contains selected attempts. Downloaded datasets and their replay files are cached for subsequent loads.

The bottom playback strip provides play/pause, previous/next frame, the timeline, elapsed and total time and speeds from 0.25x to 4x. It remains visible when the control pane is hidden. Seeking starts at the preceding video keyframe and cancels earlier outstanding scrubs.

A labelled task track above the playback controls marks each recorded repetition, highlights the active interval and follows the playhead. Labels show cycle/task/repetition counters, and hovering reveals the task description, take and exact time range. Select an interval to seek to its start. The current counters also appear above the scrubber.

Dual-camera recordings retain both complete H.264 streams with independent keyframe indexes,
camera identities and timing. Replay restores both images and their stereo calibration.

## Export

**Recording > Export** exports completed recordings to CERES-compatible LeRobot v3 at 30 Hz by default. Each episode needs task text and a selected time range. Mark a range in replay or choose **Use whole session** before starting export. Connection and reference-space changes split episodes. Missing observations have false validity and zeroed geometry, while missing camera slots are black.

The `observation.images.passthrough` feature uses the declared primary camera. Its selection
is explicit and independent of which camera's frame arrives first. Both cameras remain in
the source MCAP for stereo replay.

The default acquisition profile is `ceres-bridge-lerobot3-v1`:

| Feature | Shape and meaning |
| --- | --- |
| `observation.state` | `float32[410]`, Ceres head and hand ordering |
| `observation.valid` | `bool[51]`, head and individual joint validity |
| `observation.images.passthrough` | Source-dimension video |
| `observation.video_valid` | `bool[1]`, source image present |
| `action` | `float32[2]`, left/right thumb-to-index fingertip distance in metres |
| `action.valid` | `bool[2]`, both fingertips observed for each distance |

The 410 state values retain Ceres ordering: head tracking flag, head position and XYZW quaternion (8 values), then left and right hands (201 values each). Each hand contains its tracking flag followed by 25 joints, with position[3], quaternion[4] and radius for each joint.

The action values are measured pinch distances. Missing distances are zero with false validity. `ceres.source_timestamp` is the receiver-session sampling time in seconds and `ceres.source_frame_index` identifies its sampling slot. Original sender timestamps, sequences, epochs and frame associations remain separate provenance. The exporter stages its output and publishes the dataset directory after validation.

The complete export directory is a standard LeRobot v3 dataset, with per-episode views under `shards/` for the CERES dataset viewer. The included dataset card selects the observation Parquet files for Hugging Face. The native export job also accepts `ceres-bridge-observation-v1` when an observation-only dataset is explicitly required.

To upload, open **Recording > Hugging Face export** and choose **Sign in to Hugging Face**. The viewer opens the browser and shows the code to enter on Hugging Face. Complete the authorisation there, then return to the viewer. The sign-in dialog can reopen the browser, request a new code or cancel sign-in.

Enter the organisation or username, repository and optional folder. **Create a private repository if missing** creates a private dataset repository when needed. **Include LeRobot export** adds the completed export from the selected export destination. Choose **Upload recording** to send the MCAP, its episode sidecar and the selected export, then use **View uploaded recording** to open the completed commit. Existing files with identical content are reused. Choose a different repository or folder when a destination already contains different content.

The reusable Rust exporter lives in the sibling `native/lerobot-exporter` directory and is built from the same repository revision as the viewer. The distribution includes the exporter and FFmpeg. The exporter job protocol is documented in `native/lerobot-exporter/README.md`.

If the exporter is missing, the export button is disabled and reads **Exporter not present**. The viewer checks again while running and enables export when the executable is restored and a completed recording has selected episodes.

[Export compatibility](docs/export-compatibility.md) describes the dataset contract shared by the official LeRobot reader and the CERES Hugging Face dataset viewer.

## Build

Requirements are CMake 3.25 or newer, a C++20 compiler, Rust 1.91 or newer with Cargo, Ninja, CUDA, a compatible NVIDIA driver and Git for fetching dependencies. Packaging also requires Python 3.11 or newer and an FFmpeg distribution with the `libx264` encoder. Run these commands from `native/viewer` within the CERES source tree.

Every viewer build checks the sibling Rust exporter with a locked release build and places `ceres-native-exporter` beside the viewer executable. This also applies to an explicit `ceres-viewer` target build and to each configuration in a multi-configuration generator. Cargo reuses unchanged compilation outputs under the viewer build directory's `exporter-target` folder. The `ViewerRuntime` installation component includes both executables.

On Windows, use Visual Studio 2022 Build Tools with the C++ workload and CUDA. From a developer command prompt:

```text
scripts\configure-windows.cmd
scripts\build-windows.cmd
ctest --test-dir build-native --output-on-failure
```

The configure script discovers Visual Studio 2022 and uses `CUDA_PATH` when set. `CERES_VS_INSTALL` selects a specific installation and `CERES_MSVC_TOOLSET` selects an installed compiler toolset. An existing Visual Studio developer environment is retained. The script accepts additional CMake options, including `CMAKE_CUDA_COMPILER` and `CMAKE_CUDA_ARCHITECTURES`. `BUILD_DIRECTORY` selects a build directory. Dependencies are pinned in [the CMake dependency file](cmake/Dependencies.cmake).

On Ubuntu, install a C++ compiler, CMake, Ninja, Git, Python, pkg-config, OpenGL headers, the X11/Wayland development libraries required by GLFW and CUDA. Keep the source and build directory on a local Linux filesystem:

```sh
cmake -S . -B build-native -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc
cmake --build build-native --parallel
ctest --test-dir build-native --output-on-failure
```

On Jetson Orin with JetPack 6, use the [Jetson build](docs/jetson.md). CMake selects the Jetson V4L2 decoder on Jetson Linux R36 and defaults to CUDA target `87`. `CERES_VIDEO_BACKEND=CUVID` selects the desktop decoder and `CERES_VIDEO_BACKEND=JETSON` selects the JetPack decoder explicitly.

The protocol, session, calibration, queue and exporter process tests can also run without a GPU application build or Rust toolchain:

```sh
cmake -S . -B build-core -DCERES_BUILD_APP=OFF
cmake --build build-core --config Release
ctest --test-dir build-core -C Release --output-on-failure
```

## Reproducible checks

`--fixture` supplies deterministic articulated hands. Add `--fixture-video` with an Annex B H.264 stream containing access-unit delimiters to exercise hardware decoding and image projection. `--record` records that source through the normal recorder.

```text
ceres-viewer --fixture --fixture-video camera.h264 --no-vsync --fps 120 --borderless \
  --width 2560 --height 1440 --seconds 60 \
  --metrics metrics.json --screenshot view.ppm --record session.mcap
ceres-viewer --replay session.mcap
```

Metrics use bounded histograms and report actual framebuffer dimensions, render frame count, CPU/GPU percentiles, buffer swap time, pacing time, decoded/presented frame counts, recording status and complete-frame-arrival-to-swap latency. Video cadence is independent of rendering cadence. Explicit screenshots read pixels only when requested. `--config-dir DIRECTORY` selects a separate configuration directory for an independent receiver identity, layout and preferences.

The [qualification guide](docs/qualification.md) describes the hardware gates for Windows x64, Linux x64 and Linux ARM64. The GPU test suite includes full-frame NVDEC comparisons against independent software decoding. [Packaging](docs/packaging.md) describes downloadable archives and clean-extraction verification.

## Repository boundary

The `native/viewer` directory owns the viewer, renderer, native Bridge client, MCAP implementation, tests and distribution scripts. Bridge wire compatibility is checked against the pinned fixtures under `tests/fixtures`. The sibling Rust exporter and its shared Wasm crate are included in the same CERES source release. The viewer version follows the root `package.json`.
