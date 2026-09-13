"""Online joint motion with bounded velocity, acceleration and jerk."""

import math

import numpy as np


class JointMotion:
    """Follow joint targets while retaining a continuous motion state.

    A changed goal is accepted only when its complete Ruckig trajectory stays
    inside the joint limits. Otherwise the previous accepted trajectory keeps
    running until the new goal becomes feasible. Tracking loss should change
    the goal to HOME without replacing this object or resetting its state.
    """

    def __init__(self, initial, lower, upper, max_speed=2.0, max_acceleration=8.0, max_jerk=80.0,
                 independent_joints=()):
        from ruckig import InputParameter, OutputParameter, Ruckig, Synchronization, Trajectory

        initial = np.asarray(initial, dtype=float)
        if initial.ndim != 1 or not initial.size or not np.isfinite(initial).all():
            raise ValueError("initial must be a nonempty finite joint vector")
        self._size = initial.size
        self._lower = self._vector(lower, "lower")
        self._upper = self._vector(upper, "upper")
        if np.any(self._lower >= self._upper) or np.any(initial < self._lower) or np.any(initial > self._upper):
            raise ValueError("initial must lie within ordered joint limits")
        self._input = InputParameter(self._size)
        self._input.current_position = initial.tolist()
        self._input.current_velocity = [0.0] * self._size
        self._input.current_acceleration = [0.0] * self._size
        self._input.target_position = initial.tolist()
        self._input.target_velocity = [0.0] * self._size
        self._input.target_acceleration = [0.0] * self._size
        self._input.max_velocity = self._limit(max_speed, "max_speed")
        self._input.max_acceleration = self._limit(max_acceleration, "max_acceleration")
        self._input.max_jerk = self._limit(max_jerk, "max_jerk")
        self._input.synchronization = Synchronization.No
        independent = set(independent_joints)
        if any(not isinstance(index, int) or not 0 <= index < self._size for index in independent):
            raise ValueError("independent_joints must contain valid joint indices")
        self._synchronisations = (
            [Synchronization.No] * self._size,
            [Synchronization.No if index in independent else Synchronization.Phase for index in range(self._size)],
        )
        self._input.per_dof_synchronization = self._synchronisations[0]
        self._online = Ruckig(self._size, 1 / 60)
        self._preflight = Ruckig(self._size, 1 / 60)
        self._candidate = Trajectory(self._size)
        self._output = OutputParameter(self._size)
        self._accepted_goal = initial.copy()
        self._accepted_coordinate = False
        self._settled = True
        self.goal_rejected = False

    def _vector(self, value, name):
        result = np.asarray(value, dtype=float)
        if result.shape != (self._size,) or not np.isfinite(result).all():
            raise ValueError(f"{name} must be a finite vector of {self._size} joints")
        return result.copy()

    def _limit(self, value, name):
        result = np.asarray(value, dtype=float)
        if result.ndim == 0:
            result = np.full(self._size, result.item())
        result = self._vector(result, name)
        if np.any(result <= 0):
            raise ValueError(f"{name} must be positive")
        return result.tolist()

    @property
    def position(self):
        return np.array(self._input.current_position)

    @property
    def velocity(self):
        return np.array(self._input.current_velocity)

    @property
    def acceleration(self):
        return np.array(self._input.current_acceleration)

    @property
    def settled(self):
        return self._settled

    def step(self, goal, dt, *, coordinate=False):
        """Advance 0-50 ms, optionally coordinating joint progress for wrist rotation."""
        goal = np.clip(self._vector(goal, "goal"), self._lower, self._upper)
        if not math.isfinite(dt) or dt < 0 or dt > .05:
            raise ValueError("dt must be between zero and 0.05 seconds")
        if dt == 0:
            return self.position
        self.goal_rejected = False
        coordinate = bool(coordinate)
        if not np.array_equal(goal, self._accepted_goal) or coordinate != self._accepted_coordinate:
            self._input.target_position = goal.tolist()
            self._input.per_dof_synchronization = self._synchronisations[coordinate]
            result = self._preflight.calculate(self._input, self._candidate)
            if int(result) < 0:
                self._input.target_position = self._accepted_goal.tolist()
                self._input.per_dof_synchronization = self._synchronisations[self._accepted_coordinate]
                raise RuntimeError(f"Ruckig could not plan the joint target: {result}")
            extrema = self._candidate.position_extrema
            safe = all(bound.min >= lower - 1e-10 and bound.max <= upper + 1e-10
                       for bound, lower, upper in zip(extrema, self._lower, self._upper))
            if safe:
                self._accepted_goal = goal.copy()
                self._accepted_coordinate = coordinate
            else:
                # Preflight uses a separate planner, so the online planner's
                # cached trajectory and time are unchanged by this rejection.
                self._input.target_position = self._accepted_goal.tolist()
                self._input.per_dof_synchronization = self._synchronisations[self._accepted_coordinate]
                self.goal_rejected = True
        self._online.delta_time = dt
        result = self._online.update(self._input, self._output)
        if int(result) < 0:
            raise RuntimeError(f"Ruckig could not advance the joint motion: {result}")
        self._output.pass_to_input(self._input)
        self._settled = int(result) == 1
        return self.position
