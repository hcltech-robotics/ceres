"""Check advancing ROS topics and the documented WebXR basis conversion."""

import json
import time
import rclpy
from rclpy.qos import qos_profile_sensor_data
from geometry_msgs.msg import PoseStamped
from sensor_msgs.msg import Image
from ceres_bridge_msgs.msg import HandPose

rclpy.init()
node = rclpy.create_node("ceres_bridge_acceptance")
counts = {"head": 0, "left_hand": 0, "right_hand": 0, "camera/image": 0}


def receive(kind, value):
    counts[kind] += 1
    if kind == "head":
        assert (value.pose.position.x, value.pose.position.y, value.pose.position.z) == (-3, -1, 2)
    elif kind == "camera/image":
        assert (value.width, value.height, value.encoding, len(value.data)) == (640, 480, "rgb8", 640 * 480 * 3)
    else:
        assert len(value.joints) == 25 and value.validity_mask == (1 << 25) - 1


for kind, schema in (("head", PoseStamped), ("left_hand", HandPose), ("right_hand", HandPose), ("camera/image", Image)):
    node.create_subscription(schema, "/ceres/" + kind, lambda value, kind=kind: receive(kind, value), qos_profile_sensor_data)
try:
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline and min(counts.values()) < 60:
        rclpy.spin_once(node, timeout_sec=0.1)
    assert min(counts.values()) >= 60, counts
    print(json.dumps({"ros_topics": counts}), flush=True)
finally:
    node.destroy_node()
    rclpy.shutdown()
