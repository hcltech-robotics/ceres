import math

import pytest

pytest.importorskip("foxglove")

from ceres_bridge.coordinates import ros_orientation, ros_position
from ceres_bridge.foxglove_scene import converted_pose, quaternion_product, scene, transforms
from test_foxglove import decode


def components(quaternion):
    return tuple(getattr(quaternion, key) for key in "xyzw")


def rotated(quaternion, vector):
    conjugate = (-quaternion[0], -quaternion[1], -quaternion[2], quaternion[3])
    return quaternion_product(quaternion_product(quaternion, (*vector, 0)), conjugate)[:3]


HEAD_ROTATIONS = [(0, 0, 0, 1), (math.sin(.3), 0, 0, math.cos(.3)),
                  quaternion_product((0, math.sin(.4), 0, math.cos(.4)),
                                     (0, 0, math.sin(.2), math.cos(.2)))]


@pytest.mark.parametrize("rotation", HEAD_ROTATIONS)
def test_headset_mesh_front_and_up_match_tracking_after_foxglove_gltf_loading(rotation):
    values = [1, 2, 3, *rotation]
    snapshot = {"poses": {"1": {"tracked": True, "pose": {"values": values}}}}
    entity = decode(scene(snapshot, 100, model_url="http://localhost/quest-3.glb")).entities[0]
    visual = entity.models[0].pose
    tracked_rotation = ros_orientation(rotation)
    half = math.sqrt(.5)
    # Asset preparation applies Player's yaw and the WebXR-to-body basis, so
    # the prepared mesh has +X front/+Z up. Foxglove adds Rx(+90) while loading.
    rendered_rotation = quaternion_product(components(visual.orientation), (half, 0, 0, half))
    for axis in ((1, 0, 0), (0, 1, 0), (0, 0, 1)):
        assert rotated(rendered_rotation, axis) == pytest.approx(rotated(tracked_rotation, axis))
    assert tuple(getattr(visual.position, key) for key in "xyz") == pytest.approx(ros_position(values))
    assert tuple(getattr(entity.models[0].scale, key) for key in "xyz") == pytest.approx((.6, .6, .6))
    assert not entity.cubes and not entity.arrows

    tracked = decode(converted_pose(values))
    frame = decode(transforms(snapshot, 100)).transforms[-1]
    fallback = decode(scene(snapshot, 100)).entities[0].arrows[0].pose
    for orientation in (tracked.orientation, frame.rotation, fallback.orientation):
        assert components(orientation) == pytest.approx(tracked_rotation)


@pytest.mark.parametrize("rotation", HEAD_ROTATIONS)
@pytest.mark.parametrize("side,yaw", [("left", -math.pi / 30), ("right", math.pi / 30)])
def test_projected_camera_points_out_headset_front_with_upright_optical_axes(rotation, side, yaw):
    values = [1, 2, 3, *rotation]
    snapshot = {"poses": {"1": {"tracked": True, "pose": {"values": values}}},
                "description": {"camera": {"side": side}}}
    head, optical = decode(transforms(snapshot, 100)).transforms[-2:]
    visual = decode(scene(snapshot, 100, model_url="http://localhost/quest-3.glb")).entities[0].models[0].pose
    half = math.sqrt(.5)
    rendered = quaternion_product(components(visual.orientation), (half, 0, 0, half))
    world_optical = quaternion_product(components(head.rotation), components(optical.rotation))
    mesh_forward = rotated(rendered, (1, 0, 0))
    camera_forward = rotated(world_optical, (0, 0, 1))
    assert sum(a * b for a, b in zip(mesh_forward, camera_forward)) == pytest.approx(math.cos(yaw))
    assert rotated(components(optical.rotation), (0, 0, 1)) == pytest.approx((math.cos(yaw), math.sin(yaw), 0))
    assert rotated(components(optical.rotation), (1, 0, 0)) == pytest.approx((math.sin(yaw), -math.cos(yaw), 0))
    assert rotated(world_optical, (0, -1, 0)) == pytest.approx(rotated(rendered, (0, 0, 1)))

    # The side-specific camera origin and projection centre are both in front
    # of the headset centre. Model correction does not rotate those extrinsics.
    assert optical.translation.x == pytest.approx(.035)
    assert optical.translation.y == pytest.approx(.064 if side == "left" else -.064)
    assert optical.translation.z == pytest.approx(-.03)
    projection_centre_x = optical.translation.x + .216 * math.cos(yaw)
    assert projection_centre_x > .24
