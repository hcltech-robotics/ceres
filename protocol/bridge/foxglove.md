# Bridge Foxglove specification

CERES Bridge connects the Linux receiver to the standard Foxglove application through built-in Image, 3D, Indicator, Plot, Raw Messages and Tab panels. The [Bridge layout](../../receiver/foxglove/layout.json) places outward video beside the Quest and hand scene, with tracking indicators and live measurements in the same workspace.

## Connection and layouts

`ceres-bridge foxglove` attaches to the running receiver and exposes a Foxglove WebSocket server on `127.0.0.1:8765`. `--host` selects a LAN address for another computer. The server uses the Foxglove SDK protocol and advertises each topic with its schema. It accepts subscriptions and unsubscriptions.

The receiver prints the connection address, an **Open in Foxglove** link and a layout download address. Import the JSON through **Layouts > Import from file**. The layouts use the desktop version 1 mosaic format.

| Layout | Camera view | Use |
| --- | --- | --- |
| `layout.json` | Original H.264 stream | Default Bridge workspace |
| `vp8-layout.json` | Decoded JPEG frames | VP8 connections |
| `ros-layout.json` | ROS image topic | ROS 2 `foxglove_bridge` |

The main workspace has connection and tracking indicators across the top, outward video beside a 3D view and tabs containing received rates, pose age, clock uncertainty, pinch distances, head position, diagnostics and all joint poses and validity flags.

## Topic contract

| Topic | Schema | Contents |
| --- | --- | --- |
| `/ceres/camera/video` | `foxglove.CompressedVideo` | H.264 Annex B access units, forwarded before the shared decoder |
| `/ceres/camera/projection` | `foxglove.CompressedImage` | JPEG frames for 3D projection, up to 15 FPS |
| `/ceres/camera/calibration` | `foxglove.CameraCalibration` | Image size, intrinsic matrices and distortion parameters |
| `/ceres/scene` | `foxglove.SceneUpdate` | Headset and articulated hand geometry, up to 30 FPS |
| `/ceres/transforms` | `foxglove.FrameTransforms` | Origin, head, wrists and camera optical frame |
| `/ceres/head/pose` | `foxglove.PoseInFrame` | Fresh head position and orientation |
| `/ceres/left/wrist`, `/ceres/right/wrist` | `foxglove.PoseInFrame` | Fresh tracked wrist transforms |
| `/ceres/left/joints`, `/ceres/right/joints` | `ceres.HandJoints` | Named joint poses, radii, validity and count of valid joints |
| `/ceres/diagnostics` | `ceres.StreamDiagnostics` | Rates, tracking, ages, clock uncertainty, camera metadata and transport counts at 5 Hz |

The [JSON schemas](../../receiver/src/ceres_bridge/foxglove_schemas.py) expose fields to Foxglove plots. Joint entries preserve the [canonical order](../../shared/xr-hand-joints.ts). Untracked joints have `tracked: false`, `pose: null` and `radius_m: null`. Unavailable ages, pinch distances and uncertainty are null.

Rates count distinct received observations over one-second windows. Head, left and right rates are separate. Ages and uncertainty are milliseconds, pinch distance is metres and encoded-video bandwidth is Mbit/s. Message timestamps use receiver wall time with monotonic arrival offsets, without asserting camera exposure time.

## Frames and meshes

The fixed frame is `ceres_origin`, with X forward, Y left and Z up. Positions convert from WebXR as `(-z, -x, y)` and quaternions as `(-z, -x, y, w)`. The Python API retains WebXR coordinates. Head and wrist transforms are children of the origin. `ceres_camera_optical` is a child of `ceres_head`, with optical X right, Y down and Z forward.

With `--assets <directory>`, the scene uses CERES Player's Quest 3 model and MANO hand fitting. The directory contains `quest-3.glb`, `mano-left.json` and `mano-right.json`. The Quest model carries Player's scale and orientation. Each fitted hand has 778 vertices, with left blue and right pink. Without these local assets the scene uses a labelled head primitive and tracked joint geometry.

Entity IDs remain `head`, `left` and `right`. Updates replace entities without deleting them first. An explicit untracked observation removes its component immediately. A brief gap retains the previous visual for at most 250 ms. Disconnection removes all components. This visual lifetime does not change the receiver's 50 ms freshness contract.

## Camera projection

Projection uses `quest-3-player-preset`, an assumed camera model until calibration is supplied. For width `w` and height `h`, `fx = fy = w / 1.62`, `cx = w / 2` and `cy = h / 2`. Distortion is zero, rectification is identity and the projection matrix uses those intrinsics.

The head-to-camera position in WebXR is `(-0.064, -0.03, -0.035)` metres for the left camera and `(0.064, -0.03, -0.035)` for the right, with yaw of -6 and +6 degrees respectively. The image plane sits 0.36 metres in front of the camera at 50% opacity. Diagnostics identify the preset in `camera_projection`.

The Image panel receives original H.264. The 3D panel uses JPEG and `CameraCalibration` for projection. Video and geometry update independently.

## Viewer flow control

Up to four viewers can attach. The adapter bounds messages at 3 MiB, the SDK backlog at 16 messages and message age at 100 ms. Socket writes have a 500 ms deadline. An encoded-video gap discards dependent frames until a complete keyframe sequence arrives. New subscriptions request a keyframe, rate-limited by the worker.

The output shares the receiver's incoming media and decoder. Another viewer creates no additional headset stream, and viewer backpressure does not delay Python or ROS consumers.

## Foxglove references

- [Desktop layouts](https://docs.foxglove.dev/docs/visualization/layouts)
- [3D panel and image projection](https://docs.foxglove.dev/docs/visualization/panels/3d)
- [Standard schemas](https://docs.foxglove.dev/docs/sdk/schemas)
- [Connection links](https://docs.foxglove.dev/docs/visualization/shareable-links)
