# Environment depth

Ceres viewer receives the headset's WebXR environment depth and fuses it into the same
world space as hand tracking. It does not need a stereo camera pair or an image-plane
calibration to place these measurements.

## Viewing depth

Select **DEPTH** in the sidebar footer to show the map, then use **Spatial map**
to adjust acquisition, appearance and storage.

**Freeze map** stops both Quest depth integration and stereo reconstruction. Video,
tracking and recording continue. The stored world geometry stays visible and distance
colours follow the headset on every frame. **Resume map** accepts new observations.
**Clear map** sits beside this control and starts a new map. The full-width gauge
shows retained points against the live point limit.

**Spacing** sets the fusion resolution and **Near**/**Far** bound the accepted depth range.
The defaults are 3 cm cells and a range of 0.2 to 5 metres. Changing spacing retains existing
geometry. **Density** controls how many samples are shown, prioritising stronger
evidence without changing the stored map. **Point size** sets the exact point width in framebuffer pixels, independent of distance,
voxel size, adaptive detail and display scaling. A 1 px point occupies one pixel.

**Detail > Adaptive** keeps confident geometry dense and represents weaker regions more
sparsely. It also reduces samples whose projected cells are smaller than a pixel. The
groups stay on the original world grid. **Full** uses retained surface samples without
additional display grouping and shows every retained sample at **Density** 100%.
Display density does not change the stored geometry.

GPU storage is allocated for the live limit selected with **Max size** when a source becomes active,
and grows when a larger budget needs more capacity. Under real
memory pressure, weaker neighbouring regions merge first and confident detail remains
fine for as long as the budget permits. The point limit recalculates beside the slider
as its value changes. **Telemetry > Map memory** reports
the map and presentation allocations. Revisiting a coarsened region restores finer detail
as fresh observations confirm its surface.

**View > Shape** adds depth-aware shading to make boundaries and overlapping surfaces
easier to see. **Relief** controls its strength. The shading uses the measured depth of
nearby visible samples, ignores gaps and preserves the selected point size. **Points**
shows the same geometry with its unshaded palette.

**Colour > Distance** defaults to a spectral scale from warm near surfaces to cool distant surfaces.
Colour follows each point's distance from the headset's current tracked position and
updates on every rendered frame, including while depth capture is idle. Moving the
headset or changing **Near** or **Far** updates the colours. Orbiting the desktop view
does not change them. Tracking gaps retain the last accepted headset position. The scale appears below
the paired **Near**/**Far** controls. Select it to open the palette list to the left,
with Spectral, Viridis, Plasma, Inferno and Greys. The choice persists between runs.
**Recency** shades observation age using **Age span**, while **Confidence**
shows retained surface support. **Neutral** uses a single pale material for inspecting
geometry with Shape shading. Geometry, observation timestamps and evidence are stored
independently of these display palettes. **Opacity** sets
supported geometry's visibility. A surface loses opacity as newer measurements contradict
it, and disappears when its evidence is exhausted. Time alone does not fade the map.

New points fade in over one measured interval between independent depth updates.
Further observations refine existing points without restarting their fade. Loaded maps
appear immediately, and retained geometry stays visible while acquisition is idle.

**Mask hands** is enabled by default. Valid tracked joints define finger capsules and
filled palm volumes at the depth capture's time. Points inside those volumes are excluded,
including earlier hand points retained in the map. A hand between the camera and a mapped
surface protects that background surface from being erased.

Only measured free space contradicts an old surface. Invalid depth, surfaces outside the
current view and geometry hidden behind a closer object retain their earlier evidence.
Agreement reinforces an existing cell. Repeated or older observations do not refresh or
weaken the map again. Support counts independent capture times, so several depth pixels
from one capture cannot make a surface appear repeatedly confirmed. Confidence grows
when later measurements agree with the retained surface and falls when they contradict it.

Repeatedly confirmed surfaces require consecutive, consistent free-space measurements
before confidence decreases, and stronger support slows that decrease. Inconsistent
depth readings break the contradiction sequence. Under memory pressure, neighbouring
regions with weaker confidence coarsen first, preserving finer detail in reliable regions
and retaining coverage of the rest of the map.

CPU and GPU refer to the depth access mode selected by the headset browser. Both arrive
as metric measurements and use CUDA for unprojection and TSDF fusion in the viewer.
Telemetry separates readback, callback-to-arrival age, receiver queueing, CUDA processing
and submission-to-completion time. The pose source identifies sensor geometry, a depth
view or a display-view fallback. Camera pose is captured with the depth frame and is
never replaced by the headset pose at packet arrival.

## Fusion and saved maps

Depth observations update a sparse truncated signed distance field on the GPU. Each
observed voxel combines signed metric distance and evidence weight within a narrow band
around the measured surface. Zero crossings produce world-space surface samples for the
persistent map. The bounded TSDF working layer and persistent surface cache are separate,
so reclaiming working voxels does not erase previously reconstructed regions.

