"""Latest-sample, CPU retargeting of two tracked wrists to XLeRobot arms."""

import math
import time

import numpy as np

from .coordinates import ros_orientation, ros_position
from .protocol import newer_sequence
from .teleop_model import (ArmModel, HAND_FROM_TOOL, HOME, LOWER, UPPER, pose_dict, quaternion_matrix,
                           robot_urdf, rotation_vector)


def wrist_transform(pose):
    values = pose.get("values", ())
    if not pose.get("joint_mask", 0) & 1 or len(values) < 8:
        return None
    wrist = np.asarray(values[:7], dtype=float)
    if not np.all(np.isfinite(wrist)):
        return None
    try:
        result = np.eye(4)
        result[:3, 3] = ros_position(wrist[:3])
        result[:3, :3] = quaternion_matrix(ros_orientation(wrist[3:7]))
        return result
    except ValueError:
        return None


def gripper_position(pose, previous):
    mask = pose.get("joint_mask", 0)
    if mask & (1 << 4) and mask & (1 << 9) and len(pose["values"]) >= 80:
        values = pose["values"]
        thumb = np.asarray(values[32:35], dtype=float)
        index = np.asarray(values[72:75], dtype=float)
        distance = np.linalg.norm(thumb - index)
        if np.isfinite(distance):
            return float(np.clip((distance - .018) / (.070 - .018), 0, 1) * UPPER[5])
    return previous


class _ArmState:
    def __init__(self, side):
        self.model = ArmModel(side)
        self.q = HOME.copy()
        self.target = self.model.forward(self.q)
        self.neutral_target = self.target.copy()
        self.gripper_target = HOME[5]
        self.sequence = None
        self.last_ns = None
        self.last_tracked_ns = None
        self.status = "neutral"
        self.tracked = False
        self.solve_ms = 0.0

    def reset(self):
        self.target = self.neutral_target.copy()
        self.gripper_target = HOME[5]
        self.sequence = self.last_ns = None
        self.last_tracked_ns = None
        self.status = "neutral" if np.allclose(self.q, HOME, atol=1e-10, rtol=0) else "returning"
        self.tracked = False

    def summary(self):
        current = self.model.forward(self.q)
        return {"status": self.status, "tracked": self.tracked,
                "joint_names": self.model.joint_names, "joint_positions": self.q.tolist(),
                "target": pose_dict(self.target), "current": pose_dict(current),
                "position_error_m": float(np.linalg.norm(self.target[:3, 3] - current[:3, 3])),
                "rotation_error_rad": float(np.linalg.norm(rotation_vector(self.target[:3, :3] @ current[:3, :3].T))),
                "solve_ms": self.solve_ms}


