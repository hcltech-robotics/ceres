"""Packaged upstream XLeRobot visual models and their URDF link placement."""

from functools import lru_cache
from importlib.resources import files
import json

import numpy as np

from .teleop_model import pose_dict, quaternion_matrix, transform


@lru_cache(maxsize=1)
def manifest():
    return json.loads(files("ceres_bridge").joinpath("data", "xlerobot", "manifest.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=12)
def asset_bytes(name):
    """Read only a GLB named by the packaged visual manifest."""
    if name not in {model["file"] for model in manifest()["models"].values()}:
        raise ValueError("Unknown XLeRobot visual asset")
    return files("ceres_bridge").joinpath("data", "xlerobot", name).read_bytes()


@lru_cache(maxsize=1)
def _joint_origins():
    return {joint["child"]: (joint["parent"], visual_joint_origin(joint["child"], joint["xyz"], joint["rpy"]))
            for joint in manifest()["joints"]}


def visual_joint_origin(child, xyz, rpy):
    """Place wrist cameras above the jaws using their original camera meshes."""
    origin = transform(xyz, rpy)
    if child in {"Left_Arm_Camera", "Right_Arm_Camera"}:
        # Rotate the attachment around tool -Y without rolling the jaw with it.
        # The camera sits above a pronated gripper and looks forward/downwards.
        origin = transform(rpy=(0, -np.pi / 2, 0)) @ origin
    return origin


def model_poses(links):
    """Use commanded arm FK with top-mounted cameras and fixed base/head joints."""
    matrices = {"root": np.eye(4)}

    def resolve(name):
        if name not in matrices:
            if name in links:
                pose = links[name]
                matrix = np.eye(4)
                matrix[:3, :3] = quaternion_matrix([pose["orientation"][axis] for axis in "xyzw"])
                matrix[:3, 3] = [pose["position"][axis] for axis in "xyz"]
            else:
                parent, origin = _joint_origins()[name]
                matrix = resolve(parent) @ origin
            matrices[name] = matrix
        return matrices[name]

    return {name: links[name] if name in links else pose_dict(resolve(name))
            for name in manifest()["models"]}