The storage worker saves complete surface snapshots every two seconds and at shutdown.
**Save map now** requests a fresh snapshot. The default folder is `maps` within the viewer's
data directory. The folder field accepts another location when Enter is pressed. Each
tracking world has separate Quest and stereo `.cmap` files. **Clear map** starts a new map.
The folder keeps the three most recent autosaved files, counting
Quest and stereo together. Older autosaves are removed after a new file has been saved
successfully. Other map filenames are left untouched.

**Max size** ranges from 1 to 256 MiB per completed map file, with a default of 16 MiB.
**Point budget** uses the full selected file allowance after its 256-byte header, with one
48-byte record per retained sample. The default allows 349520 samples and 256 MiB allows
5592400. Each active source allocates GPU working storage for its selected budget, shown
separately from the completed file size.
Saved snapshots keep every retained sample while they fit the file budget. When a snapshot
exceeds that budget, the least confident neighbouring groups merge first. Confident regions
keep their fine samples while weaker regions retain coarser representatives, each with its
own cell width on the same world grid used during fusion and loading. Positions and measured colour use confidence-weighted support, observation
times retain the latest capture and merged support retains the strongest independent count
instead of adding neighbouring counts. Saving and loading preserve these mixed cell sizes.
Atomic replacement temporarily keeps one pending
file beside the completed file. A valid pending save is recoverable after interruption.
The file contains a versioned header, explicitly encoded point records and checksums.

In **Scene > Spatial map**, enter a `.cmap` path and select **Open saved map**. Loading
disables live depth capture and reconstruction. The map appears as a very transparent
placement preview, coloured by distance from the current headset. Maps larger than the
live sample budget are spatially coarsened during loading without rewriting the selected file.

The placement adjuster has two rows and three columns: **X**, **Y** and **Z** for translation
in metres, then **Yaw**, **Pitch** and **Roll** in degrees. **Scale X**, **Scale Y** and
**Scale Z** set each axis independently beneath those rows. Adjustments position the
preview relative to the headset. Select **Place** to capture the headset transform and
anchor the map in the current tracking world. Headset movement then updates distance
colours while the map keeps its placed position, orientation and scale.

While a saved map is loaded, the footer's **DEPTH** button becomes **FUSE**. After placement,
enable **FUSE** to resume depth acquisition and merge incoming observations into the loaded
map. Fusion retains the existing geometry and updates it with new observations. Disable **FUSE** to stop acquisition
and retain the resulting map. **Unload** removes the saved map and restores normal acquisition.

Recording depth and the saved map have separate visibility and opacity controls in
**Scene > Spatial map**. Hiding a layer preserves its geometry and leaves the other layer's
appearance unchanged. A recording depth layer is available only when the recording contains
actual depth frames. Video tracks and stereo reconstruction settings do not determine its
availability. Recorded depth can render independently while live capture is disabled.
The source MCAP recording remains independent of map display, sampling and storage settings.

The command-line equivalents are `--map-directory DIRECTORY`, `--load-map FILE.cmap`
and `--freeze-map-after SECONDS`.

## Headset capture

Bridge requests WebXR depth sensing with a view-aligned result and sends one observation
twice per second. Each frame keeps its aspect ratio within 256 by 256 samples. The depth
sensor's pose and projection travel with the frame when the browser exposes them.
Otherwise, Bridge uses the associated view geometry and identifies that fallback in the
depth diagnostics. The original depth dimensions and normalised coordinate transform
travel with the frame. Camera video and tracking retain their own cadence.
GPU packing preserves the source texture's row indices. Quest perspective GPU depth uses
OpenGL row coordinates, while CPU depth uses top-left image coordinates. For perspective
GPU depth, the sender composes a vertical row conversion with the complete WebXR
normalised transform. Crop, rotation, reflection and projective terms remain part of that
composition. Linear GPU and CPU results retain the API transform. The native receiver
applies the transmitted mapping once, including during replay.

The CPU path converts the browser's depth buffer directly into millimetres. The GPU path
samples the browser-owned 2D or array texture into a small owned RGBA8 target, packs
millimetres and transfers that target into a pixel-pack buffer. It checks a GPU fence on
later XR callbacks and reads the buffer only after completion. Only one readback is in
flight, while the renderer's OpenGL state is restored after capture. Depth values, pose,
projection and timestamps belong to the observation that initiated the readback. The
measured readback duration is added after completion, without changing that observation's
timestamps or geometry.

