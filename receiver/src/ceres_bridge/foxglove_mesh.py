"""CERES Player MANO fitting for the optional receiver visualisation."""

import json
from pathlib import Path
import numpy as np

TARGETS = (0, 6, 7, 8, 11, 12, 13, 21, 22, 23, 16, 17, 18, 1, 2, 3)
TIPS = {"thumbTip": 4, "indexTip": 9, "middleTip": 14, "ringTip": 19, "pinkyTip": 24}
REQUIRED_MASK = sum(1 << index for index in TARGETS)
PARENTS = [-1, 0, 1, 2, 0, 4, 5, 0, 7, 8, 0, 10, 11, 0, 13, 14]
JOINT_NAMES = ["wrist", "index1", "index2", "index3", "middle1", "middle2", "middle3",
               "pinky1", "pinky2", "pinky3", "ring1", "ring2", "ring3", "thumb1", "thumb2", "thumb3"]


def normal(v):
    length = np.linalg.norm(v)
    return v / length if length > 1e-8 else np.zeros(3)


def basis(points):
    x = normal(points[1] - points[7])
    z = normal(np.cross(x, points[4] - points[0]))
    y = normal(np.cross(z, x))
    return np.column_stack((x, y, z)) if min(np.linalg.norm(x), np.linalg.norm(y), np.linalg.norm(z)) > 1e-8 else np.eye(3)


def rotation_between(a, b):
    a, b = normal(a), normal(b)
    if min(np.linalg.norm(a), np.linalg.norm(b)) < 1e-8:
        return np.eye(3)
    axis = np.cross(a, b)
    sine, cosine = np.linalg.norm(axis), np.clip(np.dot(a, b), -1, 1)
    if sine < 1e-7:
        if cosine > 0:
            return np.eye(3)
        p = normal(np.cross(a, (1, 0, 0) if abs(a[0]) < .8 else (0, 1, 0)))
        return 2 * np.outer(p, p) - np.eye(3)
    x, y, z = axis / sine
    skew = np.array(((0, -z, y), (z, 0, -x), (-y, x, 0)))
    return cosine * np.eye(3) + (1 - cosine) * np.outer(axis / sine, axis / sine) + sine * skew


class HandMesh:
    def __init__(self, path, side):
        if Path(path).stat().st_size > 5 * 1024 * 1024:
            raise ValueError("CERES hand mesh asset exceeds the size limit")
        asset = json.loads(Path(path).read_text())
        if (asset["version"], asset["side"], asset["vertexCount"], asset["faceCount"], asset["jointCount"]) != (1, side, 778, 1538, 16):
            raise ValueError("Invalid CERES hand mesh asset")
        self.vertices = np.asarray(asset["vertices"]).reshape(778, 3)
        self.faces = asset["faces"]
        self.joints = np.asarray(asset["joints"]).reshape(16, 3)
        self.parents = asset["parents"]
        self.weights = np.asarray(asset["weights"]).reshape(778, 16)
        self.tips = asset["tipVertexIds"]
        if (asset["jointNames"] != JOINT_NAMES or self.parents != PARENTS
                or len(self.faces) != 1538 * 3
                or any(type(index) is not int or not 0 <= index < 778 for index in self.faces)
                or set(self.tips) != set(TIPS)
                or any(type(index) is not int or not 0 <= index < 778 for index in self.tips.values())
                or not all(np.isfinite(array).all() for array in (self.vertices, self.joints, self.weights))
                or np.any(self.weights < 0) or np.any(self.weights > 1)
                or np.any(np.abs(self.weights.sum(axis=1) - 1) > 1e-4)):
            raise ValueError("Invalid CERES hand mesh topology or weights")
        self.weights[self.weights < 1e-5] = 0

    def fit(self, pose):
        if pose["joint_mask"] & REQUIRED_MASK != REQUIRED_MASK:
            return None
        source = np.asarray(pose["values"]).reshape(25, 8)[:, :3]
        targets = source[list(TARGETS)]
        ratios = []
        for joint in range(1, 16):
            parent = self.parents[joint]
            rest = np.linalg.norm(self.joints[joint] - self.joints[parent])
            target = np.linalg.norm(targets[joint] - targets[parent])
            if rest > 1e-6 and target > 1e-6:
                ratios.append(target / rest)
        ratios.sort()
        scale = np.clip(ratios[len(ratios) // 2] if ratios else 1, .55, 1.8)
        root = self.joints[0]
        joints = root + (self.joints - root) * scale
        vertices = root + (self.vertices - root) * scale
        output = np.zeros_like(vertices)
        for joint in range(16):
            rotation = basis(targets) @ basis(joints).T if joint == 0 else rotation_between(
                joints[joint] - joints[self.parents[joint]], targets[joint] - targets[self.parents[joint]])
            translation = targets[joint] - rotation @ joints[joint]
            output += (vertices @ rotation.T + translation) * self.weights[:, joint:joint+1]
        for name, vertex in self.tips.items():
            index = TIPS[name]
            if pose["joint_mask"] & (1 << index):
                output[vertex] = source[index]
        # Match Player fitting first, then convert only the presentation basis.
        return output[:, [2, 0, 1]] * (-1, -1, 1)
