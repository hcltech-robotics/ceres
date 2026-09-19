# Environment depth

Ceres viewer receives the headset's WebXR environment depth and fuses it into the same
world space as hand tracking. It does not need a stereo camera pair or an image-plane
calibration to place these measurements.

## Viewing depth

Select **DEPTH** in the sidebar footer, then choose a source in the **Depth** panel:

| Source | Behaviour |
| --- | --- |
| Automatic | Uses Quest depth when available, with image stereo as the fallback |
| Quest depth | Uses only depth supplied by the headset |
| Stereo | Uses the two camera images and the active stereo calibration |

**Voxel** sets the finest spatial resolution and **Near**/**Far** bound the accepted
depth range. The defaults are 3 cm cells and a range of 0.2 to 5 metres. **Points** sets
the minimum point size. The map remains fixed in the tracking reference space while the
headset moves. **Clear map** starts a new map.

**Detail > Adaptive** keeps nearby geometry fine and groups distant cells according to
their projected size. The groups stay on the original world grid. Moving the viewer
changes the displayed detail. **Full** displays every stored cell at its retained size.
The map uses a fixed memory budget. As it fills, distant cells are merged on the world
grid and less useful cells are pruned to leave room for new observations. Nearby,
well-supported surfaces take priority. **Telemetry > Map memory** shows the allocated
map and presentation storage. Revisiting a coarsened region restores finer detail when
fresh observations cover the retained cells.

The map uses a spectral scale from warm near surfaces to cool distant surfaces.
Colour follows each point's distance from the headset's current tracked position and
updates on every rendered frame, including while depth capture is idle. Moving the
headset or changing **Near** or **Far** updates the colours. Orbiting the desktop view
does not change them. Tracking gaps retain the last accepted headset position. The scale appears below
those controls. **Opacity** sets
supported geometry's visibility. A surface loses opacity as newer measurements contradict
it, and disappears when its evidence is exhausted. Time alone does not fade the map.

**Mask hands** is enabled by default. Valid tracked joints define finger capsules and
filled palm volumes at the depth capture's time. Points inside those volumes are excluded,
including earlier hand points retained in the map. A hand between the camera and a mapped
surface protects that background surface from being erased.

Only measured free space contradicts an old surface. Invalid depth, surfaces outside the
current view and geometry hidden behind a closer object retain their earlier evidence.
Agreement reinforces an existing cell. Repeated or older observations do not refresh or
weaken the map again.

Repeatedly confirmed surfaces require consecutive, consistent free-space measurements
before confidence decreases, and stronger support slows that decrease. Inconsistent
depth readings break the contradiction sequence. Under memory pressure, further
coarsening preserves confirmed coverage before less-supported geometry is discarded.

CPU and GPU refer to the depth access mode selected by the headset browser. Both arrive
as metric measurements and use CUDA for unprojection and voxel fusion in the viewer.
Telemetry separates the depth update rate, GPU processing time and rejected packets.
The depth status identifies the active source.

## Headset capture

Bridge requests WebXR depth sensing with a view-aligned result and sends one observation
twice per second. Each frame keeps its aspect ratio within 256 by 256 samples. The selected
view's pose and projection travel with the frame, along with the original depth dimensions
and normalised coordinate transform. Camera video and tracking retain their own cadence.
GPU packing preserves the source texture's row indices. The transmitted normalised
transform is copied from WebXR exactly, including any reflection, rotation or crop supplied
by the browser. The sender does not add a second vertical reflection.

The CPU path converts the browser's depth buffer directly into millimetres. The GPU path
samples the browser-owned 2D or array texture into a small owned RGBA8 target, packs
millimetres and transfers that target into a pixel-pack buffer. It checks a GPU fence on
later XR callbacks and reads the buffer only after completion. Only one readback is in
flight, while the renderer's OpenGL state is restored after capture. Depth values and
timestamps belong to the observation that initiated the readback.

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
This sample time orders evidence updates. Hand association uses the original recorded
timeline during replay, so changing playback speed does not change the mask.

Connection and reference-space changes and seeks clear the map.
Changing the voxel size starts a new map. Switching depth sources retains their separate
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
| `norm_depth_from_norm_view` | Normalised view-to-depth coordinate transform |

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

Replay uses the same unprojection and voxel path as live input. A seek clears the old
volume and restores the most recent depth observation in the selected reference space.
Further observations rebuild the visible space as playback advances.

CERES-compatible LeRobot v3 export keeps its existing features. The pinned exporter retains
depth event headers in `meta/ceres-source-events.jsonl`, while the raw depth payload remains
in the recording. Depth measurements do not modify hand validity, state values, actions or
camera images.
