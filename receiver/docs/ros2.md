# ROS 2 Jazzy

The ROS adapter attaches to the running Linux receiver. It uses the existing WebRTC connection and decoder.

## Build and run

Install ROS 2 Jazzy on Ubuntu 24.04, then build the two packages from the repository root:

```bash
source /opt/ros/jazzy/setup.bash
cd receiver/ros2
colcon build --packages-select ceres_bridge_msgs ceres_bridge_ros
source install/setup.bash
export PYTHONPATH="$(cd ../src && pwd):${PYTHONPATH:-}"
ros2 launch ceres_bridge_ros bridge.launch.py
```

Keep `ceres-bridge listen` running separately. The adapter preserves your `ROS_DOMAIN_ID` and discovery settings. To omit images:

```bash
ros2 run ceres_bridge_ros receiver --ros-args -p video:=false
```

## Topics

| Topic | Message |
| --- | --- |
| `/ceres/head` | `geometry_msgs/msg/PoseStamped` |
| `/ceres/left_hand` | `ceres_bridge_msgs/msg/HandPose` |
| `/ceres/right_hand` | `ceres_bridge_msgs/msg/HandPose` |
| `/ceres/tracking` | `ceres_bridge_msgs/msg/TrackingState` |
| `/ceres/camera/image` | `sensor_msgs/msg/Image` |
| `/ceres/scene` | `visualization_msgs/msg/MarkerArray` |

Pose and image publishers use best-effort, volatile, keep-last-one QoS. Hands retain the 25 WebXR joints, radii, validity mask, sequence and both epochs. Tracking messages report loss explicitly. Stale poses are not republished.

## Coordinate frames and time

The ROS origin uses body-frame axes: X forward, Y left and Z up. The basis conversion is `(x, y, z) = (-z_xr, -x_xr, y_xr)`. Orientations undergo the same basis change. Frame names include the connection and reference-space epochs so a recentered origin cannot be mistaken for the previous one.

The camera uses `ceres_camera_optical_e<epoch>`. CERES does not invent a transform between the camera and headset origin. Camera exposure calibration is separate from the pose stream.

Pose header timestamps map the sender observation through the receiver clock estimate into ROS time. Hand/tracking messages retain the clock uncertainty. Image headers report decoded arrival time. The predicted XR display timestamp remains a separate field in each hand message.

To view these topics in Foxglove, run the ROS `foxglove_bridge` package and import the [ROS layout](../foxglove/ros-layout.json).
