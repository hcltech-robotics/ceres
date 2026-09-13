"""Actual Ruckig motion bounds for live target updates and tracking gaps."""

import numpy as np
import pytest

pytest.importorskip("ruckig")

from ceres_bridge.teleop_motion import JointMotion


def run(motion, goals, intervals):
    q, v, a = [motion.position], [motion.velocity], [motion.acceleration]
    for goal, dt in zip(goals, intervals):
        q.append(motion.step(goal, float(dt)))
        v.append(motion.velocity)
        a.append(motion.acceleration)
    return np.asarray(q), np.asarray(v), np.asarray(a)


def assert_bounds(q, v, a, dt, lower, upper, speed=2, acceleration=8, jerk=80):
    dt = np.asarray(dt)
    assert np.isfinite(q).all() and np.isfinite(v).all() and np.isfinite(a).all()
    assert np.all(q >= np.asarray(lower) - 1e-9) and np.all(q <= np.asarray(upper) + 1e-9)
    assert np.all(np.abs(v) <= np.asarray(speed) + 1e-8)
    assert np.all(np.abs(a) <= np.asarray(acceleration) + 1e-8)
    assert np.all(np.abs(np.diff(v, axis=0) / dt[:, None]) <= np.asarray(acceleration) + 1e-7)
    assert np.all(np.abs(np.diff(a, axis=0) / dt[:, None]) <= np.asarray(jerk) + 1e-7)
    chord_velocity = np.diff(q, axis=0) / dt[:, None]
    assert np.all(np.abs(chord_velocity) <= np.asarray(speed) + 1e-8)
    midpoint_dt = (dt[1:] + dt[:-1]) / 2
    assert np.all(np.abs(np.diff(chord_velocity, axis=0) / midpoint_dt[:, None]) <= np.asarray(acceleration) + 1e-7)


def test_fixed_target_settles_monotonically_with_measured_bounds():
    motion = JointMotion([0, 0], [-2, -2], [2, 2])
    dt = np.full(240, 1 / 60)
    q, v, a = run(motion, [[1, -.7]] * len(dt), dt)
    assert_bounds(q, v, a, dt, [-2, -2], [2, 2])
    assert np.all(np.diff(q[:, 0]) >= -1e-10)
    assert np.all(np.diff(q[:, 1]) <= 1e-10)
    np.testing.assert_allclose(q[-1], [1, -.7], atol=1e-10)
    np.testing.assert_allclose(v[-1], 0, atol=1e-10)
    np.testing.assert_allclose(a[-1], 0, atol=1e-10)
    assert motion.settled
    np.testing.assert_array_equal(q[-20:], np.tile(q[-1], (20, 1)))


def test_abrupt_reversal_retains_velocity_and_acceleration_continuity():
    motion = JointMotion([0], [-2], [2])
    dt = np.full(300, 1 / 60)
    q, v, a = run(motion, [[1.5]] * 18 + [[-1.5]] * 282, dt)
    assert_bounds(q, v, a, dt, [-2], [2])
    assert v[18, 0] > 0 and v[19, 0] > 0
    np.testing.assert_allclose(q[-1], [-1.5], atol=1e-9)
    assert motion.settled


def test_variable_intervals_reuse_online_trajectory_and_keep_finite_difference_bounds():
    motion = JointMotion([0, .2], [-2, -2], [2, 2], [1.5, 2], [6, 8], [60, 80])
    dt = np.resize([.004, .012, .026, .05, .016], 300)
    goals = [[1.2, -.8] if index < 37 else [-.9, 1.3] for index in range(len(dt))]
    q, v, a = run(motion, goals, dt)
    assert_bounds(q, v, a, dt, [-2, -2], [2, 2], [1.5, 2], [6, 8], [60, 80])
    np.testing.assert_allclose(q[-1], [-.9, 1.3], atol=1e-9)


def test_jittering_online_goals_remain_bounded_then_settle_without_residual_jitter():
    motion = JointMotion([0], [-1], [1])
    dt = np.full(480, 1 / 60)
    goals = [[.5 + .008 * np.sin(index * 1.7)] if index < 240 else [.5] for index in range(len(dt))]
    q, v, a = run(motion, goals, dt)
    assert_bounds(q, v, a, dt, [-1], [1])
    np.testing.assert_allclose(q[-20:], .5, atol=1e-12, rtol=0)
    assert np.ptp(q[-20:]) < 1e-12