class DualArmTeleop:
    """Retarget Receiver.latest() snapshots without a simulator or renderer.

    Absolute wrist poses map through one fixed transform into the robot base.
    Each new source sequence replaces the absolute goal. The servo continues
    towards that goal during brief tracking gaps and returns to neutral after
    the grace period. Joint angles remain inside the URDF limits and change by
    at most the configured radians per second, with each step capped at 50 ms.
    """

    def __init__(self, *, position_scale=.6, max_joint_speed=2.0, backend="cpu", robot_from_ceres=None,
                 tracking_grace=.5):
        if not math.isfinite(position_scale) or not 0 < position_scale <= 2:
            raise ValueError("position_scale must be between 0 and 2")
        if not math.isfinite(max_joint_speed) or not 0 < max_joint_speed <= 10:
            raise ValueError("max_joint_speed must be between 0 and 10 radians per second")
        if backend not in ("cpu", "isaacteleop"):
            raise ValueError("backend must be cpu or isaacteleop")
        if not math.isfinite(tracking_grace) or not 0 <= tracking_grace <= 10:
            raise ValueError("tracking_grace must be between 0 and 10 seconds")
        self.tracking_grace_ns = int(tracking_grace * 1e9)
        mapping = np.eye(4) if robot_from_ceres is None else np.array(robot_from_ceres, dtype=float, copy=True)
        if (mapping.shape != (4, 4) or not np.all(np.isfinite(mapping))
                or not np.allclose(mapping[3], (0, 0, 0, 1), atol=1e-8, rtol=0)
                or not np.allclose(mapping[:3, :3].T @ mapping[:3, :3], np.eye(3), atol=1e-8, rtol=0)
                or not np.isclose(np.linalg.det(mapping[:3, :3]), 1, atol=1e-8, rtol=0)):
            raise ValueError("robot_from_ceres must be a finite 4x4 rigid transform")
        mapping.setflags(write=False)
        self.robot_from_ceres = mapping
        self.position_scale, self.max_joint_speed = position_scale, max_joint_speed
        self.backend = backend
        self.arms = {side: _ArmState(side) for side in ("left", "right")}
        self._epoch = None
        self._adapter = None
        if backend == "isaacteleop":
            from .teleop_isaac import IsaacTeleopWristAdapter
            self._adapter = IsaacTeleopWristAdapter()

    @property
    def urdf(self):
        return robot_urdf()

    def reset(self):
        """Begin a neutral return and clear sample history, retaining the fixed mapping."""
        for arm in self.arms.values():
            arm.reset()

    def link_transforms(self):
        """Return link-name to pose dictionaries, all in ceres_robot_base."""
        return {name: pose_dict(matrix) for arm in self.arms.values()
                for name, matrix in arm.model.links(arm.q).items()}

    def update(self, snapshot, now_ns=None):
        now_ns = time.monotonic_ns() if now_ns is None else now_ns
        epoch = (snapshot.get("epoch"), snapshot.get("space_epoch"))
        if epoch != self._epoch:
            self.reset()
            self._epoch = epoch
        updated = False
        for side, arm in self.arms.items():
            arm.solve_ms = 0.0
            if arm.last_ns is not None and now_ns < arm.last_ns:
                arm.reset()
            elapsed = None if arm.last_ns is None else (now_ns - arm.last_ns) / 1e9
            dt = 1 / 60 if elapsed is None or elapsed > .1 else min(.05, elapsed)
            arm.last_ns = now_ns
            component = snapshot.get("poses", {}).get("2" if side == "left" else "3", {})
            pose = component.get("pose")
            usable = (snapshot.get("connection", "connected") == "connected"
                      and component.get("fresh", False) and component.get("tracked", False) and pose)
            wrist = wrist_transform(pose) if usable else None
            sequence = pose.get("sequence") if wrist is not None else None
            if sequence is not None and (arm.sequence is None or newer_sequence(sequence, arm.sequence)):
                if self._adapter is not None:
                    wrist = self._adapter.transform(side, pose)
                wrist[:3, 3] *= self.position_scale
                arm.target = self.robot_from_ceres @ wrist
                arm.target[:3, :3] = arm.target[:3, :3] @ HAND_FROM_TOOL
                arm.gripper_target = gripper_position(pose, arm.gripper_target)
                arm.sequence = sequence
                arm.last_tracked_ns = now_ns
            active = (arm.last_tracked_ns is not None
                      and now_ns - arm.last_tracked_ns <= self.tracking_grace_ns)
            arm.tracked = bool(active and wrist is not None and sequence == arm.sequence)
            if not active:
                arm.target = arm.neutral_target.copy()
                arm.gripper_target = HOME[5]
            started = time.perf_counter_ns()
            solved = arm.model.solve(arm.target, arm.q) if active else HOME.copy()
            solved[5] = arm.gripper_target
            step = self.max_joint_speed * dt
            limited = np.any(np.abs(solved - arm.q) > step + 1e-10)
            next_q = np.clip(arm.q + np.clip(solved - arm.q, -step, step), LOWER, UPPER)
            updated |= active or not np.array_equal(next_q, arm.q)
            arm.q = next_q
            arm.solve_ms = (time.perf_counter_ns() - started) / 1e6 if active else 0.0
            current = arm.model.forward(arm.q)
            residual = np.linalg.norm(arm.target[:3, 3] - current[:3, 3])
            if not active:
                arm.status = "neutral" if np.allclose(arm.q, HOME, atol=1e-10, rtol=0) else "returning"
            elif not arm.tracked:
                arm.status = "coasting"
            else:
                arm.status = "limited" if limited or residual > .015 else "tracking"
        summaries = {side: arm.summary() for side, arm in self.arms.items()}
        return {"model": "xlerobot", "frame_id": "ceres_robot_base", "backend": self.backend,
                "joint_names": [name for arm in self.arms.values() for name in arm.model.joint_names],
                "joint_positions": [float(q) for arm in self.arms.values() for q in arm.q],
                "solve_ms": sum(arm.solve_ms for arm in self.arms.values()),
                "updated": updated, "arms": summaries}
