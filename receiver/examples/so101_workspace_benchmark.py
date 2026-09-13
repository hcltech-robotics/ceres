"""Measure reachable arm targets and smooth upward paths through the retargeter.

Run with the receiver package on PYTHONPATH. The generated targets come from the
packaged URDF, so this benchmark needs neither Quest tracking nor Foxglove.
"""

import argparse
import hashlib
from importlib.metadata import version
import json
import math
from pathlib import Path
import platform
import time
import xml.etree.ElementTree as ET

import numpy as np

from ceres_bridge.teleop import DualArmTeleop
from ceres_bridge.teleop_model import (
    HAND_FROM_TOOL, HOME, JOINT_NAMES, LOWER, UPPER, axis_rotation,
    matrix_quaternion, robot_urdf, rotation_vector, transform,
)


class UrdfArm:
    """Evaluate the published joint tree independently of the IK implementation."""

    def __init__(self, side):
        suffix = "_2" if side == "left" else ""
        self.tip = "Fixed_Jaw_tip" + suffix
        self.names = [name + suffix for name in JOINT_NAMES]
        self.joints = []
        tree = ET.fromstring(robot_urdf())
        parents = {joint.find("child").get("link"): joint for joint in tree.findall("joint")}
        child = self.tip
        while child in parents:
            joint = parents[child]
            origin = joint.find("origin")
            local = transform(np.fromstring(origin.get("xyz", "0 0 0"), sep=" "),
                              np.fromstring(origin.get("rpy", "0 0 0"), sep=" "))
            axis = joint.find("axis")
            self.joints.append((joint.get("name"), local,
                                None if axis is None else np.fromstring(axis.get("xyz"), sep=" ")))
            child = joint.find("parent").get("link")
        self.joints.reverse()

    def forward(self, q):
        angles = dict(zip(self.names, q))
        pose = np.eye(4)
        for name, origin, axis in self.joints:
            pose = pose @ origin
            if axis is not None:
                turn = np.eye(4)
                turn[:3, :3] = axis_rotation(axis, angles.get(name, 0.0))
                pose = pose @ turn
        return pose


def targets():
    result = [("home", HOME.copy())]
    for pitch in (0.0, 0.7, 1.3, 2.0, 2.8, 3.4):
        for elbow in (0.0, 1.3, 2.5):
            q = np.array((0.0, pitch, elbow, 0.0, 0.0, 0.8))
            if np.all(q >= LOWER) and np.all(q <= UPPER):
                result.append((f"pitch_{pitch:g}_elbow_{elbow:g}", q))
    rng = np.random.default_rng(20260912)
    for index in range(13):
        q = LOWER + (0.05 + 0.9 * rng.random(6)) * (UPPER - LOWER)
        q[5] = HOME[5]
        result.append((f"within_limits_{index}", q))
    return result


def snapshot(target, sequence, side):
    wrist = target.copy()
    wrist[:3, :3] = wrist[:3, :3] @ HAND_FROM_TOOL.T
    x, y, z = wrist[:3, 3]
    qx, qy, qz, qw = matrix_quaternion(wrist[:3, :3])
    values = [-float(y), float(z), -float(x), -float(qy), float(qz), -float(qx), float(qw), 0.01]
    values.extend([0.0] * (25 * 8 - len(values)))
    return {"connection": "connected", "epoch": 1, "space_epoch": 1, "ipc_generation": 1,
            "poses": {"2" if side == "left" else "3": {
                "fresh": True, "tracked": True,
                "pose": {"sequence": sequence, "joint_mask": 1, "values": values}}}}


def statistics(rows, frequency):
    q = np.array([row["q"] for row in rows])
    velocity = np.diff(q, axis=0) * frequency
    acceleration = np.diff(velocity, axis=0) * frequency
    jerk = np.diff(acceleration, axis=0) * frequency
    maximum = lambda values: float(np.max(np.abs(values))) if values.size else 0.0
    return {"final_position_error_mm": rows[-1]["position_error_mm"],
            "final_rotation_error_deg": rows[-1]["rotation_error_deg"],
            "maximum_position_error_mm": max(row["position_error_mm"] for row in rows),
            "maximum_velocity_rad_s": maximum(velocity),
            "maximum_acceleration_rad_s2": maximum(acceleration),
            "maximum_jerk_rad_s3": maximum(jerk),
            "maximum_solve_ms": max(row["solve_ms"] for row in rows),
            "final_status": rows[-1]["status"]}


