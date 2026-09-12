#!/usr/bin/env python3
"""Optional LeRobot v0.4.0 conformance oracle for an extracted export bundle."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

ORACLE_COMMIT = "f25ac02e6c8fa9c467ab8462289e5f4aed3a2e85"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset_root", type=Path)
    args = parser.parse_args()

    if os.environ.get("CERES_LEROBOT_ORACLE") != "1":
        print("SKIP: set CERES_LEROBOT_ORACLE=1 to run the optional LeRobot oracle")
        return 0

    try:
        from lerobot.datasets.lerobot_dataset import LeRobotDataset
    except ImportError:
        print("SKIP: the optional LeRobot v0.4.0 oracle is not installed")
        return 0

    info = json.loads((args.dataset_root / "meta" / "info.json").read_text(encoding="utf-8"))
    if info["codebase_version"] != "v3.0":
        raise AssertionError("expected codebase_version v3.0")

    dataset = LeRobotDataset(
        repo_id="ceres/browser-export-oracle",
        root=args.dataset_root,
        download_videos=False,
    )
    if len(dataset) != info["total_frames"]:
        raise AssertionError("LeRobot row count differs from info.json")
    sample = dataset[0]
    required = {
        "observation.state",
        "action",
        "timestamp",
        "frame_index",
        "episode_index",
        "index",
        "task_index",
    }
    if not required.issubset(sample):
        raise AssertionError(f"missing LeRobot columns: {sorted(required - set(sample))}")
    print(f"PASS: LeRobot v0.4.0 oracle {ORACLE_COMMIT} loaded {len(dataset)} rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
