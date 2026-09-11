# Foxglove

Foxglove connects to the Linux receiver. The headset continues to send one video stream and one pose stream.

## Python output

In the receiver environment:

```bash
python -m pip install '.[foxglove]'
ceres-bridge foxglove
```

In Foxglove, choose **Open connection**, select **Foxglove WebSocket** and connect to `ws://localhost:8765`. Import [the Bridge layout](../foxglove/layout.json).

The command also prints an **Open in Foxglove** connection link and a layout download address. Download the layout from the receiver and select **Layouts > Import from file** in the main Foxglove application. Layouts are bundled in the Python package and served at `/layouts/layout.json`, `/layouts/vp8-layout.json` and `/layouts/ros-layout.json`.

For a viewer on another machine, pass `--host <receiver-LAN-address>` and use that address in Foxglove.

Use [the VP8 layout](../foxglove/vp8-layout.json) when receiving VP8. These are desktop layout exports. In the Layouts menu, select **Import from file**. The main view contains the outward camera, head and hand geometry, tracking indicators and live plots. Tabs below the camera expose frame rates, pose age, clock uncertainty, pinch distance, head position and all 25 joints for each hand.

| Topic | Contents |
| --- | --- |
| `/ceres/camera/video` | Original H.264 video |
| `/ceres/camera/projection` | JPEG image for the 3D projection, up to 15 FPS |
| `/ceres/camera/calibration` | CERES Player Quest 3 camera preset |
| `/ceres/scene` | Headset and articulated hand geometry, up to 30 FPS |
| `/ceres/transforms` | Origin, head, wrists and camera optical frame |
| `/ceres/head/pose` | Current head pose |
| `/ceres/left/wrist`, `/ceres/right/wrist` | Current wrist poses |
| `/ceres/left/joints`, `/ceres/right/joints` | Named joint poses, radii and tracking validity |
| `/ceres/diagnostics` | Received rates, sample ages, clock uncertainty, tracking and transport counts |

## Headset and hand meshes

Pass `--assets <directory>` to use CERES Player's Quest 3 model and MANO hand meshes. The directory contains `quest-3.glb`, `mano-left.json` and `mano-right.json`. In the CERES development repository, prepare these from the Player model and locally installed hand assets:

```bash
node scripts/prepare-bridge-viewer-assets.mjs output/bridge-viewer-assets
ceres-bridge foxglove --host <receiver-LAN-address> --assets output/bridge-viewer-assets
```

The preparation command uses Player's Three.js dependency and requires its dependencies to be installed. The mesh assets remain local and are installed separately from the receiver package. The output applies Player's model scale, orientation and hand fitting, with blue left hands and pink right hands.

The 3D camera uses Player's Quest 3 field of view and side-specific camera position and rotation. The preset is identified as `quest-3-player-preset` in diagnostics. The projected image appears 0.36 metres in front of the camera.

H.264 access units reach Foxglove after depayloading and parsing, before the shared decoder. Viewer attachment requests a fresh keyframe. A stalled encoded consumer resumes from a complete keyframe sequence. The viewer transport caps message size, queued messages and age, and disconnects a stalled viewer so it can reconnect to fresh data.

The 3D view uses a right-handed basis with X forward, Y left and Z up. It converts positions as `(-z, -x, y)` and quaternions as `(-z, -x, y, w)`. Python's receiver API retains the original WebXR axes. Tracking loss removes the corresponding geometry. Meshes remain visible for up to 250 ms between updates to avoid flicker during brief delivery gaps. Video and geometry update independently.

## ROS output

See the [Bridge Foxglove specification](../../protocol/bridge/foxglove.md) for the full topic, coordinate, mesh and projection contract.

Start the [ROS adapter](ros2.md), then start `foxglove_bridge`:

```bash
ros2 launch foxglove_bridge foxglove_bridge_launch.xml
```

Connect Foxglove to the ROS bridge and import [the ROS layout](../foxglove/ros-layout.json). It displays `/ceres/camera/image`, `/ceres/scene` and `/ceres/tracking`. The scene uses the ROS basis conversion documented in the adapter guide.
