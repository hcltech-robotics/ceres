import math
import xml.etree.ElementTree as ET

import numpy as np
import pytest

from ceres_bridge.teleop import DualArmTeleop, wrist_transform
from ceres_bridge.teleop_model import (ArmModel, HOME, LOWER, UPPER, axis_rotation,
                                      matrix_quaternion, quaternion_matrix, robot_urdf, rotation_vector, transform)


def snapshot(sequence=1, left=(0, 1, -.4), right=(.2, 1, -.4), quaternion=(0, 0, 0, 1)):
    poses = {}
    for kind, position in (("2", left), ("3", right)):
        values = [0.] * 200
        values[:8] = [*position, *quaternion, .01]
        poses[kind] = {"fresh": True, "tracked": True, "pose": {
            "sequence": sequence, "joint_mask": 1, "values": values}}
    return {"epoch": 1, "space_epoch": 1, "connection": "connected", "poses": poses}


def test_rotation_half_turn_and_quaternion_sign_are_equivalent():
    expected = axis_rotation((0, 1, 0), math.pi)
    quaternion = matrix_quaternion(expected)
    np.testing.assert_allclose(quaternion_matrix(quaternion), expected, atol=1e-10)
    np.testing.assert_allclose(quaternion_matrix(-quaternion), expected, atol=1e-10)
    assert np.linalg.norm(rotation_vector(expected)) == pytest.approx(math.pi)


def test_analytic_jacobian_matches_finite_difference():
    for side in ("left", "right"):
        model = ArmModel(side)
        pose, jacobian = model.forward(HOME, jacobian=True)
        for joint in range(5):
            q = HOME.copy()
            q[joint] += 1e-6
            moved = model.forward(q)
            numerical = np.r_[(moved[:3, 3] - pose[:3, 3]) / 1e-6,
                              rotation_vector(moved[:3, :3] @ pose[:3, :3].T) / 1e-6]
            np.testing.assert_allclose(jacobian[:, joint], numerical, atol=2e-6)


def test_published_urdf_forward_kinematics_matches_core():
    tree = ET.fromstring(robot_urdf())
    for side in ("left", "right"):
        model = ArmModel(side)
        q = dict(zip(model.joint_names, HOME))
        transforms = {"ceres_robot_base": np.eye(4)}
        # Read the URDF as a consumer would and evaluate its RPY origins.
        for joint in tree.findall("joint"):
            parent = joint.find("parent").get("link")
            if parent not in transforms:
                continue
            origin = joint.find("origin")
            xyz = np.fromstring(origin.get("xyz"), sep=" ")
            roll, pitch, yaw = np.fromstring(origin.get("rpy"), sep=" ")
            cr, sr, cp, sp, cy, sy = math.cos(roll), math.sin(roll), math.cos(pitch), math.sin(pitch), math.cos(yaw), math.sin(yaw)
            local = np.eye(4)
            local[:3, :3] = [[cy*cp, cy*sp*sr-sy*cr, cy*sp*cr+sy*sr],
                             [sy*cp, sy*sp*sr+cy*cr, sy*sp*cr-cy*sr], [-sp, cp*sr, cp*cr]]
            local[:3, 3] = xyz
            if joint.get("type") == "revolute":
                axis = np.fromstring(joint.find("axis").get("xyz"), sep=" ")
                turn = np.eye(4)
                turn[:3, :3] = axis_rotation(axis, q.get(joint.get("name"), 0))
                local = local @ turn
            transforms[joint.find("child").get("link")] = transforms[parent] @ local
        np.testing.assert_allclose(transforms["Fixed_Jaw_tip" + model.suffix], model.forward(HOME), atol=1e-10)
    # Upstream bases are 266 mm apart along robot Y.
    left, right = ArmModel("left").forward(HOME), ArmModel("right").forward(HOME)
    np.testing.assert_allclose(left[:3, 3] - right[:3, 3], (0, .266, 0), atol=1e-10)


def test_ik_recovers_reachable_pose_and_respects_limits():
    model = ArmModel("right")
    goal = HOME.copy()
    goal[:5] += [.06, -.08, .1, .04, -.07]
    target = model.forward(goal)
    solved = model.solve(target, HOME, iterations=40)
    achieved = model.forward(solved)
    assert np.linalg.norm(target[:3, 3] - achieved[:3, 3]) < .0005
    assert np.linalg.norm(rotation_vector(target[:3, :3] @ achieved[:3, :3].T)) < .01
    target[:3, 3] = (100, -100, 100)
    solved = model.solve(target, HOME)
    assert np.all(solved >= LOWER) and np.all(solved <= UPPER)


