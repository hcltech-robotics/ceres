import base64
import hashlib
from importlib.resources import files
import json
import struct
import xml.etree.ElementTree as ET

import numpy as np
import pytest

from ceres_bridge.foxglove_teleop import robot_scene
from ceres_bridge.robot_assets import asset_bytes, manifest, model_poses, visual_joint_origin
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
        expected = matrix(links[parent]) @ visual_joint_origin(camera, joint["xyz"], joint["rpy"])
        assert matrix(poses[camera]) == pytest.approx(expected)
    changed = dict(links)
    changed["Moving_Jaw"] = pose_dict(matrix(links["Moving_Jaw"]) @ transform(rpy=(0, 0, .5)))
    next_poses = model_poses(changed)
    assert next_poses["Fixed_Jaw"] == poses["Fixed_Jaw"]
    assert next_poses["Moving_Jaw"] == changed["Moving_Jaw"]


def test_top_mount_changes_only_the_visual_camera_attachment():
    before = json.dumps(manifest(), sort_keys=True)
    for joint in manifest()["joints"]:
        original = transform(joint["xyz"], joint["rpy"])
        actual = visual_joint_origin(joint["child"], joint["xyz"], joint["rpy"])
        if joint["child"] in ("Left_Arm_Camera", "Right_Arm_Camera"):
            assert joint["parent"] in ("Fixed_Jaw", "Fixed_Jaw_2")
            np.testing.assert_allclose(original[:3, 3], (0, -.02, .05), atol=1e-10)
            np.testing.assert_allclose(actual[:3, 3], (-.05, -.02, 0), atol=1e-10)
        else:
            np.testing.assert_allclose(actual, original, atol=1e-10)
    assert json.dumps(manifest(), sort_keys=True) == before


def camera_lens_axis():
    """Measure the front-facing lens/board plane from the actual black mesh."""
    content = asset_bytes(manifest()["models"]["Right_Arm_Camera"]["file"])
    json_length = struct.unpack_from("<I", content, 12)[0]
    gltf = json.loads(content[20:20 + json_length])
    binary = memoryview(content)[28 + json_length:]

    def accessor(index):
        record = gltf["accessors"][index]
        view = gltf["bufferViews"][record["bufferView"]]
        width = {"VEC3": 3, "SCALAR": 1}[record["type"]]
        dtype = {5126: "<f4", 5123: "<u2", 5125: "<u4"}[record["componentType"]]
        return np.frombuffer(binary, dtype=dtype, count=record["count"] * width,
                             offset=view.get("byteOffset", 0) + record.get("byteOffset", 0)).reshape(-1, width)

    node = next(node for node in gltf["nodes"] if node["name"] == "XLeRobot_camera2")
    primitive = gltf["meshes"][node["mesh"]]["primitives"][0]
    # Undo the packaged Y-up conversion before measuring camera-link geometry.
    vertices = accessor(primitive["attributes"]["POSITION"]) @ np.array(manifest()["gltf_from_link"])
    triangles = vertices[accessor(primitive["indices"]).reshape(-1, 3)]
    normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    areas = np.linalg.norm(normals, axis=1)
    normals /= areas[:, None]
    front = normals[:, 0] > .5
    directions, groups = np.unique(np.round(normals[front], 2), axis=0, return_inverse=True)
    dominant = np.argmax(np.bincount(groups, weights=areas[front], minlength=len(directions)))
    selected = groups == dominant
    direction = np.average(normals[front][selected], axis=0, weights=areas[front][selected])
    return direction / np.linalg.norm(direction)


@pytest.mark.parametrize("side,camera", [("left", "Left_Arm_Camera"), ("right", "Right_Arm_Camera")])
def test_top_camera_and_vertical_jaw_share_the_pronated_neutral_frame(side, camera):
    robot = DualArmTeleop()
    model = ArmModel(side)
    links = model.links(HOME)
    camera_pose = matrix(model_poses(robot.link_transforms())[camera])
    jaw = links["Fixed_Jaw" + model.suffix]
    np.testing.assert_allclose(camera_pose[:3, 3] - jaw[:3, 3], (.02, 0, .05), atol=1e-6)

    fixed_tip = model.forward(HOME)[:3, 3]
    moving_tip = (links["Moving_Jaw" + model.suffix] @ transform((-.01, -.073, 0)))[:3, 3]
    opening = moving_tip - fixed_tip
    assert opening[2] / np.linalg.norm(opening) > .99
    assert abs(opening[1]) < 1e-6

    lens = camera_lens_axis()
    np.testing.assert_allclose(lens, (.9063, -.4226, -.0074), atol=.001)
    optical = camera_pose[:3, :3] @ lens
    # The real camera looks forward and down from above the gripper.
    assert optical[0] > .9 and optical[2] < -.4 and abs(optical[1]) < .01


@pytest.mark.parametrize("roll", [-.7, .7])
def test_camera_mount_and_jaw_plane_roll_with_the_same_physical_joint(roll):
    model = ArmModel("right")
    neutral = model.links(HOME)
    q = HOME.copy()
    q[4] += roll
    rolled = model.links(q)
    neutral_poses = model_poses({name: pose_dict(value) for name, value in neutral.items()})
    rolled_poses = model_poses({name: pose_dict(value) for name, value in rolled.items()})
    for poses, links in ((neutral_poses, neutral), (rolled_poses, rolled)):
        local = np.linalg.inv(links["Fixed_Jaw"]) @ matrix(poses["Right_Arm_Camera"])
        np.testing.assert_allclose(local[:3, 3], (-.05, -.02, 0), atol=1e-10)
    turn = axis_rotation(-neutral["Fixed_Jaw"][:3, 1], roll)
    np.testing.assert_allclose(matrix(rolled_poses["Right_Arm_Camera"])[:3, :3],
                               turn @ matrix(neutral_poses["Right_Arm_Camera"])[:3, :3], atol=1e-10)
    np.testing.assert_allclose(rolled["Fixed_Jaw"][:3, 0], turn @ neutral["Fixed_Jaw"][:3, 0], atol=1e-10)


@pytest.mark.parametrize("offset", [0., .4])
def test_exported_urdf_embeds_actual_meshes_and_matches_every_scene_link_pose(offset):
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
    teleop = DualArmTeleop()
    for side, arm in teleop.arms.items():
        arm.q[[0, 4]] += offset if side == "left" else -offset
    positions = {name: float(value) for arm in teleop.arms.values()
                 for name, value in zip(arm.model.joint_names, arm.q)}
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

    expected = model_poses(teleop.link_transforms())
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
