# CERES Bridge

Python receiver for CERES video, audio and poses, with ROS 2 and Foxglove adapters.

```sh
python -m pip install ".[worker]"
ceres-bridge listen --app-origin https://ceres.example.org
```

Licensed under MIT. Please cite CERES using the repository's CITATION.cff.
[Documentation](https://ceres.cam/documentation/)

The [dual-arm example](examples/dual_arm.py) maps Quest wrists to the XLeRobot arm
models with CPU inverse kinematics and an optional IsaacTeleop adapter. Foxglove
shows the robot, acquisition view, live video, wrist and joint waveforms and
process performance. Follow the [demo guide](https://ceres.cam/documentation/dual-arm-demo/)
for installation and use.
