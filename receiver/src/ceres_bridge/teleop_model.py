"""XLeRobot arm kinematics and its packaged visual URDF for Foxglove.

Joint origins, axes and limits are derived from Vector-Wangel/XLeRobot,
simulation/Maniskill/assets/xlerobot/xlerobot.urdf at commit
3d14695e40c9c68229c0aacffca6053c75cd3eb6 (Apache-2.0).
The visual URDF embeds the packaged upstream meshes as self-contained GLB data.
"""

import base64
from functools import lru_cache
from importlib.resources import files
import math
import xml.etree.ElementTree as ET

import numpy as np

SOURCE_URL = "https://github.com/Vector-Wangel/XLeRobot/blob/3d14695e40c9c68229c0aacffca6053c75cd3eb6/simulation/Maniskill/assets/xlerobot/xlerobot.urdf"
JOINT_NAMES = ("Rotation", "Pitch", "Elbow", "Wrist_Pitch", "Wrist_Roll", "Jaw")
LINK_NAMES = ("Rotation_Pitch", "Upper_Arm", "Lower_Arm", "Wrist_Pitch_Roll", "Fixed_Jaw", "Moving_Jaw")
ORIGINS = ((0, -.0452, .0165), (0, .1025, .0306), (0, .11257, .028),
           (0, .0052, .1349), (0, -.0601, 0), (-.0202, -.0244, 0))
RPY = ((1.5708, 0, 0), (1.5708, 0, 0), (-1.5708, 0, 0),
       (-1.5708, 0, 0), (0, 1.5708, 0), (3.1416, 0, 3.33))
AXES = ((0, -1, 0), (-1, 0, 0), (1, 0, 0), (1, 0, 0), (0, -1, 0), (0, 0, 1))
LOWER = np.array((-2.1, -.1, -.2, -1.8, -3.14159, 0.0))
UPPER = np.array((2.1, 3.45, 3.14159, 1.8, 3.14159, 1.7))
HOME = np.array((0.0, 1.0, 1.5, -.5, 0.0, .8))
TIP = np.array((.01, -.097, 0.0))
# ROS-converted wrist +X points towards the fingers. Fixed_Jaw approaches along
# -Y and closes along X. A local quarter turn aligns these tool and hand axes.
HAND_FROM_TOOL = np.array(((0., -1., 0.), (1., 0., 0.), (0., 0., 1.)))
HAND_FROM_TOOL.setflags(write=False)


def skew(axis):
    x, y, z = axis
    return np.array(((0, -z, y), (z, 0, -x), (-y, x, 0)))


def axis_rotation(axis, angle):
    k = skew(axis)
    return np.eye(3) + math.sin(angle) * k + (1 - math.cos(angle)) * (k @ k)


def transform(xyz=(0, 0, 0), rpy=(0, 0, 0)):
    result = np.eye(4)
    roll, pitch, yaw = rpy
    result[:3, :3] = (axis_rotation((0, 0, 1), yaw) @ axis_rotation((0, 1, 0), pitch)
                      @ axis_rotation((1, 0, 0), roll))
    result[:3, 3] = xyz
    return result


def quaternion_matrix(quaternion):
    q = np.asarray(quaternion, dtype=float)
    norm = np.linalg.norm(q)
    if q.shape != (4,) or not np.all(np.isfinite(q)) or norm < 1e-8:
        raise ValueError("A finite, nonzero xyzw quaternion is required")
    x, y, z, w = q / norm
    return np.array(((1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)),
                     (2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)),
                     (2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y))))


def matrix_quaternion(rotation):
    # The symmetric eigenproblem remains stable at half turns.
    r = rotation
    k = np.array(((r[0,0]-r[1,1]-r[2,2], r[1,0]+r[0,1], r[2,0]+r[0,2], r[2,1]-r[1,2]),
                  (r[1,0]+r[0,1], r[1,1]-r[0,0]-r[2,2], r[2,1]+r[1,2], r[0,2]-r[2,0]),
                  (r[2,0]+r[0,2], r[2,1]+r[1,2], r[2,2]-r[0,0]-r[1,1], r[1,0]-r[0,1]),
                  (r[2,1]-r[1,2], r[0,2]-r[2,0], r[1,0]-r[0,1], np.trace(r)))) / 3
    q = np.linalg.eigh(k)[1][:, -1]
    return q if q[3] >= 0 else -q


