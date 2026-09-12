import math

import pytest

pytest.importorskip("foxglove")

from ceres_bridge.coordinates import ros_orientation, ros_position
from ceres_bridge.foxglove_scene import converted_pose, scene, transforms
from test_foxglove import decode


@pytest.mark.parametrize("rotation", [(0, 0, 0, 1), (math.sin(.3), 0, 0, math.cos(.3))])
def test_headset_mesh_has_local_clockwise_yaw_without_rotating_tracking(rotation):
    values = [1, 2, 3, *rotation]
    snapshot = {"poses": {"1": {"tracked": True, "pose": {"values": values}}}}
    entity = decode(scene(snapshot, 100, model_url="http://localhost/quest-3.glb")).entities[0]
    visual = entity.models[0].pose
    x, y, z, w = ros_orientation(rotation)
    half = math.sqrt(.5)
    # q_head * q_z(-90 degrees), including a tilted head to distinguish order.
    expected = (half * (x - y), half * (x + y), half * (z - w), half * (w + z))
    assert tuple(getattr(visual.orientation, key) for key in "xyzw") == pytest.approx(expected)
    assert tuple(getattr(visual.position, key) for key in "xyz") == pytest.approx(ros_position(values))
    assert tuple(getattr(entity.models[0].scale, key) for key in "xyz") == pytest.approx((.6, .6, .6))
    assert not entity.cubes and not entity.arrows

    tracked = decode(converted_pose(values))
    frame = decode(transforms(snapshot, 100)).transforms[-1]
    fallback = decode(scene(snapshot, 100)).entities[0].arrows[0].pose
    for orientation in (tracked.orientation, frame.rotation, fallback.orientation):
        assert tuple(getattr(orientation, key) for key in "xyzw") == pytest.approx((x, y, z, w))
