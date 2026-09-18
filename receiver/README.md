# CERES Bridge

Python receiver for CERES video, audio and poses, with ROS 2 and Foxglove adapters.

```sh
python -m pip install ".[worker]"
ceres-bridge listen --app-origin https://ceres.example.org
```

The `worker` extra streams Bridge video over WebRTC through GStreamer via
GObject introspection (`gi`). Install the system GStreamer/GI packages before
`pip install`, so `PyGObject` has something to build and load against:

```sh
sudo apt install libgirepository1.0-dev pkg-config libcairo2-dev \
    gir1.2-gstreamer-1.0 gir1.2-gst-plugins-base-1.0 gir1.2-gst-plugins-bad-1.0
```

`PyGObject` is pinned below 3.52 so it still builds against the older
`girepository-1.0` on systems (e.g. Ubuntu 22.04, JetPack) that don't ship
`girepository-2.0`.

Licensed under MIT. Please cite CERES using the repository's CITATION.cff.
[Documentation](https://ceres.cam/documentation/)

The [dual-arm example](examples/dual_arm.py) maps Quest wrists to the XLeRobot arm
models with CPU inverse kinematics and an optional IsaacTeleop adapter. Foxglove
shows the robot, acquisition view, live video, wrist and joint waveforms and
process performance. Follow the [demo guide](https://ceres.cam/documentation/dual-arm-demo/)
for installation and use.

In Bridge, choose **Both cameras** to stream the left and right cameras together.
Python clients can select either stream with `Receiver(camera="left")` or
`Receiver(camera="right")`. The default `Receiver()` keeps the primary camera.

```python
from ceres_bridge import Receiver

with Receiver(camera="right") as right, Receiver(camera="left") as left:
    for receiver in (right, left):
        frame = receiver.latest()["frame"]
        if frame is not None:
            with frame:
                pixels = bytes(frame.data)
                print(frame.metadata["side"], frame.metadata["width"], frame.metadata["height"])
```

Each receiver has independent bounded frame slots. Holding a lease on one side
does not block the other. Frame and encoded metadata include the camera `side`
and SDP `mid`. A side that is not streaming returns no frame. Use
`Receiver(encoded=True, camera="left")` to read left-camera H.264 access units
as well as RGB frames. Pose and optional audio belong to the shared headset session.

Run `ceres-bridge foxglove` and import
`http://127.0.0.1:8765/layouts/dual-camera-layout.json` to view both images. For VP8,
use `http://127.0.0.1:8765/layouts/dual-camera-vp8-layout.json`.

Each camera has its own `/ceres/camera/left/video` or
`/ceres/camera/right/video` topic, with matching `projection` and `calibration`
topics. The existing `/ceres/camera/video` topic and default layout show the
primary camera.
