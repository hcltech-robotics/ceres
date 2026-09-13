"""Exercise the real Placo/Pinocchio solver against the pinned arm geometry."""

import math
import xml.etree.ElementTree as ET

import numpy as np
import pytest

from ceres_bridge.teleop_model import ArmModel, HOME, LOWER, UPPER, axis_rotation, rotation_vector
from ceres_bridge.teleop_solver import SO101Solver, arm_urdf


@pytest.mark.parametrize("side", ["left", "right"])
def test_meshless_placo_model_matches_published_arm_fk(side):
    model = ArmModel(side)
    solver = SO101Solver(model)
    description = ET.fromstring(arm_urdf(model))
    assert not description.findall(".//visual")
    assert not description.findall(".//collision")
    movable = [joint for joint in description.findall("joint") if joint.get("type") == "revolute"]
    assert [joint.get("name") for joint in movable] == model.joint_names[:5]
    rng = np.random.default_rng(20260912)
    for q in [HOME, LOWER, UPPER, *(LOWER + rng.random((12, 6)) * (UPPER - LOWER))]:
        solver._set(q)
        actual = np.asarray(solver.robot.get_T_world_frame(solver.tip))
        np.testing.assert_allclose(actual, model.forward(q), atol=2e-12, rtol=0)


@pytest.mark.parametrize("side", ["left", "right"])
@pytest.mark.parametrize("joints", [
    (0, 2.8, 0, 0, 0, .8),
    (.8, 2.8, .5, -.5, 0, .8),
    (-.8, 3.4, 1.3, .5, .8, .8),
    (0, 0, 2.5, 0, 0, .8),
    (1.8, .7, 1.3, -1.2, -2.5, .8),
])
def test_reachable_workspace_branches_converge_with_default_budget(side, joints):
    model = ArmModel(side)
    solver = SO101Solver(model)
    target = model.forward(np.array(joints))
    # The numerical solver keeps its own solution even while the physical
    # command is still travelling from HOME through the trajectory generator.
    q = solver.solve(target, HOME)
    actual = model.forward(q)
    assert np.linalg.norm(actual[:3, 3] - target[:3, 3]) < .0002
    assert np.linalg.norm(rotation_vector(target[:3, :3] @ actual[:3, :3].T)) < .001
    assert np.all(q >= LOWER) and np.all(q <= UPPER)


def test_continuous_upward_path_keeps_the_closest_joint_branch():
    model = ArmModel("right")
    solver = SO101Solver(model)
    previous = None
    for phase in np.linspace(0, math.pi, 181):
        goal = HOME + (1 - math.cos(phase)) / 2 * (np.array((.5, 2.8, .5, -.5, .5, .8)) - HOME)
        target = model.forward(goal)
        q = solver.solve(target, HOME)
        actual = model.forward(q)
        assert np.linalg.norm(actual[:3, 3] - target[:3, 3]) < .0002
        assert np.linalg.norm(rotation_vector(target[:3, :3] @ actual[:3, :3].T)) < .001
        if previous is not None:
            assert np.max(np.abs(q - previous)) < .03
        previous = q


def workspace_joints():
    """Cover the arm's pitch/elbow range and independently sampled joint poses."""
    result = [HOME.copy()]
    for pitch in (0.0, .7, 1.3, 2.0, 2.8, 3.4):
        for elbow in (0.0, 1.3, 2.5):
            result.append(np.array((0.0, pitch, elbow, 0.0, 0.0, .8)))
    rng = np.random.default_rng(20260912)
    for _ in range(13):
        q = LOWER + (.05 + .9 * rng.random(6)) * (UPPER - LOWER)
        q[5] = HOME[5]
        result.append(q)
    return result


@pytest.mark.parametrize("joints", workspace_joints(), ids=lambda q: ",".join(f"{value:.2f}" for value in q[:5]))
@pytest.mark.parametrize("orientation", ["pronated", "off_axis"])
def test_reachable_positions_remain_reachable_with_infeasible_hand_rotation(joints, orientation):
    model = ArmModel("right")
    solver = SO101Solver(model)
    target = model.forward(joints)
    target[:3, :3] = (model.forward(HOME)[:3, :3] if orientation == "pronated"
                      else axis_rotation((0, 0, 1), .12) @ target[:3, :3])
    for _ in range(30):
        q = solver.solve(target, HOME)
    assert np.linalg.norm(model.forward(q)[:3, 3] - target[:3, 3]) < .0002
    assert np.all(q >= LOWER) and np.all(q <= UPPER)