def test_both_arms_follow_absolute_goals_and_continue_servo_between_samples():
    teleop = DualArmTeleop()
    initial = teleop.update(snapshot(), now_ns=1_000_000_000)
    moved = snapshot(2, left=(.025, 1.01, -.42), right=(.18, 1.02, -.41))
    result = teleop.update(moved, now_ns=1_020_000_000)
    assert result["updated"]
    for side in ("left", "right"):
        assert result["arms"][side]["joint_positions"] != initial["arms"][side]["joint_positions"]
    repeat = teleop.update(moved, now_ns=1_040_000_000)
    assert repeat["updated"]
    for side in ("left", "right"):
        assert repeat["arms"][side]["target"] == result["arms"][side]["target"]
    assert repeat["joint_positions"] != result["joint_positions"]
    assert len(teleop.link_transforms()) == 16


@pytest.mark.parametrize("gap", ["untracked", "stale", "missing", "space", "epoch", "disconnected", "invalid_wrist", "polling_pause", "reset"])
def test_gap_or_reset_preserves_absolute_target_mapping_and_limits_motion(gap):
    mapping = transform((.15, 0, -.35), (0, 0, .3))
    teleop = DualArmTeleop(robot_from_ceres=mapping)
    teleop.update(snapshot(), now_ns=1_000_000_000)
    before = teleop.update(snapshot(2, left=(.02, 1, -.41)), now_ns=1_020_000_000)
    middle = snapshot(3)
    future = snapshot(4, left=(.12, 1.1, -.43))
    when = 1_060_000_000
    if gap in ("untracked", "stale", "invalid_wrist"):
        if gap == "invalid_wrist":
            middle["poses"]["2"]["pose"]["joint_mask"] = 0
        else:
            middle["poses"]["2"]["tracked" if gap == "untracked" else "fresh"] = False
    elif gap == "missing":
        middle["poses"].pop("2")
    elif gap in ("space", "epoch"):
        key = "space_epoch" if gap == "space" else "epoch"
        middle[key] = future[key] = 2
        middle["poses"] = {}
    elif gap == "disconnected":
        middle["connection"] = "waiting"
    elif gap == "polling_pause":
        when += 200_000_000
    elif gap == "reset":
        teleop.reset()
    if gap not in ("reset", "polling_pause"):
        held = teleop.update(middle, now_ns=1_040_000_000)
        if gap not in ("space", "epoch"):
            assert held["arms"]["left"]["target"] == before["arms"]["left"]["target"]
            assert held["arms"]["left"]["status"] == "coasting"
        before = held
    after = teleop.update(future, now_ns=when)
    assert after["arms"]["left"]["tracked"]
    assert after["arms"]["left"]["status"] in ("tracking", "limited")
    wrist = wrist_transform(future["poses"]["2"]["pose"])
    wrist[:3, 3] *= teleop.position_scale
    wrist[:3, :3] = wrist[:3, :3] @ axis_rotation((0, 0, 1), math.pi / 2)
    np.testing.assert_allclose(teleop.arms["left"].target, mapping @ wrist, atol=1e-10)
    difference = np.array(after["arms"]["left"]["joint_positions"]) - before["arms"]["left"]["joint_positions"]
    assert np.all(np.abs(difference) <= teleop.max_joint_speed * .05 + 1e-10)