def rotation_vector(rotation):
    q = matrix_quaternion(rotation)
    magnitude = np.linalg.norm(q[:3])
    if magnitude < 1e-9:
        return 2 * q[:3]
    return q[:3] * (2 * math.atan2(magnitude, q[3]) / magnitude)


def pose_dict(matrix):
    return {"position": dict(zip(("x", "y", "z"), matrix[:3, 3].tolist())),
            "orientation": dict(zip(("x", "y", "z", "w"), matrix_quaternion(matrix[:3, :3]).tolist()))}


class ArmModel:
    """The upstream five-joint arm chain and independent gripper hinge."""

    def __init__(self, side):
        if side not in ("left", "right"):
            raise ValueError("Arm side must be left or right")
        self.side = side
        self.suffix = "_2" if side == "left" else ""
        self.joint_names = [name + self.suffix for name in JOINT_NAMES]
        self.base = transform((-.135, .133 if side == "left" else -.133, .760), (0, 0, 1.5708))
        self.origins = [transform(xyz, rpy) for xyz, rpy in zip(ORIGINS, RPY)]
        self._position_target = None
        self._best_position_error = math.inf
        self._position_stationary = False

    def forward(self, joints, *, jacobian=False):
        current = self.base.copy()
        origins, axes = [], []
        for index in range(5):
            current = current @ self.origins[index]
            origins.append(current[:3, 3].copy())
            axes.append(current[:3, :3] @ AXES[index])
            turn = np.eye(4)
            turn[:3, :3] = axis_rotation(AXES[index], joints[index])
            current = current @ turn
        current = current @ transform(TIP)
        if not jacobian:
            return current
        j = np.column_stack([np.r_[np.cross(axis, current[:3, 3] - origin), axis]
                             for origin, axis in zip(origins, axes)])
        return current, j

    def links(self, joints):
        current = self.base.copy()
        result = {"Base" + self.suffix: current.copy()}
        for index in range(6):
            current = current @ self.origins[index]
            turn = np.eye(4)
            turn[:3, :3] = axis_rotation(AXES[index], joints[index])
            current = current @ turn
            result[LINK_NAMES[index] + self.suffix] = current.copy()
        result["Fixed_Jaw_tip" + self.suffix] = self.forward(joints)
        return result

    def solve(self, target, seed, iterations=12):
        """Fit position first, then fit rotation within the position null space."""
        q = np.clip(np.asarray(seed, dtype=float), LOWER, UPPER).copy()
        position_tolerance = .0002
        if not np.array_equal(self._position_target, target[:3, 3]):
            self._position_target = target[:3, 3].copy()
            self._best_position_error = math.inf
            self._position_stationary = False
        for _ in range(iterations):
            current, jacobian = self.forward(q, jacobian=True)
            error = target[:3, 3] - current[:3, 3]
            distance = np.linalg.norm(error)
            self._best_position_error = min(self._best_position_error, distance)
            jp, jr = jacobian[:3], jacobian[3:]
            primary = jp.T @ np.linalg.solve(jp @ jp.T + .0001 * np.eye(3), error)
            limit = (position_tolerance if self._best_position_error <= position_tolerance
                     else self._best_position_error + position_tolerance)
            candidate = None
            if distance <= position_tolerance or self._position_stationary:
                correction = np.zeros(5) if self._position_stationary else primary
                candidate = self._rotation_candidate(target, q, current, jp, jr, correction, limit)
            # Clipping a Newton step at a joint limit can spoil its descent
            # direction. Projected gradient descent supplies a bounded fallback.
            steps = (primary, jp.T @ error / max(np.sum(jp * jp), 1e-8))
            for step in steps:
                if candidate is not None:
                    break
                step *= min(1., .12 / max(np.max(np.abs(step)), 1e-12))
                for scale in (1., .5, .25):
                    trial = q.copy()
                    trial[:5] = np.clip(q[:5] + scale * step, LOWER[:5], UPPER[:5])
                    pose = self.forward(trial)
                    next_distance = np.linalg.norm(target[:3, 3] - pose[:3, 3])
                    if next_distance < distance - 1e-7:
                        candidate = trial
                        break
            if candidate is None and distance > position_tolerance and not self._position_stationary:
                # At the closest reachable pose, allow rotation within one fixed
                # tolerance of the best position found for this held target.
                # Changing only orientation does not replenish this allowance.
                self._position_stationary = True
                candidate = self._rotation_candidate(target, q, current, jp, jr, np.zeros(5), limit)
            if candidate is None or candidate is q:
                break
            q = candidate
        return q

    def _rotation_candidate(self, target, q, current, jp, jr, primary, position_limit):
        angular = rotation_vector(target[:3, :3] @ current[:3, :3].T)
        angle = np.linalg.norm(angular)
        if angle < .005:
            return q if np.linalg.norm(target[:3, 3] - current[:3, 3]) <= position_limit else None
        # An exact null space prevents an infeasible orientation from trading
        # away wrist position on this five-joint arm.
        _, singular, right = np.linalg.svd(jp, full_matrices=True)
        rank = np.count_nonzero(singular > max(singular[0] * 1e-5, 1e-8))
        null = right[rank:].T
        jn = jr @ null
        step = primary + null @ np.linalg.solve(
            jn.T @ jn + .0001 * np.eye(null.shape[1]), jn.T @ (angular - jr @ primary))
        step *= min(1., .12 / max(np.max(np.abs(step)), 1e-12))
        for scale in (1., .5, .25):
            candidate = q.copy()
            candidate[:5] = np.clip(q[:5] + scale * step, LOWER[:5], UPPER[:5])
            pose = self.forward(candidate)
            distance = np.linalg.norm(target[:3, 3] - pose[:3, 3])
            next_angle = np.linalg.norm(rotation_vector(target[:3, :3] @ pose[:3, :3].T))
            if distance <= position_limit and next_angle < angle - 1e-8:
                return candidate
        return None