def test_grace_then_neutral_goal_and_reacquisition_keep_motion_state():
    motion = JointMotion([0], [-2], [2])
    dt = np.full(300, 1 / 60)
    # Thirty repeated goal updates are the caller's 0.5 second grace. HOME and
    # the reacquired absolute target are ordinary goal changes, without reset.
    goals = [[1.5]] * 45 + [[0]] * 40 + [[-.8]] * 215
    q, v, a = run(motion, goals, dt)
    assert_bounds(q, v, a, dt, [-2], [2])
    assert abs(v[45, 0]) > .1
    np.testing.assert_allclose(q[-1], [-.8], atol=1e-9)


def test_near_joint_limits_retargets_preserve_continuous_position_bounds():
    motion = JointMotion([.099], [0], [.1])
    dt = np.full(360, .005)
    goals = [[0]] * 15 + [[.1]] * 25 + [[0]] * 25 + [[.1]] * 295
    q, v, a = run(motion, goals, dt)
    assert_bounds(q, v, a, dt, [0], [.1])
    np.testing.assert_allclose(q[-1], [.1], atol=1e-9)


def test_zero_dt_does_not_mutate_state():
    motion = JointMotion([0], [-1], [1])
    before = motion.step([.8], .02)
    velocity, acceleration = motion.velocity, motion.acceleration
    np.testing.assert_array_equal(motion.step([-.8], 0), before)
    np.testing.assert_array_equal(motion.velocity, velocity)
    np.testing.assert_array_equal(motion.acceleration, acceleration)


def test_coordinated_arm_progress_keeps_the_gripper_independent():
    coordinated = JointMotion([0, 0, 0], [-2] * 3, [2] * 3, independent_joints=(2,))
    independent = JointMotion([0, 0, 0], [-2] * 3, [2] * 3)
    goal = np.array([1., .25, .5])
    q, v, a, jaw = [], [], [], []
    for _ in range(120):
        q.append(coordinated.step(goal, 1 / 60, coordinate=True))
        v.append(coordinated.velocity)
        a.append(coordinated.acceleration)
        jaw.append(independent.step(goal, 1 / 60)[2])
    q = np.asarray(q)
    np.testing.assert_allclose(q[:, 0], q[:, 1] / .25, atol=1e-10)
    np.testing.assert_allclose(q[:, 2], jaw, atol=1e-10)
    assert_bounds(q, np.asarray(v), np.asarray(a), np.full(119, 1 / 60), [-2] * 3, [2] * 3)
    np.testing.assert_allclose(q[-1], goal, atol=1e-10)


def test_switching_coordination_during_reversals_preserves_limits_and_continuity():
    lower, upper = [-.1, -.1, 0], [.1, .1, 1]
    motion = JointMotion([.099, -.099, .2], lower, upper, independent_joints=(2,))
    q, v, a = [motion.position], [motion.velocity], [motion.acceleration]
    for index in range(360):
        goal = [-.1, .1, .8] if index < 50 or 100 <= index < 150 else [.1, -.1, .3]
        q.append(motion.step(goal, .005, coordinate=(index // 7) % 2 == 0))
        v.append(motion.velocity)
        a.append(motion.acceleration)
    assert_bounds(np.asarray(q), np.asarray(v), np.asarray(a), np.full(360, .005), lower, upper)
    np.testing.assert_allclose(q[-1], [.1, -.1, .3], atol=1e-9)


@pytest.mark.parametrize("dt", [-.01, .051, float("inf"), float("nan")])
def test_invalid_dt_is_rejected_without_advancing(dt):
    motion = JointMotion([0], [-1], [1])
    with pytest.raises(ValueError, match="dt"):
        motion.step([.8], dt)
    np.testing.assert_array_equal(motion.position, [0])


@pytest.mark.parametrize("keyword,value", [("max_speed", 0), ("max_acceleration", -1), ("max_jerk", float("nan"))])
def test_invalid_constraints(keyword, value):
    with pytest.raises(ValueError):
        JointMotion([0], [-1], [1], **{keyword: value})


def test_nonfinite_goal_does_not_corrupt_motion():
    motion = JointMotion([0], [-1], [1])
    motion.step([.5], .01)
    before = motion.position
    with pytest.raises(ValueError, match="goal"):
        motion.step([float("nan")], .01)
    np.testing.assert_array_equal(motion.position, before)