The browser selects the supported access mode and source format. The application uses the
corresponding CPU or WebGL depth interface described in the
[WebXR depth-sensing specification](https://immersive-web.github.io/depth-sensing/).

## Spatial alignment and timing

Each observation carries its view pose, projection and the transform from normalised view
coordinates to depth-buffer coordinates. CUDA maps depth-pixel centres back through these
transforms, applies their axial distance and places the result in WebXR world coordinates.
The headset's reference space is also used for the hands, so a separately estimated
passthrough camera-to-head transform is not involved in this path.

Depth is measured along the view's forward axis. Pixel rows increase downwards, world Y
points upwards and the view looks along negative Z. The interpretation follows the
[WebXR depth-sensing specification](https://immersive-web.github.io/depth-sensing/#interpreting-the-results).

Original sender observation and target timestamps are retained. The receiver maps the
target timestamp through its clock model when available, otherwise it uses arrival time.
This sample time orders evidence updates. It does not move geometry: the embedded view
transform determines every point's world position. The WebXR callback and predicted
target times are not presented as the sensor's physical exposure timestamp.
Hand association uses the original recorded
timeline during replay, so changing playback speed does not change the mask.

During normal acquisition, connection and reference-space changes and seeks start a new map.
Frozen maps and the loaded saved-map layer survive these transitions. Changing spacing preserves existing geometry.
Switching depth sources retains their separate
maps, and recording pause/resume markers preserve the current world. Hiding depth or an interval without depth
observations preserves the map. Zero samples are invalid and never become geometry or
evidence of empty space.

## Bridge transport

The `ceres-depth-v1` data channel carries sparse, independently decodable observations.
The stream description declares:

```json
{
  "environment_depth": {
    "version": 1,
    "channel": "ceres-depth-v1",
    "format": "uint16-mm",
    "max_width": 256,
    "max_height": 256
  }
}
```

A depth source may omit camera tracks. Existing Bridge axes, units, quaternion order,
joint order and clock fields retain their meaning.

A complete depth packet begins with ASCII `CED1`, a little-endian uint32 JSON-header
length and the UTF-8 JSON header. The remaining bytes contain row-major, little-endian
uint16 millimetres. The header is bounded to 4096 bytes and each frame to 256 by 256
samples. `0` denotes invalid depth.

| Header fields | Meaning |
| --- | --- |
| `version` | `1` |
| `epoch`, `space_epoch`, `sequence` | Connection, reference-space and frame identity |
| `observed_us`, `target_us` | Original sender monotonic timestamps in microseconds |
| `width`, `height` | Transmitted depth dimensions |
| `source_width`, `source_height` | Original browser depth dimensions |
| `eye` | `left`, `right` or `none` |
| `usage` | `cpu-optimized` or `gpu-optimized` |
| `source_format` | Browser depth representation |
| `depth_format` | `uint16-mm` |
| `world_from_view` | View pose in the tracking reference space |
| `projection` | View projection matrix |
| `norm_depth_from_norm_view` | Normalised view-to-packed-depth coordinate transform |
| `geometry_source` | Optional `sensor`, `view` or `view-fallback` pose provenance |
| `mapping_version` | Optional `2`, identifying the row-normalised sender |
| `readback_us` | Optional measured capture/readback duration in microseconds |
| `target_lead_us` | Optional signed `target_us - observed_us` |

Receivers advertise `depth_metadata_version: 2` in the description acknowledgement.
The sender includes optional header diagnostics only after that acknowledgement, keeping
the original 17-field envelope for earlier viewers. Depth status also carries the
diagnostics. Old recordings retain their stored matrices and are never reinterpreted
based on the current sender's row convention.

Matrices contain 16 column-major numbers. The source representation is
`luminance-alpha`, `float32` or `unsigned-short`. Its metric conversion is already
applied before transmission.

`CDF1` fragments keep individual data-channel messages within 16 KiB. Their 24-byte
header carries the connection epoch, reference-space epoch, sequence, fragment index,
fragment count and complete-frame byte length. The receiver accepts reordered fragments,
holds at most two incomplete frames and expires an assembly after 300 ms from its first
arrival. Duplicate fragments do not extend that deadline. It rejects conflicting
duplicates, stale sequences and fragments from another reference space.

## Recording, replay and export

MCAP stores the complete original `CED1` packet as a `depth` event on
`/ceres/depth/environment_depth`. Its attributes retain the packet metadata plus receiver
clock validity, uncertainty, rate, offset and mapped timestamps. The ordinary CSE1 envelope
preserves original and session-relative arrival/sample times.

Replay uses the same unprojection and TSDF path as live input. With acquisition active,
a seek saves the previous surface cache, starts a new volume and restores the most recent
depth observation in the selected reference space.
Further observations rebuild the visible space as playback advances.
The recording depth layer remains independent of saved-map placement and live capture
demand, with its own visibility and opacity in **Scene > Spatial map**.

CERES-compatible LeRobot v3 export keeps its existing features. The pinned exporter retains
depth event headers in `meta/ceres-source-events.jsonl`, while the raw depth payload remains
in the recording. Depth measurements do not modify hand validity, state values, actions or
camera images.

## Volumetric reconstruction

The optional [Quest Mapper](../tools/quest-mapper.md) reconstructs a complete cuRobo TSDF
from recorded sensor depth or a stream of CED1 packets. It writes a surface mesh, shaded
and normal previews and resumable volume checkpoints. Each frame retains its acquisition
pose, and the helper converts WebXR coordinates at the Mapper boundary.

The helper runs in a separate Python process with its own memory and block limits.
It retains the three most recent complete checkpoints and verifies the rendered surface
after loading the saved volume. The native viewer's CUDA map remains independent.