@lru_cache(maxsize=1)
def robot_urdf():
    """Return the pinned visual model with embedded meshes and stationary base/head.

    GLB visuals include the upstream visual origins, scales and materials. They
    use standard glTF Y-up coordinates, matching Foxglove's default mesh setting.
    The arm joints retain the upstream geometry, limits and independent jaws.
    """
    from .robot_assets import asset_bytes, manifest

    robot = ET.fromstring(files("ceres_bridge").joinpath("data", "xlerobot", "xlerobot.urdf").read_bytes())
    robot.set("name", "ceres_xlerobot")
    robot.insert(0, ET.Comment(" Source: " + SOURCE_URL + " (Apache-2.0). Embedded upstream visual meshes. "))
    robot.insert(1, ET.Element("link", name="ceres_robot_base"))
    root_joint = ET.Element("joint", name="ceres_root_joint", type="fixed")
    ET.SubElement(root_joint, "parent", link="ceres_robot_base")
    ET.SubElement(root_joint, "child", link="root")
    ET.SubElement(root_joint, "origin", xyz="0 0 0", rpy="0 0 0")
    robot.insert(2, root_joint)

    models = manifest()["models"]
    resources = {name: "data:model/gltf-binary;base64," + base64.b64encode(asset_bytes(name)).decode("ascii")
                 for name in {model["file"] for model in models.values()}}
    for link in robot.findall("link"):
        # This export describes visual geometry. The original collision meshes
        # remain in the separately packaged, unmodified upstream source URDF.
        for element in [*link.findall("visual"), *link.findall("collision")]:
            link.remove(element)
        model = models.get(link.get("name"))
        if model is not None:
            visual = ET.SubElement(link, "visual")
            ET.SubElement(visual, "origin", xyz="0 0 0", rpy="0 0 0")
            ET.SubElement(ET.SubElement(visual, "geometry"), "mesh",
                          filename=resources[model["file"]], scale="1 1 1")

    stationary = {"root_x_axis_joint", "root_y_axis_joint", "root_z_rotation_joint",
                  "head_pan_joint", "head_tilt_joint"}
    for joint in robot.findall("joint"):
        if joint.find("origin") is None:
            ET.SubElement(joint, "origin", xyz="0 0 0", rpy="0 0 0")
        if joint.get("name") in stationary:
            joint.set("type", "fixed")
            for element in [*joint.findall("axis"), *joint.findall("limit"), *joint.findall("dynamics")]:
                joint.remove(element)
    return ET.tostring(robot, encoding="unicode")