def run_sequence(args, model, goals):
    teleop = DualArmTeleop(position_scale=1, max_joint_speed=args.max_joint_speed, backend=args.backend)
    rows = []
    for index, (target, goal_q) in enumerate(goals):
        target = target.copy()
        if args.wrist_rotation == "pronated":
            target[:3, :3] = model.forward(HOME)[:3, :3]
        elif args.wrist_rotation == "offset":
            target[:3, :3] = axis_rotation((0, 0, 1), .12) @ target[:3, :3]
        result = teleop.update(snapshot(target, index + 1, args.side),
                              now_ns=1_000_000_000 + round(index * 1e9 / args.frequency))
        state = result["arms"][args.side]
        q = state["joint_positions"]
        reached = model.forward(q)
        rows.append({"time_s": index / args.frequency, "q": q, "goal_q": goal_q.tolist(),
                     "target_xyz": target[:3, 3].tolist(),
                     "position_error_mm": float(np.linalg.norm(target[:3, 3] - reached[:3, 3]) * 1000),
                     "rotation_error_deg": math.degrees(float(np.linalg.norm(
                         rotation_vector(target[:3, :3] @ reached[:3, :3].T)))),
                     "solve_ms": state["solve_ms"], "status": state["status"]})
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="JSON receipt path")
    parser.add_argument("--backend", choices=("cpu", "isaacteleop"), default="cpu")
    parser.add_argument("--side", choices=("left", "right"), default="right")
    parser.add_argument("--wrist-rotation", choices=("pose", "pronated", "offset"), default="pose",
                        help="Use each reachable pose's rotation, a palm-down wrist or a 0.12 radian yaw offset")
    parser.add_argument("--frequency", type=float, default=60)
    parser.add_argument("--hold-seconds", type=float, default=6)
    parser.add_argument("--path-seconds", type=float, default=8)
    parser.add_argument("--max-joint-speed", type=float, default=2)
    args = parser.parse_args()
    if (not all(math.isfinite(value) and value > 0 for value in
                (args.frequency, args.hold_seconds, args.path_seconds, args.max_joint_speed))
            or args.frequency * min(args.hold_seconds, args.path_seconds) < 4):
        parser.error("Positive finite timings with at least four samples are required")
    import ceres_bridge.teleop as teleop_module
    source = Path(teleop_module.__file__).parent
    hashes = {name: hashlib.sha256((source / name).read_bytes()).hexdigest()
              for name in ("teleop.py", "teleop_model.py", "teleop_solver.py", "teleop_motion.py", "foxglove_receiver.py")
              if (source / name).exists()}
    model = UrdfArm(args.side)
    cases, paths = [], []
    started = time.perf_counter()
    for name, q in targets():
        target = model.forward(q)
        rows = run_sequence(args, model, [(target, q)] * round(args.hold_seconds * args.frequency))
        case = {"name": name, "goal_q": q.tolist(), "target_xyz": target[:3, 3].tolist(),
                **statistics(rows, args.frequency), "final_q": rows[-1]["q"]}
        cases.append(case)
        print(json.dumps({key: case[key] for key in
                          ("name", "final_position_error_mm", "final_rotation_error_deg", "final_status")}), flush=True)
    for name, q in (("upward", np.array((0., 2., 0., 0., 0., .8))),
                    ("upward_back", np.array((0., 2.8, 0., 0., 0., .8)))):
        if not (np.all(q >= LOWER) and np.all(q <= UPPER)):
            continue
        count = round(args.path_seconds * args.frequency)
        goals = []
        for index in range(count + 1):
            fraction = (1 - math.cos(2 * math.pi * index / count)) / 2
            goal_q = HOME + fraction * (q - HOME)
            goals.append((model.forward(goal_q), goal_q))
        rows = run_sequence(args, model, goals)
        input_q = np.array([goal_q for _, goal_q in goals])
        path = {"name": name, **statistics(rows, args.frequency),
                "maximum_input_velocity_rad_s": float(np.max(np.abs(np.diff(input_q, axis=0) * args.frequency))),
                "maximum_input_acceleration_rad_s2": float(np.max(np.abs(np.diff(input_q, n=2, axis=0) * args.frequency ** 2))),
                "samples": rows}
        paths.append(path)
        print(json.dumps({key: value for key, value in path.items() if key != "samples"}), flush=True)
    receipt = {"source_sha256": hashes, "python": platform.python_version(),
               "numpy": np.__version__, "backend": args.backend, "side": args.side,
               "wrist_rotation": args.wrist_rotation,
               "solver": "placo", "placo_version": version("placo"), "ruckig_version": version("ruckig"),
               "frequency_hz": args.frequency, "hold_seconds": args.hold_seconds,
               "path_seconds": args.path_seconds, "home": HOME.tolist(),
               "lower": LOWER.tolist(), "upper": UPPER.tolist(),
               "held_cases": cases, "paths": paths, "elapsed_seconds": time.perf_counter() - started}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, indent=2, allow_nan=False) + "\n", encoding="ascii")
    print(f"Saved {len(cases)} held cases and {len(paths)} continuous paths to {args.output}")


if __name__ == "__main__":
    main()
