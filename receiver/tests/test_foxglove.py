import pytest

pytest.importorskip("foxglove")
from ceres_bridge.foxglove_output import scene
from ceres_bridge.foxglove_scene import camera_calibration, joints, transforms, StreamMetrics
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory
from foxglove import messages as m


def decode(message):
    schema = message.get_schema()
    descriptors = descriptor_pb2.FileDescriptorSet.FromString(schema.data)
    pool = descriptor_pool.DescriptorPool()
    pending = list(descriptors.file)
    while pending:
        previous = len(pending)
        for descriptor in list(pending):
            try:
                pool.Add(descriptor)
                pending.remove(descriptor)
            except TypeError:
                pass
        assert len(pending) < previous
    cls = message_factory.GetMessageClass(pool.FindMessageTypeByName(schema.name))
    return cls.FromString(message.encode())


def test_scene_accepts_head_and_joint_positions_in_the_sdk_schema():
    snapshot = {"poses": {
        "1": {"tracked": True, "pose": {"values": [1, 2, 3, 0, 0, 0, 1]}},
        "2": {"tracked": True, "pose": {"joint_mask": (1 << 25) - 1,
              "values": [1, 2, 3, 0, 0, 0, 1, 0.01] * 25}},
        "3": {"tracked": False, "pose": None},
    }}
    update = scene(snapshot, 1_000_000_001)
    encoded = update.encode()
    assert encoded.count(b"ceres_origin") == 2
    assert len(encoded) > len(scene({"poses": {}}, 1_000_000_001).encode())
    decoded = decode(update)
    assert decoded.entities[0].cubes[0].pose.position.x == -3
    assert len(decoded.entities[1].spheres) == 25
    assert len(decoded.entities[1].lines[0].points) == 48
    assert len(decode(scene({"poses": {}}, 2)).entities) == 0


def test_tracking_loss_has_explicit_joint_validity():
    data = joints({"tracked": False, "pose": None})
    assert len(data["joints"]) == 25
    assert data["valid_joints"] == 0
    assert all(not joint["tracked"] and joint["pose"] is None for joint in data["joints"])


def test_mesh_updates_replace_entities_without_deleting_them_between_samples():
    head = {"tracked": True, "pose": {"values": [0, 1.5, 0, 0, 0, 0, 1]}}
    update = decode(scene({"poses": {"1": head}}, 100))
    assert not update.deletions
    assert update.entities[0].lifetime.nanos == 250_000_000
    # A temporarily unavailable fresh sample leaves the previous entity to expire.
    gap = decode(scene({"poses": {"1": {"tracked": False, "pose": None}}}, 200))
    assert not gap.deletions and not gap.entities
    # A source observation explicitly reporting tracking loss removes it now.
    head["tracked"] = False
    loss = decode(scene({"poses": {"1": head}}, 300))
    assert [deletion.id for deletion in loss.deletions] == ["head"]
    stopped = decode(scene({"connection": "waiting", "poses": {}}, 400))
    assert sorted(deletion.id for deletion in stopped.deletions) == ["head", "left", "right"]


def test_player_camera_preset_and_optical_transform():
    calibration = decode(camera_calibration(640, 480, 100))
    assert list(calibration.K) == pytest.approx([640/1.62, 0, 320, 0, 640/1.62, 240, 0, 0, 1])
    data = decode(transforms({"poses": {}, "description": {"camera": {"side": "right"}}}, 100))
    camera = data.transforms[-1]
    assert camera.parent_frame_id == "ceres_head"
    assert camera.child_frame_id == "ceres_camera_optical"
    assert camera.translation.x == pytest.approx(.035)
    assert camera.translation.y == pytest.approx(-.064)
    assert camera.translation.z == pytest.approx(-.03)
    assert sum(getattr(camera.rotation, axis)**2 for axis in "xyzw") == pytest.approx(1)


def test_metrics_count_unique_samples_and_become_zero_when_paused():
    metrics = StreamMetrics()
    snapshot = {"epoch": 1, "space_epoch": 1, "now_us": 0, "counts": {"frames": 0},
                "poses": {"1": {"pose": {"sequence": 1}}}}
    assert metrics.observe(snapshot) == ["1"]
    assert metrics.observe(snapshot) == []
    snapshot["now_us"] = 1_000_000
    snapshot["counts"]["frames"] = 30
    metrics.observe(snapshot)
    assert metrics.rates["video_fps"] == 30
    assert metrics.rates["motion_fps"] == 1
    snapshot["now_us"] = 2_000_000
    metrics.observe(snapshot)
    assert metrics.rates["video_fps"] == metrics.rates["motion_fps"] == 0
