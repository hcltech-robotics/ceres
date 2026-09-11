import time

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy, HistoryPolicy
from geometry_msgs.msg import Point, Pose, PoseStamped
from sensor_msgs.msg import Image
from visualization_msgs.msg import Marker, MarkerArray
from ceres_bridge_msgs.msg import HandPose, TrackingState
from ceres_bridge import Receiver
from ceres_bridge.coordinates import HAND_BONES, ros_orientation, ros_position
from ceres_bridge.protocol import JOINTS


def pose_message(values):
    pose = Pose()
    pose.position.x, pose.position.y, pose.position.z = ros_position(values[:3])
    pose.orientation.x, pose.orientation.y, pose.orientation.z, pose.orientation.w = ros_orientation(values[3:7])
    return pose


class BridgeNode(Node):
    def __init__(self):
        super().__init__("ceres_bridge")
        self.declare_parameter("socket", "")
        self.declare_parameter("video", True)
        self.receiver = Receiver(self.get_parameter("socket").value or None, video=self.get_parameter("video").value)
        qos = QoSProfile(history=HistoryPolicy.KEEP_LAST, depth=1, reliability=ReliabilityPolicy.BEST_EFFORT,
                         durability=DurabilityPolicy.VOLATILE)
        self.head = self.create_publisher(PoseStamped, "ceres/head", qos)
        self.hands = {"2": self.create_publisher(HandPose, "ceres/left_hand", qos),
                      "3": self.create_publisher(HandPose, "ceres/right_hand", qos)}
        self.tracking = self.create_publisher(TrackingState, "ceres/tracking", qos)
        self.images = self.create_publisher(Image, "ceres/camera/image", qos)
        self.markers = self.create_publisher(MarkerArray, "ceres/scene", qos)
        self.previous = {}
        self.last_tracking = None
        self.create_timer(1 / 200, self.tick)

    def tick(self):
        snapshot = self.receiver.latest()
        frame = snapshot["frame"]
        try:
            now_us = time.monotonic_ns() // 1000
            ros_ns = self.get_clock().now().nanoseconds
            epoch, space = snapshot["epoch"], snapshot["space_epoch"] or 0
            origin = f"ceres_origin_e{epoch}_s{space}"
            clock = snapshot["clock"]
            state = TrackingState(connection_epoch=epoch, reference_space_epoch=space,
                                  clock_synchronised=clock is not None, clock_uncertainty_us=clock["uncertainty_us"] if clock else 0.0,
                                  connection_state=snapshot["connection"])
            state.header.frame_id = origin
            state.header.stamp = self.get_clock().now().to_msg()
            scene = MarkerArray()
            for kind in ("1", "2", "3"):
                component = snapshot["poses"].get(kind, {})
                pose = component.get("pose")
                tracked = bool(component.get("tracked"))
                setattr(state, {"1": "head_tracked", "2": "left_tracked", "3": "right_tracked"}[kind], tracked)
                if kind != "1":
                    setattr(state, "left_validity_mask" if kind == "2" else "right_validity_mask", pose["joint_mask"] if pose else 0)
                marker = Marker(id=int(kind), ns="ceres", action=Marker.DELETE)
                marker.header = state.header
                if tracked and clock:
                    marker.action = Marker.ADD
                    marker.pose.orientation.w = 1.0
                    marker.scale.x = 0.006
                    marker.color.r, marker.color.g, marker.color.b, marker.color.a = (0.7, 0.9, 0.4, 1.0)
                    source_ns = max(0, ros_ns + round((pose["observed_us"] * clock["rate"] + clock["offset_us"] - now_us) * 1000))
                    message = PoseStamped() if kind == "1" else HandPose()
                    message.header.frame_id = origin
                    message.header.stamp.sec, message.header.stamp.nanosec = divmod(source_ns, 1_000_000_000)
                    if kind == "1":
                        message.pose = pose_message(pose["values"])
                        marker.type = Marker.ARROW
                        marker.pose = message.pose
                        marker.scale.x, marker.scale.y, marker.scale.z = (0.1, 0.02, 0.02)
                    else:
                        message.connection_epoch, message.reference_space_epoch, message.sequence = epoch, space, pose["sequence"]
                        message.observed_us, message.predicted_display_us = pose["observed_us"], pose["target_us"]
                        message.clock_uncertainty_us, message.validity_mask = clock["uncertainty_us"], pose["joint_mask"]
                        message.joint_names = list(JOINTS)
                        message.joints = [pose_message(pose["values"][i*8:i*8+7]) for i in range(25)]
                        message.radii = [pose["values"][i*8+7] for i in range(25)]
                        marker.type = Marker.LINE_LIST
                        for left, right in HAND_BONES:
                            if pose["joint_mask"] & (1 << left) and pose["joint_mask"] & (1 << right):
                                marker.points.extend([message.joints[left].position, message.joints[right].position])
                    identity = (epoch, space, pose["sequence"])
                    if self.previous.get(kind) != identity:
                        (self.head if kind == "1" else self.hands[kind]).publish(message)
                        self.previous[kind] = identity
                scene.markers.append(marker)
            # Recentring invalidates the previous origin and every previously drawn transform.
            if self.last_tracking and self.last_tracking[:2] != (epoch, space):
                scene.markers.insert(0, Marker(action=Marker.DELETEALL))
            tracking_key = (epoch, space, state.head_tracked, state.left_tracked, state.right_tracked,
                            state.left_validity_mask, state.right_validity_mask, state.clock_synchronised, state.connection_state)
            if tracking_key != self.last_tracking:
                self.tracking.publish(state)
                self.last_tracking = tracking_key
            self.markers.publish(scene)
            if frame:
                metadata = frame.metadata
                image = Image(height=metadata["height"], width=metadata["width"], encoding="rgb8", is_bigendian=0, step=metadata["stride"])
                image.header.frame_id = f"ceres_camera_optical_e{epoch}"
                # RTP presentation time is not a measured sensor-exposure timestamp.
                image.header.stamp.sec, image.header.stamp.nanosec = divmod(max(0, ros_ns + (metadata["received_us"] - now_us) * 1000), 1_000_000_000)
                image.data = bytes(frame.data)
                self.images.publish(image)
        finally:
            if frame:
                frame.release()

    def destroy_node(self):
        self.receiver.close()
        return super().destroy_node()


def main(args=None):
    rclpy.init(args=args)
    node = BridgeNode()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()
