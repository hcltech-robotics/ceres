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
    return {joint["child"]: (joint["parent"], transform(joint["xyz"], joint["rpy"]))
            for joint in manifest()["joints"]}


def model_poses(links):
    """Use commanded arm FK and the upstream zero poses for accessory joints."""
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
