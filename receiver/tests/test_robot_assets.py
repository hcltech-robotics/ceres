import base64
import hashlib
from importlib.resources import files
import json
import struct
import xml.etree.ElementTree as ET

import numpy as np
import pytest

from ceres_bridge.foxglove_teleop import robot_scene
from ceres_bridge.robot_assets import asset_bytes, manifest, model_poses
from ceres_bridge.teleop import DualArmTeleop
from ceres_bridge.teleop_model import HOME, ArmModel, axis_rotation, pose_dict, quaternion_matrix, robot_urdf, transform
from test_foxglove import decode


def matrix(pose):
    result = np.eye(4)
    result[:3, :3] = quaternion_matrix([pose["orientation"][axis] for axis in "xyzw"])
    result[:3, 3] = [pose["position"][axis] for axis in "xyz"]
    return result


def test_packaged_meshes_cover_every_upstream_visual_link_and_match_their_hashes():
    assets = manifest()
    original = files("ceres_bridge").joinpath("data", "xlerobot", "xlerobot.urdf").read_bytes()
    assert hashlib.sha256(original).hexdigest() == assets["source_urdf_sha256"]
    robot = ET.fromstring(original)
    links = {link.get("name"): link for link in robot.findall("link") if link.find("visual") is not None}
    assert set(assets["models"]) == set(links)
    assert len({item["file"] for item in assets["models"].values()}) == 12
    for name, model in assets["models"].items():
        content = asset_bytes(model["file"])
        magic, version, length = struct.unpack_from("<III", content)
        assert (magic, version, length) == (0x46546C67, 2, len(content))
        assert hashlib.sha256(content).hexdigest() == model["sha256"]
        json_length, json_type = struct.unpack_from("<II", content, 12)
        assert json_type == 0x4E4F534A
        gltf = json.loads(content[20:20 + json_length])
        assert all("uri" not in buffer for buffer in gltf["buffers"])
        for original_visual, recipe, node in zip(links[name].findall("visual"), model["visuals"], gltf["nodes"], strict=True):
            mesh = original_visual.find("geometry/mesh")
            origin = original_visual.find("origin")
            assert mesh is not None
            assert recipe["mesh"] == mesh.get("filename")
            assert recipe["scale"] == [float(value) for value in mesh.get("scale", "1 1 1").split()]
            assert recipe["xyz"] == [float(value) for value in origin.get("xyz", "0 0 0").split()]
            assert recipe["rpy"] == [float(value) for value in origin.get("rpy", "0 0 0").split()]
            assert node["extras"] == recipe
    # Foxglove's default model loader applies Rx(+90 degrees) to Y-up GLBs.
    assert transform(rpy=(np.pi / 2, 0, 0))[:3, :3] @ np.array(assets["gltf_from_link"]) == pytest.approx(np.eye(3))


def test_articulated_meshes_use_the_commanded_fk_and_urdf_camera_origins():
    robot = DualArmTeleop()
    links = robot.link_transforms()
    poses = model_poses(links)
    for name in set(poses) & set(links):
        assert poses[name] == links[name]
    joints = {joint["child"]: joint for joint in manifest()["joints"]}
    for camera, parent in (("Left_Arm_Camera", "Fixed_Jaw_2"), ("Right_Arm_Camera", "Fixed_Jaw")):
        joint = joints[camera]
        expected = matrix(links[parent]) @ transform(joint["xyz"], joint["rpy"])
        assert matrix(poses[camera]) == pytest.approx(expected)
    changed = dict(links)
    changed["Moving_Jaw"] = pose_dict(matrix(links["Moving_Jaw"]) @ transform(rpy=(0, 0, .5)))
    next_poses = model_poses(changed)
    assert next_poses["Fixed_Jaw"] == poses["Fixed_Jaw"]
    assert next_poses["Moving_Jaw"] == changed["Moving_Jaw"]


def test_exported_urdf_embeds_actual_meshes_and_matches_every_scene_link_pose():
    robot = ET.fromstring(robot_urdf())
    visuals = {link.get("name"): link.find("visual") for link in robot.findall("link")
               if link.find("visual") is not None}
    assert set(visuals) == set(manifest()["models"])
    assert not robot.findall(".//collision")
    for name, visual in visuals.items():
        geometry = visual.find("geometry")
        assert len(geometry) == 1 and geometry[0].tag == "mesh"
        resource = geometry[0].get("filename")
        prefix, encoded = resource.split(",", 1)
        assert prefix == "data:model/gltf-binary;base64"
        assert base64.b64decode(encoded, validate=True) == asset_bytes(manifest()["models"][name]["file"])
        assert geometry[0].get("scale") == "1 1 1"
        assert visual.find("origin").attrib == {"xyz": "0 0 0", "rpy": "0 0 0"}

    joints = {joint.find("child").get("link"): joint for joint in robot.findall("joint")}
    positions = {name: float(value) for side in ("left", "right")
                 for name, value in zip(ArmModel(side).joint_names, HOME)}
    matrices = {"ceres_robot_base": np.eye(4)}

    def resolve(name):
        if name not in matrices:
            joint = joints[name]
            origin = joint.find("origin")
            local = transform(np.fromstring(origin.get("xyz"), sep=" "), np.fromstring(origin.get("rpy"), sep=" "))
            if joint.get("type") != "fixed":
                assert joint.get("type") == "revolute"
                turn = np.eye(4)
                turn[:3, :3] = axis_rotation(np.fromstring(joint.find("axis").get("xyz"), sep=" "), positions[joint.get("name")])
                local = local @ turn
            matrices[name] = resolve(joint.find("parent").get("link")) @ local
        return matrices[name]

    expected = model_poses(DualArmTeleop().link_transforms())
    for name, pose in expected.items():
        assert resolve(name) == pytest.approx(matrix(pose), abs=1e-10)


def test_robot_scene_uses_actual_mesh_models_and_independent_target_markers():
    robot = DualArmTeleop()
    state = robot.update({"epoch": 1, "space_epoch": 1, "connection": "connected", "poses": {}})
    scene = decode(robot_scene(state, robot.link_transforms(), 1_000_000_000, "http://127.0.0.1:8765/assets/xlerobot"))
    models = [entity for entity in scene.entities if entity.models]
    assert {entity.id for entity in models} == {"robot/" + name for name in manifest()["models"]}
    for entity in models:
        assert entity.frame_id == "ceres_robot_base"
        assert not entity.lines and not entity.spheres and not entity.cubes
        model = entity.models[0]
        assert model.url.endswith(manifest()["models"][entity.id[6:]]["file"])
        assert model.media_type == "model/gltf-binary" and not model.data
        assert (model.scale.x, model.scale.y, model.scale.z) == (1, 1, 1)


@pytest.mark.parametrize("name", ["../xlerobot.urdf", "LICENSE.txt", "unknown.glb", "base.glb/../manifest.json"])
def test_robot_assets_only_resolve_manifest_listed_meshes(name):
    with pytest.raises(ValueError, match="Unknown"):
        asset_bytes(name)