def test_tracking_grace_continues_last_goal_then_both_arms_return_to_neutral():
    teleop = DualArmTeleop(tracking_grace=.5)
    for sequence in range(1, 31):
        result = teleop.update(snapshot(sequence), now_ns=1_000_000_000 + sequence * 20_000_000)
    last = teleop.update(snapshot(31, left=(.6, 1.6, -.8), right=(-.6, 1.6, -.8)), now_ns=1_620_000_000)
    lost = {"epoch": 1, "space_epoch": 1, "connection": "connected", "poses": {}}
    coast = teleop.update(lost, now_ns=1_640_000_000)
    assert coast["joint_positions"] != last["joint_positions"]
    for side in ("left", "right"):
        assert coast["arms"][side]["status"] == "coasting"
        assert not coast["arms"][side]["tracked"]
        assert coast["arms"][side]["target"] == last["arms"][side]["target"]
    before = teleop.update(lost, now_ns=2_120_000_000)
    assert all(arm["status"] == "coasting" for arm in before["arms"].values())
    for step in range(1, 201):
        result = teleop.update(lost, now_ns=2_120_000_000 + step * 20_000_000)
        for side in ("left", "right"):
            old = np.array(before["arms"][side]["joint_positions"])
            current = np.array(result["arms"][side]["joint_positions"])
            assert np.all(np.abs(current - old) <= teleop.max_joint_speed * .02 + 1e-10)
            assert np.all(np.abs(current - HOME) <= np.abs(old - HOME) + 1e-10)
        before = result
    for arm in result["arms"].values():
        np.testing.assert_allclose(arm["joint_positions"], HOME, atol=1e-10)
        assert arm["status"] == "neutral"
    resumed_sample = snapshot(32, left=(.2, 1.1, -.35), right=(-.2, 1.1, -.35))
    resumed = teleop.update(resumed_sample, now_ns=6_140_000_000)
    for side, kind in (("left", "2"), ("right", "3")):
        expected = wrist_transform(resumed_sample["poses"][kind]["pose"])
        expected[:3, 3] *= teleop.position_scale
        expected[:3, :3] = expected[:3, :3] @ axis_rotation((0, 0, 1), math.pi / 2)
        np.testing.assert_allclose(teleop.arms[side].target, expected, atol=1e-10)
        assert resumed["arms"][side]["tracked"]


def test_one_lost_hand_does_not_disengage_the_other_arm():
    teleop = DualArmTeleop()
    for sequence in range(1, 41):
        sample = snapshot(sequence)
        if sequence > 1:
            sample["poses"].pop("2")
        result = teleop.update(sample, now_ns=1_000_000_000 + sequence * 20_000_000)
    assert not result["arms"]["left"]["tracked"]
    assert result["arms"]["left"]["status"] in ("returning", "neutral")
    assert result["arms"]["right"]["tracked"]
    assert result["arms"]["right"]["status"] in ("tracking", "limited")


def test_limits_and_speed_hold_for_large_translation_and_rotation():
    speed = .5
    teleop = DualArmTeleop(max_joint_speed=speed)
    previous = teleop.update(snapshot(), now_ns=1_000_000_000)
    for sequence in range(2, 32):
        current = teleop.update(snapshot(sequence, left=(4, -3, 8), quaternion=(0, 1, 0, 0)),
                               now_ns=1_000_000_000 + (sequence - 1) * 20_000_000)
        q = np.array(current["joint_positions"])
        assert np.all(np.abs(q - previous["joint_positions"]) <= speed * .02 + 1e-10)
        assert np.all(q >= np.tile(LOWER, 2)) and np.all(q <= np.tile(UPPER, 2))
        previous = current


def test_absolute_pose_uses_fixed_registration_on_first_sample_and_after_rotation():
    mapping = transform((.1, -.2, .3), (.1, -.2, .3))
    teleop = DualArmTeleop(position_scale=.75, robot_from_ceres=mapping)
    initial_q = matrix_quaternion(axis_rotation((1, 0, 0), .4))
    next_q = matrix_quaternion(axis_rotation((0, 1, 0), .2) @ quaternion_matrix(initial_q))
    first = snapshot(quaternion=initial_q)
    second = snapshot(2, quaternion=next_q)
    teleop.update(first, now_ns=1_000_000_000)
    first_wrist = wrist_transform(first["poses"]["2"]["pose"])
    first_wrist[:3, 3] *= .75
    first_wrist[:3, :3] = first_wrist[:3, :3] @ axis_rotation((0, 0, 1), math.pi / 2)
    np.testing.assert_allclose(teleop.arms["left"].target, mapping @ first_wrist, atol=1e-10)
    initial_position = teleop.arms["left"].target[:3, 3].copy()
    teleop.update(second, now_ns=1_020_000_000)
    wrist = wrist_transform(second["poses"]["2"]["pose"])
    wrist[:3, 3] *= .75
    wrist[:3, :3] = wrist[:3, :3] @ axis_rotation((0, 0, 1), math.pi / 2)
    np.testing.assert_allclose(teleop.arms["left"].target, mapping @ wrist, atol=1e-10)
    np.testing.assert_allclose(teleop.arms["left"].target[:3, 3], initial_position, atol=1e-10)


