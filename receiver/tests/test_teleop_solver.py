import math

import numpy as np
import pytest

from ceres_bridge.teleop_model import ArmModel, HOME, LOWER, UPPER, axis_rotation, rotation_vector


@pytest.mark.parametrize("position", [[.15, -.133, .846], [.34537, -.133, .8462]])
@pytest.mark.parametrize("pitch_degrees", [-90, -45, 180])
def test_conflicting_rotation_preserves_a_reachable_wrist_position(position, pitch_degrees):
    model = ArmModel("right")
    target = model.forward(HOME)
    target[:3, 3] = position
    q = model.solve(target, HOME, iterations=120)
    assert np.linalg.norm(model.forward(q)[:3, 3] - position) < .0002

    target[:3, :3] = (axis_rotation((0, 1, 0), math.radians(pitch_degrees))
                      @ axis_rotation((0, 0, 1), math.pi / 2))
    for _ in range(20):
        q = model.solve(target, q)
        assert np.linalg.norm(model.forward(q)[:3, 3] - position) <= .0002
        assert np.all(q >= LOWER) and np.all(q <= UPPER)
        assert q[5] == HOME[5]


@pytest.mark.parametrize("pan_degrees", [-120, -45, 45, 120])
def test_forward_target_recovers_from_large_shoulder_pan_seeds(pan_degrees):
    model = ArmModel("right")
    target = model.forward(np.zeros(6))
    target[:3, :3] = axis_rotation((0, 0, 1), math.pi / 2)
    q = HOME.copy()
    q[0] = math.radians(pan_degrees)
    for _ in range(30):
        q = model.solve(target, q)
    assert np.linalg.norm(model.forward(q)[:3, 3] - target[:3, 3]) < .0002
    assert abs(q[0]) < math.radians(2)
    assert np.linalg.norm(rotation_vector(target[:3, :3] @ model.forward(q)[:3, :3].T)) < math.radians(2)


def test_moving_reachable_targets_keep_pan_and_roll_continuous_with_default_budget():
    model = ArmModel("right")
    first = HOME.copy()
    first[0], first[4] = -.25, -.25
    first[1] += .05 * math.sin(-1)
    q = model.solve(model.forward(first), HOME, iterations=120)
    previous = q.copy()
    for value in np.linspace(-.25, .25, 81):
        desired = HOME.copy()
        desired[0], desired[4] = value, value
        desired[1] += .05 * math.sin(value * 4)
        target = model.forward(desired)
        q = model.solve(target, q)
        actual = model.forward(q)
        assert np.linalg.norm(actual[:3, 3] - target[:3, 3]) <= .0002
        assert np.linalg.norm(rotation_vector(target[:3, :3] @ actual[:3, :3].T)) < .01
        assert np.max(np.abs(q[:5] - previous[:5])) < .03
        assert q[0] >= previous[0] - .001
        assert q[4] >= previous[4] - .001
        previous = q
    assert q[0] == pytest.approx(.25, abs=.002)
    assert q[4] == pytest.approx(.25, abs=.005)


def test_unreachable_position_stays_within_one_tolerance_of_its_best_pose():
    model = ArmModel("right")
    # Keep the held world target independent of the starting neutral posture.
    target = model.forward(np.array((0., 1., 1.5, -.5, 0., .8)))
    target[:3, 3] += [1, 0, 0]
    target[:3, :3] = axis_rotation((0, 1, 0), math.pi)
    q = HOME.copy()
    best_error = np.linalg.norm(model.forward(q)[:3, 3] - target[:3, 3])
    for _ in range(20):
        q = model.solve(target, q)
        error = np.linalg.norm(model.forward(q)[:3, 3] - target[:3, 3])
        assert error <= best_error + .0002
        assert np.all(q >= LOWER) and np.all(q <= UPPER)
        best_error = min(best_error, error)
    assert abs(q[0]) < .02
    assert best_error < .97


@pytest.mark.parametrize("extension", [.005, .015])
def test_held_unreachable_target_accepts_wrist_roll_without_accumulating_position_drift(extension):
    model = ArmModel("right")
    target = model.forward(np.zeros(6))
    target[0, 3] += extension
    q = HOME.copy()
    best_error = math.inf
    for _ in range(60):
        q = model.solve(target, q)
        best_error = min(best_error, np.linalg.norm(target[:3, 3] - model.forward(q)[:3, 3]))
    assert best_error > .001
    initial = q.copy()
    original_rotation = model.forward(q)[:3, :3]
    target[:3, :3] = axis_rotation((1, 0, 0), math.pi / 6) @ original_rotation
    for _ in range(120):
        q = model.solve(target, q)
        assert np.linalg.norm(target[:3, 3] - model.forward(q)[:3, 3]) <= best_error + .0002
    assert math.degrees(q[4] - initial[4]) > 25
    assert np.linalg.norm(rotation_vector(target[:3, :3] @ model.forward(q)[:3, :3].T)) < math.radians(5)

    # Changing orientation repeatedly must not grant another position allowance.
    for degrees in (90, -45, 120, -90, 30, 0):
        target[:3, :3] = axis_rotation((1, 0, 0), math.radians(degrees)) @ original_rotation
        for _ in range(24):
            q = model.solve(target, q)
            assert np.linalg.norm(target[:3, 3] - model.forward(q)[:3, 3]) <= best_error + .0002
            assert np.all(q >= LOWER) and np.all(q <= UPPER)


def test_changed_position_target_gets_its_own_closest_pose_reference():
    model = ArmModel("right")
    target = model.forward(np.zeros(6))
    target[0, 3] += .005
    q = HOME.copy()
    for _ in range(60):
        q = model.solve(target, q)

    target[0, 3] += .025
    for _ in range(60):
        q = model.solve(target, q)
    before = q.copy()
    pose = model.forward(q)
    baseline_error = np.linalg.norm(target[:3, 3] - pose[:3, 3])
    assert baseline_error > .02
    target[:3, :3] = axis_rotation((1, 0, 0), math.pi / 6) @ pose[:3, :3]
    for _ in range(120):
        q = model.solve(target, q)
        assert np.linalg.norm(target[:3, 3] - model.forward(q)[:3, 3]) <= baseline_error + .0002
    assert math.degrees(q[4] - before[4]) > 25

    target = model.forward(HOME)
    for _ in range(30):
        q = model.solve(target, q)
    assert np.linalg.norm(target[:3, 3] - model.forward(q)[:3, 3]) <= .0002
