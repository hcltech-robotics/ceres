# CERES Bridge

Python receiver for CERES video, audio and poses on Linux and macOS, with
Foxglove visualisation and a ROS 2 adapter for Ubuntu.

```sh
python -m pip install ".[worker]"
ceres-bridge listen --app-origin https://ceres.example.org
```

The receiver displays a nine-letter pairing code, using capital letters without
I, L or O. Open Bridge on the headset, enter the code and select **Pair**. The
invitation lasts five minutes, and the receiver remembers the headset after pairing.

Licensed under MIT. Please cite CERES using the repository's CITATION.cff.
[Documentation](https://ceres.cam/documentation/)

## Install on macOS

Use Python 3.12 or newer on an Apple Silicon or Intel Mac. The `worker` extra
installs the [official GStreamer Python bundle](https://gstreamer.freedesktop.org/download/)
with its media plugins and Python bindings. From the repository's `receiver` directory:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install '.[worker]'
ceres-bridge doctor
ceres-bridge listen --app-origin https://ceres.example.org
```

Replace `https://ceres.example.org` with your CERES installation's HTTPS origin.
Use a Python interpreter matching the Mac's native architecture. When macOS
asks, allow Python access to the local network and incoming connections so the
Quest can reach the receiver.

## Self-signed certificates

Set `SSL_CERT_FILE` to your deployment's PEM certificate or CA bundle before
starting the receiver:

```sh
export SSL_CERT_FILE=/absolute/path/to/ceres.crt
ceres-bridge listen --app-origin https://192.168.90.194:4317
```

The [self-hosted TLS guide](../native/viewer/docs/self-hosting.md) covers certificate
generation, server configuration, browser trust and native viewer connections.

## Read the stream

The [dual-arm example](examples/dual_arm.py) maps Quest wrists to the XLeRobot arm
models with CPU inverse kinematics and an optional IsaacTeleop adapter. Foxglove
shows the robot, acquisition view, live video, wrist and joint waveforms and
process performance. Follow the [demo guide](https://ceres.cam/documentation/dual-arm-demo/)
for installation and use.

In Bridge, choose one outward camera, left or right. Optional WebXR environment
depth is independent of that selection and can stream without RGB video.
Python clients read the selected feed with `Receiver(camera="left")` or
`Receiver(camera="right")`. The default `Receiver()` keeps the primary camera.
The receiver retains its side-specific subscriptions for earlier stereo sources.

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
