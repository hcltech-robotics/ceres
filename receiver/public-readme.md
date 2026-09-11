# CERES

CERES captures egocentric video and tracking observations with Meta Quest. Bridge mode sends a live camera view, head pose and both hands directly to a Linux application.

## Bridge receiver

Install the [Python receiver](receiver/README.md) on Ubuntu 24.04, start `ceres-bridge listen` and select [Bridge in CERES](https://ceres.cam/bridge/) on your Quest 3. Enter the receiver code, then select **Start streaming**.

- [Python API](receiver/docs/python-api.md)
- [ROS 2 Jazzy adapter](receiver/docs/ros2.md)
- [Foxglove output and layouts](receiver/docs/foxglove.md)
- [Bridge specification](protocol/bridge/specification.md)
- [Bridge Foxglove specification](protocol/bridge/foxglove.md)
- [Wire protocol and cross-language fixtures](protocol/bridge/README.md)
- [Stream measurements](receiver/docs/acceptance.md)

This repository contains the public receiver/protocol distribution. `EXPORT-MANIFEST.json` records the source revision and file hashes for each release.

Copyright 2026 HCLTech Robotics. Distributed under [CC BY-NC 4.0](LICENCE.md).
