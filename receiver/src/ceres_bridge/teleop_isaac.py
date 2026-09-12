"""Optional IsaacTeleop SE3 wrist retargeting through its public Python API."""

import numpy as np

from .coordinates import ros_orientation, ros_position
from .teleop_model import quaternion_matrix


class IsaacTeleopWristAdapter:
    """Convert CERES WebXR hands to IsaacTeleop's OpenXR HandInput tensors.

    CERES has 25 joints beginning at wrist. OpenXR adds palm at index zero,
    so its 25 measured joints occupy indices 1 through 25. Palm stays invalid.
    The SE3 retargeter reads the measured wrist directly with no pose offsets.
    """

    def __init__(self):
        try:
            from isaacteleop.retargeters import Se3AbsRetargeter, Se3RetargeterConfig
            from isaacteleop.retargeting_engine.interface import OptionalTensorGroup
            from isaacteleop.retargeting_engine.tensor_types import HandInput, HandInputIndex
        except ImportError as exc:
            raise RuntimeError("Install isaacteleop[retargeters-lite] to use the isaacteleop backend") from exc
        self.group_type = HandInput
        self.group_class = OptionalTensorGroup
        self.indices = HandInputIndex
        self.retargeters = {
            side: Se3AbsRetargeter(Se3RetargeterConfig(
                input_device="hand_" + side, use_wrist_position=True, use_wrist_rotation=True,
                zero_out_xy_rotation=False, target_offset_roll=0., target_offset_pitch=0., target_offset_yaw=0.),
                name="ceres_" + side)
            for side in ("left", "right")}

    def transform(self, side, pose):
        values = np.asarray(pose["values"], dtype=np.float32).reshape(25, 8)
        positions = np.zeros((26, 3), dtype=np.float32)
        orientations = np.zeros((26, 4), dtype=np.float32)
        orientations[:, 3] = 1
        radii = np.zeros(26, dtype=np.float32)
        valid = np.zeros(26, dtype=np.uint8)
        for joint in range(25):
            if pose["joint_mask"] & (1 << joint):
                positions[joint + 1] = ros_position(values[joint, :3])
                orientations[joint + 1] = ros_orientation(values[joint, 3:7])
                radii[joint + 1] = values[joint, 7]
                valid[joint + 1] = 1
        group = self.group_class(self.group_type())
        group[self.indices.JOINT_POSITIONS] = positions
        group[self.indices.JOINT_ORIENTATIONS] = orientations
        group[self.indices.JOINT_RADII] = radii
        group[self.indices.JOINT_VALID] = valid
        output = self.retargeters[side]({"hand_" + side: group})
        values = np.asarray(output["ee_pose"][0])
        result = np.eye(4)
        result[:3, 3] = values[:3]
        result[:3, :3] = quaternion_matrix(values[3:7])
        return result
