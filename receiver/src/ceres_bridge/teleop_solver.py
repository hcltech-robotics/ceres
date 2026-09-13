"""Placo inverse kinematics for the pinned five-joint XLeRobot arm."""

import math
import xml.etree.ElementTree as ET

import numpy as np

from .teleop_model import (
    AXES, HOME, LINK_NAMES, LOWER, ORIGINS, RPY, TIP, UPPER,
    axis_rotation, rotation_vector,
)


def _numbers(values):
    return " ".join(format(float(value), ".17g") for value in values)


def _origin(joint, matrix):
    rotation = matrix[:3, :3]
    angles = (math.atan2(rotation[2, 1], rotation[2, 2]),
              math.atan2(-rotation[2, 0], math.hypot(rotation[2, 1], rotation[2, 2])),
              math.atan2(rotation[1, 0], rotation[0, 0]))
    ET.SubElement(joint, "origin", xyz=_numbers(matrix[:3, 3]), rpy=_numbers(angles))


def arm_urdf(model):
    """Build a meshless arm with the same base, joints and jaw-tip frame as FK."""
    robot = ET.Element("robot", name="ceres_" + model.side)
    ET.SubElement(robot, "link", name="ceres_robot_base")
    parent = "Base" + model.suffix
    ET.SubElement(robot, "link", name=parent)
    joint = ET.SubElement(robot, "joint", name="arm_mount", type="fixed")
    ET.SubElement(joint, "parent", link="ceres_robot_base")
    ET.SubElement(joint, "child", link=parent)
    _origin(joint, model.base)
    for index in range(5):
        child = LINK_NAMES[index] + model.suffix
        ET.SubElement(robot, "link", name=child)
        joint = ET.SubElement(robot, "joint", name=model.joint_names[index], type="revolute")
        ET.SubElement(joint, "parent", link=parent)
        ET.SubElement(joint, "child", link=child)
        _origin(joint, model.origins[index])
        ET.SubElement(joint, "axis", xyz=_numbers(AXES[index]))
        ET.SubElement(joint, "limit", lower=str(LOWER[index]), upper=str(UPPER[index]), effort="10", velocity="10")
        parent = child
    tip = "Fixed_Jaw_tip" + model.suffix
    ET.SubElement(robot, "link", name=tip)
    joint = ET.SubElement(robot, "joint", name="jaw_tip", type="fixed")
    ET.SubElement(joint, "parent", link=parent)
    ET.SubElement(joint, "child", link=tip)
    ET.SubElement(joint, "origin", xyz=_numbers(TIP), rpy="0 0 0")
    return ET.tostring(robot, encoding="unicode")


def _branch_seeds(model, target, gripper):
    """Enumerate the pinned arm's two radial and two elbow branches.

    The URDF rounds right angles to five decimals. These planar seeds use
    its actual link lengths, then Placo refines the exact spatial chain.
    """
    centre = target[:3, 3] - target[:3, :3] @ (TIP + np.asarray(ORIGINS[4]))
    delta = centre - (model.base @ model.origins[0])[:3, 3]
    radius = math.hypot(*delta[:2])
    alpha = math.atan2(ORIGINS[2][2], ORIGINS[2][1])
    beta = math.atan2(ORIGINS[3][1], ORIGINS[3][2])
    first = math.hypot(ORIGINS[2][1], ORIGINS[2][2])
    second = math.hypot(ORIGINS[3][1], ORIGINS[3][2])

    def wrap(angle):
        return (angle + math.pi) % (2 * math.pi) - math.pi

    for sign in (1, -1):
        pan = wrap(-math.atan2(delta[1], delta[0]) + (math.pi if sign < 0 else 0))
        radial = sign * radius - ORIGINS[1][2]
        height = delta[2] - ORIGINS[1][1]
        cosine = (radial**2 + height**2 - first**2 - second**2) / (2 * first * second)
        for bend in (math.acos(np.clip(cosine, -1, 1)), -math.acos(np.clip(cosine, -1, 1))):
            pitch = math.atan2(height, radial) - math.atan2(
                second * math.sin(bend), first + second * math.cos(bend)) + alpha
            elbow = alpha + beta - bend
            for turn in (-2 * math.pi, 0, 2 * math.pi):
                q = np.array((pan, pitch + turn, elbow, 0.0, 0.0, gripper))
                if np.any(q[:3] < LOWER[:3] - .0001) or np.any(q[:3] > UPPER[:3] + .0001):
                    continue
                current = model.base.copy()
                for index in range(3):
                    rotation = np.eye(4)
                    rotation[:3, :3] = axis_rotation(AXES[index], q[index])
                    current = current @ model.origins[index] @ rotation
                rotation = (current @ model.origins[3])[:3, :3].T @ target[:3, :3]
                q[3] = math.atan2(rotation[2, 1], rotation[1, 1])
                q[4] = wrap(RPY[4][1] - math.atan2(rotation[0, 2], rotation[0, 0]))
                if np.all(q >= LOWER - .0001) and np.all(q <= UPPER + .0001):
                    yield np.clip(q, LOWER, UPPER)