def test_same_absolute_wrist_pose_has_same_goal_regardless_of_motion_history():
    direct, travelled = DualArmTeleop(), DualArmTeleop()
    destination = snapshot(20, left=(.1, 1.2, -.3), right=(-.1, 1.2, -.3))
    direct.update(destination, now_ns=1_000_000_000)
    for sequence in range(1, 20):
        travelled.update(snapshot(sequence, left=(.2 + sequence * .01, .9, -.5)),
                         now_ns=600_000_000 + sequence * 20_000_000)
    travelled.update(destination, now_ns=1_000_000_000)
    for side in ("left", "right"):
        np.testing.assert_allclose(travelled.arms[side].target, direct.arms[side].target, atol=1e-10)


@pytest.mark.parametrize("wrist_rpy", [(0, 0, 0), (.6, -.3, .4), (-.2, .7, -.5)])
def test_tool_approach_follows_fingers_without_rotating_the_position(wrist_rpy):
    wrist_rotation = transform(rpy=wrist_rpy)[:3, :3]
    q = matrix_quaternion(wrist_rotation)
    # Invert the WebXR-to-ROS basis conversion for a controlled wrist input.
    xr_quaternion = (-q[1], q[2], -q[0], q[3])
    mapping = transform((.1, -.2, .3), (.2, -.1, .5))
    teleop = DualArmTeleop(robot_from_ceres=mapping)
    sample = snapshot(quaternion=xr_quaternion)
    teleop.update(sample, now_ns=1_000_000_000)
    for side, kind in (("left", "2"), ("right", "3")):
        target = teleop.arms[side].target
        # The actual tool approaches along -Y. The converted hand points +X.
        np.testing.assert_allclose(-target[:3, 1], mapping[:3, :3] @ wrist_rotation[:, 0], atol=1e-10)
        np.testing.assert_allclose(target[:3, 2], mapping[:3, :3] @ wrist_rotation[:, 2], atol=1e-10)
        measured = wrist_transform(sample["poses"][kind]["pose"])
        expected_position = mapping[:3, 3] + mapping[:3, :3] @ (teleop.position_scale * measured[:3, 3])
        np.testing.assert_allclose(target[:3, 3], expected_position, atol=1e-10)


@pytest.mark.parametrize("roll", [0, math.pi / 2, -math.pi / 2])
def test_straight_outstretched_hand_keeps_the_right_shoulder_centred(roll):
    model = ArmModel("right")
    forward_point = model.forward(np.zeros(6))[:3, 3]
    xr_position = (-forward_point[1], forward_point[2], -forward_point[0])
    # A hand pointing along robot +X, with independent palm roll.
    q = matrix_quaternion(axis_rotation((1, 0, 0), roll))
    xr_quaternion = (-q[1], q[2], -q[0], q[3])
    teleop = DualArmTeleop(position_scale=1)
    for sequence in range(1, 91):
        teleop.update(snapshot(sequence, right=xr_position, quaternion=xr_quaternion),
                      now_ns=1_000_000_000 + sequence * 20_000_000)
    arm = teleop.arms["right"]
    achieved = model.forward(arm.q)
    assert abs(arm.q[0]) < math.radians(3)
    assert np.linalg.norm(achieved[:3, 3] - forward_point) < .002
    assert float(-achieved[0, 1]) > .998


@pytest.mark.parametrize("mapping", [np.eye(3), np.zeros((4, 4)), np.diag((2, 1, 1, 1)),
                                     np.diag((-1, 1, 1, 1)), np.full((4, 4), np.nan)])
def test_robot_registration_rejects_non_rigid_transforms(mapping):
    with pytest.raises(ValueError, match="rigid transform"):
        DualArmTeleop(robot_from_ceres=mapping)


def test_actual_isaacteleop_adapter_matches_cpu_wrist_geometry():
    pytest.importorskip("isaacteleop")
    pytest.importorskip("scipy")
    cpu, isaac = DualArmTeleop(), DualArmTeleop(backend="isaacteleop")
    for sequence in range(1, 6):
        q = matrix_quaternion(axis_rotation((0, 1, 0), .025 * sequence))
        sample = snapshot(sequence, left=(.01 * sequence, 1, -.4), quaternion=q)
        now = 1_000_000_000 + 20_000_000 * sequence
        expected, actual = cpu.update(sample, now_ns=now), isaac.update(sample, now_ns=now)
        np.testing.assert_allclose(actual["joint_positions"], expected["joint_positions"], atol=2e-5)
