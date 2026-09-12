"""Measure the two-arm CPU retargeting loop with reproducible wrist inputs."""

import argparse
import json
import math
import time

import numpy as np

from ceres_bridge.teleop import DualArmTeleop


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=240)
    parser.add_argument("--retargeter", choices=("cpu", "isaacteleop"), default="cpu")
    args = parser.parse_args()
    if args.samples < 2:
        parser.error("--samples must be at least 2")
    teleop = DualArmTeleop(backend=args.retargeter)
    durations, solves = [], []
    for i in range(args.samples):
        phase = i / 60
        poses = {}
        for kind, offset in (("2", -.2), ("3", .2)):
            values = [0.] * 200
            values[:8] = [offset + .06 * math.sin(phase), 1.2 + .03 * math.sin(phase * .7),
                          -.4 + .04 * math.cos(phase), 0, math.sin(.1 * math.sin(phase)),
                          0, math.cos(.1 * math.sin(phase)), .01]
            poses[kind] = {"fresh": True, "tracked": True, "pose": {
                "sequence": i, "joint_mask": 1, "values": values}}
        snapshot = {"epoch": 1, "space_epoch": 1, "connection": "connected", "poses": poses}
        started = time.perf_counter_ns()
        result = teleop.update(snapshot, now_ns=1_000_000_000 + i * 16_666_667)
        durations.append((time.perf_counter_ns() - started) / 1e6)
        solves.append(result["solve_ms"])
    measured = durations[1:]
    print(json.dumps({"backend": args.retargeter, "samples": args.samples,
        "input_rate_hz": 60, "update_ms_p50": float(np.percentile(measured, 50)),
        "update_ms_p95": float(np.percentile(measured, 95)), "update_ms_max": max(measured),
        "solve_ms_p95": float(np.percentile(solves[1:], 95)),
        "capacity_updates_per_second": 1000 / float(np.mean(measured)),
        "joint_count": len(result["joint_names"])}, indent=2))


if __name__ == "__main__":
    main()
