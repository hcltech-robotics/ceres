# CERES Bridge receiver

CERES Bridge sends one outward camera view, head pose and both hands from Quest 3 to a Linux receiver. Python, ROS 2 and Foxglove consume the same incoming stream. Video and poses advance independently, and each consumer reads the latest available observation.

## Install on Ubuntu 24.04

Use Python 3.12 and the system GStreamer 1.24 bindings.

```bash
sudo apt-get update
sudo apt-get install python3-venv python3-gi python3-gst-1.0 \
  gir1.2-gst-plugins-bad-1.0 gir1.2-nice-0.1 gstreamer1.0-tools \
  gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
  gstreamer1.0-nice gstreamer1.0-libav
git clone https://github.com/hcltech-robotics/ceres.git
cd ceres/receiver
python3 -m venv --system-site-packages .venv
source .venv/bin/activate
python -m pip install '.[worker]'
ceres-bridge doctor
ceres-bridge listen --name lab-receiver
```

The worker displays an eight-character code. In Quest Browser, open [CERES Bridge](https://ceres.cam/bridge/), enter the code and select **Pair receiver**, then **Start streaming**. Allow camera and hand tracking access. The headset and receiver use the same local network, while pairing uses the CERES internet service.

Add `--qr-code pairing.svg` to write a QR image. Display that image on the receiver screen and select **Scan QR** on the headset. An unused invitation expires after five minutes, and the running receiver supplies a replacement code and QR image.

Use `--bind-address <receiver-LAN-address>` to select a network interface. Use a directly reachable LAN interface for physical headsets. A receiver running behind a virtual-machine NAT needs an accessible network interface.

The receiver remembers its paired headset. Restart `ceres-bridge listen` to reconnect without another code. In the headset, **Pause** suspends video and poses while keeping the connection, and **Exit** ends the stream. **Forget receiver** revokes pairing. On Linux, stop the worker, then run `ceres-bridge listen --forget` to revoke the headset pairing.

## Read the current observations

Keep the receiver worker running in one terminal and run your application in another.

```python
from ceres_bridge import Receiver

with Receiver() as receiver:
    observation = receiver.latest()
    head = observation["poses"].get("1", {})
    if head.get("tracked"):
        print(head["pose"]["values"])

    frame = observation["frame"]
    if frame:
        with frame:
            print(frame.metadata["width"], frame.metadata["height"])
            rgb = bytes(frame.data)
```

Kinds `1`, `2` and `3` are the head, left hand and right hand. Each hand contains 25 joint transforms and a validity mask. An untracked joint has no valid transform. A pose older than 50 ms is unavailable through the default client. See [the Python API](docs/python-api.md) and [wire protocol](../protocol/bridge/README.md).

The frame is a lease on one of two slots reserved for this consumer. Release it with the context manager, and copy the bytes before retaining them. Do not retain a memory view after releasing its frame. Holding both slots drops new frames for that consumer while other consumers continue receiving.

`Receiver(video=False)` receives poses without allocating raw frame slots. Importing `ceres_bridge` does not import GStreamer, ROS or Foxglove. The worker runs as a separate process, so an application can use its own Python environment.

## Add visualisation and ROS 2

- [Foxglove](docs/foxglove.md) provides live video, head/hand geometry and tracking state.
- [ROS 2 Jazzy](docs/ros2.md) publishes typed poses, images and tracking state.
- [Acceptance and measurement](docs/acceptance.md) describes the stream measurements and stress checks.

CERES Bridge is distributed under [CC BY-NC 4.0](LICENCE.md).