class SO101Solver:
    """Fit position before orientation, retaining the previous IK solution."""

    def __init__(self, model):
        try:
            import placo
        except ImportError as error:
            raise RuntimeError("Install the Bridge teleoperation dependencies to use the SO101 solver") from error
        self.model = model
        self.joint_names = model.joint_names[:5]
        self.tip = "Fixed_Jaw_tip" + model.suffix
        self.robot = placo.RobotWrapper(".", placo.Flags.ignore_collisions, arm_urdf(model))
        self.solver = placo.KinematicsSolver(self.robot)
        self.solver.mask_fbase(True)
        self.solver.enable_joint_limits(True)
        for index, name in enumerate(self.joint_names):
            self.robot.set_joint_limits(name, float(LOWER[index]), float(UPPER[index]))
        self.frame = self.solver.add_frame_task(self.tip, np.eye(4))
        self.position = self.frame.position()
        self.orientation = self.frame.orientation()
        self.posture = self.solver.add_joints_task()
        self.posture.configure("posture", "soft", 0.0)
        self._warming_rotation = False
        self._posture_weight = 80.0
        self._position_history = []
        self._translating = True
        self._motion_reference = HOME.copy()
        self._held_orientation_step = .025
        self.solution = None
        self._target_position = None
        self._best_distance = math.inf
        self._target = None
        self._position_solution = None
        self._recovery_position = None
        self._mount_position = (model.base @ model.origins[0])[:3, 3]
        self._neutral_rotation = model.forward(HOME)[:3, :3]

    def reset(self, seed=None):
        if seed is not None:
            seed = np.asarray(seed, dtype=float)
            if seed.shape != (6,) or not np.isfinite(seed).all():
                raise ValueError("Six finite joint positions are required to reset IK")
        self.solution = None if seed is None else np.clip(seed, LOWER, UPPER).copy()
        self._target_position = None
        self._best_distance = math.inf
        self._target = None
        self._position_solution = None
        self._recovery_position = None
        self._position_history = []
        self._translating = True
        self._posture_weight = 80.0
        self._held_orientation_step = .025

    @property
    def position_held(self):
        """Whether the last twelve target updates show no sustained translation."""
        return len(self._position_history) == 12 and not self._translating

    def _set(self, q):
        for name, value in zip(self.joint_names, q):
            self.robot.set_joint(name, float(value))
        self.robot.update_kinematics()

    def _get(self, gripper):
        return np.array([*(self.robot.get_joint(name) for name in self.joint_names), gripper])

    def _pose(self, q):
        self._set(q)
        return np.asarray(self.robot.get_T_world_frame(self.tip))

    def _candidate(self, q):
        self.solver.solve(True)
        change = self._get(q[5]) - q
        # A single scale preserves the QP direction when limiting its step.
        change *= min(1.0, .35 / max(float(np.max(np.abs(change))), 1e-15))
        return change

    def _joint_limits(self, q, refining):
        for index, name in enumerate(self.joint_names):
            lower, upper = float(LOWER[index]), float(UPPER[index])
            if refining and index < 4:
                step = .015 if self._translating else self._held_orientation_step
                lower = max(lower, min(float(q[index] - 1e-6), float(self._motion_reference[index] - step)))
                upper = min(upper, max(float(q[index] + 1e-6), float(self._motion_reference[index] + step)))
            self.robot.set_joint_limits(name, lower, upper)

    def _position_step(self, q, target, orientation_weight=0.0, refining=False):
        self._joint_limits(q, refining)
        pose = self._pose(q)
        distance = np.linalg.norm(pose[:3, 3] - target[:3, 3])
        if distance < 1e-9:
            return q, distance, 0.0
        self.frame.T_world_frame = target
        self.position.configure("position", "soft", 1.0)
        self.orientation.configure("orientation", "soft", orientation_weight)
        self.posture.configure("posture", "soft", self._posture_weight * orientation_weight)
        change = self._candidate(q)
        for scale in (1.0, .5, .25, .125, .0625, .03125, .015625):
            candidate = np.clip(q + scale * change, LOWER, UPPER)
            actual = self._pose(candidate)
            error = np.linalg.norm(actual[:3, 3] - target[:3, 3])
            if error < distance - 1e-12:
                return candidate, error, distance-error
        return q, distance, 0.0

    def _orientation_step(self, q, target):
        self._joint_limits(q, True)
        pose = self._pose(q)
        angle = np.linalg.norm(rotation_vector(target[:3, :3] @ pose[:3, :3].T))
        if angle < 1e-7:
            return q
        # Zero displacement is always feasible, even at an unreachable target
        # or a joint limit. This QP fits rotation in the positional null space.
        self.frame.T_world_frame = target
        self.position.target_world = pose[:3, 3]
        self.position.configure("position", "hard", 1.0)
        self.orientation.configure("orientation", "soft", 1.0)
        self.posture.configure("posture", "soft", 0.0 if self._warming_rotation else self._posture_weight)
        change = self._candidate(q)
        for scale in (1.0, .5, .25, .125, .0625, .03125, .015625, .0078125):
            candidate = np.clip(q + scale * change, LOWER, UPPER)
            actual = self._pose(candidate)
            distance = np.linalg.norm(actual[:3, 3] - target[:3, 3])
            error = np.linalg.norm(rotation_vector(target[:3, :3] @ actual[:3, :3].T))
            if distance <= self._best_distance + .00019 and error < angle - 1e-10:
                return candidate
        return q

    def _warm_rotation(self, q, target, previous_target, iterations):
        """Follow new wrist rotation without chasing old orientation through a singularity."""
        change = target[:3, :3] @ previous_target[:3, :3].T
        if np.linalg.norm(rotation_vector(change)) < 1e-7:
            return q
        before = q.copy()
        pose = self._pose(q)
        following = pose.copy()
        following[:3, :3] = change @ pose[:3, :3]
        previous_best = self._best_distance
        self._best_distance = 0.0
        self._warming_rotation = True
        try:
            for _ in range(min(32, iterations * 4)):
                prior = q.copy()
                q = self._orientation_step(q, following)
                q, _, _ = self._position_step(q, following, refining=True)
                if np.max(np.abs(q - prior)) < 1e-8:
                    break
        finally:
            self._best_distance = previous_best
            self._warming_rotation = False
            for index, name in enumerate(self.joint_names):
                self.robot.set_joint_limits(name, float(LOWER[index]), float(UPPER[index]))
        actual = self._pose(q)
        before_error = np.linalg.norm(rotation_vector(target[:3, :3] @ pose[:3, :3].T))
        after_error = np.linalg.norm(rotation_vector(target[:3, :3] @ actual[:3, :3].T))
        if (after_error < before_error and
                np.linalg.norm(actual[:3, 3] - pose[:3, 3]) <= .00019):
            return q
        return before

    def _recover_position(self, q, target, distance):
        """Try a finite set of arm-plane directions, independent of hand rotation."""
        yaw = math.atan2(target[1, 3] - self._mount_position[1], target[0, 3] - self._mount_position[0])
        candidates = []
        virtual = target.copy()
        for offset in (0, math.pi):
            for pitch in np.linspace(-math.pi, math.pi, 16, endpoint=False):
                virtual[:3, :3] = (axis_rotation((0, 0, 1), yaw + offset)
                                   @ axis_rotation((0, 1, 0), pitch) @ self._neutral_rotation)
                for candidate in _branch_seeds(self.model, virtual, q[5]):
                    error = np.linalg.norm(self._pose(candidate)[:3, 3] - target[:3, 3])
                    if error < distance - .0001:
                        candidates.append((error, candidate))
        if not candidates:
            return q, distance
        close = [(error, candidate) for error, candidate in candidates if error < .00005]
        if close:
            error, candidate = min(close, key=lambda pair: np.linalg.norm(pair[1][:5] - q[:5]))
        else:
            error, candidate = min(candidates, key=lambda pair: pair[0])
        return candidate, error

    def solve(self, target, seed, iterations=8):
        target, seed = np.asarray(target, dtype=float), np.asarray(seed, dtype=float)
        if target.shape != (4, 4) or seed.shape != (6,) or not np.isfinite(target).all() or not np.isfinite(seed).all():
            raise ValueError("A finite target transform and six joint positions are required")
        if not isinstance(iterations, int) or not 1 <= iterations <= 256:
            raise ValueError("IK iterations must be between 1 and 256")
        q = np.clip(seed if self.solution is None else self.solution, LOWER, UPPER).copy()
        q[5] = np.clip(seed[5], LOWER[5], UPPER[5])
        motion_reference = q.copy()
        self._motion_reference = motion_reference
        previous_target = self._target
        self._position_history.append(target[:3, 3].copy())
        self._position_history = self._position_history[-12:]
        if len(self._position_history) == 12:
            positions = np.asarray(self._position_history)
            trend = np.linalg.norm(np.mean(positions[-4:], axis=0) - np.mean(positions[:4], axis=0)) / 8
            noise = np.linalg.norm(np.std(np.diff(positions, axis=0), axis=0)) / math.sqrt(11)
            self._translating = trend > max(.0002, 3 * noise)
        self._posture_weight = 80.0 if self._translating else 0.0
        rotation_change = (0.0 if previous_target is None else float(np.linalg.norm(
            rotation_vector(target[:3, :3] @ previous_target[:3, :3].T))))
        # A deliberate held-wrist rotation supplies one coherent joint goal
        # for coordinated motion. Automatic recovery and jitter stay bounded.
        self._held_orientation_step = .025 + 3 * max(0.0, rotation_change - .01)
        position_changed = self._target_position is None or not np.array_equal(target[:3, 3], self._target_position)
        if position_changed:
            self._target_position = target[:3, 3].copy()
            self._best_distance = math.inf
            self._position_solution = q.copy()
        current_distance = np.linalg.norm(self._pose(q)[:3, 3] - target[:3, 3])
        relocated = self._target is None or current_distance >= .01
        exact_seed = False
        self.posture.set_joints(dict(zip(self.joint_names[:4], map(float, motion_reference[:4]))))
        if self._target is None or not np.array_equal(target, self._target):
            candidates = []
            approximate = []
            for candidate in _branch_seeds(self.model, target, q[5]):
                pose = self._pose(candidate)
                distance = np.linalg.norm(pose[:3, 3] - target[:3, 3])
                angle = np.linalg.norm(rotation_vector(target[:3, :3] @ pose[:3, :3].T))
                # An infeasible rotation must never replace a better position.
                if (distance < .00005 and angle < .0001 and distance <= self._best_distance + .00019 and
                        (relocated or np.max(np.abs(candidate[:5] - motion_reference[:5])) < .03)):
                    candidates.append(candidate)
                elif relocated:
                    for _ in range(min(8, iterations)):
                        candidate, distance, progress = self._position_step(candidate, target)
                        if distance < 1e-9 or progress < 1e-12:
                            break
                    if distance < .00005:
                        pose = self._pose(candidate)
                        angle = np.linalg.norm(rotation_vector(target[:3, :3] @ pose[:3, :3].T))
                        approximate.append((angle, np.linalg.norm(candidate[:5] - motion_reference[:5]), candidate))
            if candidates:
                q = min(candidates, key=lambda candidate: np.linalg.norm(candidate[:5] - q[:5]))
                self._position_solution = q.copy()
                exact_seed = True
            elif approximate:
                q = min(approximate, key=lambda item: item[:2])[2]
                self._position_solution = q.copy()
        if previous_target is not None and not exact_seed:
            q = self._warm_rotation(q, target, previous_target, iterations)
            if position_changed:
                self._position_solution = q.copy()
        self.posture.set_joints(dict(zip(self.joint_names[:4], map(float, q[:4] if not exact_seed else motion_reference[:4]))))
        self._target = target.copy()
        position_q = self._position_solution.copy()
        position_q[5] = q[5]
        for _ in range(iterations):
            position_q, distance, progress = self._position_step(position_q, target)
            if distance < 1e-9 or progress < 1e-12:
                break
        if (distance > .001 and progress < max(1e-7, .001 * distance) and
                (self._recovery_position is None or
                 np.linalg.norm(target[:3, 3] - self._recovery_position) >= .01)):
            self._recovery_position = target[:3, 3].copy()
            position_q, distance = self._recover_position(position_q, target, distance)
        self._position_solution = position_q
        self._best_distance = min(self._best_distance, distance)
        if np.linalg.norm(self._pose(q)[:3, 3] - target[:3, 3]) > self._best_distance + .00019:
            q = position_q.copy()
        # Rotation refinement has a separate state, so a closest-position
        # search cannot repeatedly erase a feasible wrist-roll adjustment.
        for _ in range(iterations):
            weight = 0.0 if self._posture_weight == 0.0 and self._best_distance < .0001 else .001 / (1 + (distance / .1)**4)
            q, distance, progress = self._position_step(q, target, weight, refining=True)
            if distance < .0001 or progress < 1e-8:
                q = self._orientation_step(q, target)
        self.solution = q.copy()
        return q