@pytest.mark.parametrize("orientation", ["pronated", "off_axis"])
def test_continuous_upward_positions_with_infeasible_hand_rotation(orientation):
    model = ArmModel("right")
    solver = SO101Solver(model)
    for phase in np.linspace(0, math.pi, 181):
        goal = HOME + (1 - math.cos(phase)) / 2 * (np.array((.5, 2.8, .5, -.5, .5, .8)) - HOME)
        target = model.forward(goal)
        target[:3, :3] = (model.forward(HOME)[:3, :3] if orientation == "pronated"
                          else axis_rotation((0, 0, 1), .12) @ target[:3, :3])
        q = solver.solve(target, HOME)
        assert np.linalg.norm(model.forward(q)[:3, 3] - target[:3, 3]) < .0002


def test_held_unreachable_target_does_not_repeat_branch_search_for_tracking_jitter(monkeypatch):
    model = ArmModel("right")
    solver = SO101Solver(model)
    target = model.forward(HOME)
    target[0, 3] += 1
    recover = solver._recover_position
    searches = []

    def record_search(q, pose, distance):
        searches.append(pose[:3, 3].copy())
        return recover(q, pose, distance)

    monkeypatch.setattr(solver, "_recover_position", record_search)
    for index in range(80):
        noisy = target.copy()
        noisy[0, 3] += 1e-6 * (index % 2)
        solver.solve(noisy, HOME)
    assert len(searches) == 1


def slow_positional_branches():
    rng = np.random.default_rng(713)
    for index in range(100):
        q = LOWER + (.03 + .94 * rng.random(6)) * (UPPER - LOWER)
        axis = rng.normal(size=3)
        axis /= np.linalg.norm(axis)
        rotation = axis_rotation(axis, rng.uniform(-3.14, 3.14))
        if index in (23, 57, 81):
            yield q, rotation


@pytest.mark.parametrize("joints,rotation", tuple(slow_positional_branches()))
def test_slow_positional_branches_recover_before_waiting_for_an_exact_stall(joints, rotation):
    model = ArmModel("right")
    solver = SO101Solver(model)
    target = model.forward(joints)
    target[:3, :3] = rotation
    for _ in range(30):
        q = solver.solve(target, HOME)
    assert np.linalg.norm(model.forward(q)[:3, 3] - target[:3, 3]) < .0002


@pytest.mark.parametrize("jitter", [0.0, .002])
def test_held_absolute_orientation_recovers_after_translation_with_tracking_noise(jitter):
    model = ArmModel("right")
    solver = SO101Solver(model)
    neutral = model.forward(HOME)
    destination = np.array((0, 2.8, 0, 0, 0, .8))
    for phase in np.linspace(0, 2 * math.pi, 481):
        goal = HOME + (1 - math.cos(phase)) / 2 * (destination - HOME)
        target = model.forward(goal)
        target[:3, :3] = neutral[:3, :3]
        solver.solve(target, HOME)
    for index in range(120):
        target = neutral.copy()
        target[:3, 3] += jitter * np.array((math.sin(index * .37), math.sin(index * .53), math.sin(index * .71)))
        q = solver.solve(target, HOME)
    actual = model.forward(q)
    assert solver.position_held
    assert np.linalg.norm(actual[:3, 3] - target[:3, 3]) < .0002
    assert np.linalg.norm(rotation_vector(neutral[:3, :3] @ actual[:3, :3].T)) < math.radians(2)


def test_held_wrist_pitch_steps_return_to_the_absolute_neutral_orientation():
    model = ArmModel("right")
    solver = SO101Solver(model)
    neutral = model.forward(HOME)
    for degrees in (0, 20, 0, -20, 0):
        target = neutral.copy()
        target[:3, :3] = axis_rotation((0, 1, 0), math.radians(degrees)) @ neutral[:3, :3]
        for _ in range(120):
            q = solver.solve(target, HOME)
        actual = model.forward(q)
        assert np.linalg.norm(actual[:3, 3] - target[:3, 3]) < .0002
        assert np.linalg.norm(rotation_vector(target[:3, :3] @ actual[:3, :3].T)) < math.radians(2)


def test_reset_restarts_warm_state_and_rejects_invalid_inputs():
    model = ArmModel("right")
    solver = SO101Solver(model)
    target = model.forward(HOME)
    solver.solve(target, HOME)
    solver.reset()
    assert solver.solution is None
    solver.reset(HOME)
    np.testing.assert_array_equal(solver.solution, HOME)
    for invalid_seed in (np.zeros(5), np.full(6, math.nan)):
        with pytest.raises(ValueError, match="finite joint"):
            solver.reset(invalid_seed)
    for iterations in (0, 257, 1.5):
        with pytest.raises(ValueError, match="iterations"):
            solver.solve(target, HOME, iterations=iterations)
    for bad_target in (np.zeros((3, 3)), np.full((4, 4), np.nan)):
        with pytest.raises(ValueError, match="finite target"):
            solver.solve(bad_target, HOME)
    with pytest.raises(ValueError, match="finite target"):
        solver.solve(target, np.full(6, math.inf))
