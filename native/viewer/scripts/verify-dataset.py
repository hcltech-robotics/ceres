"""Check a completed native export with the official LeRobot 0.6.1 reader."""

import argparse
import json
import math
from importlib.metadata import version
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if version("lerobot") != "0.6.1":
        raise RuntimeError("This conformance check requires LeRobot 0.6.1")
    from lerobot.datasets.lerobot_dataset import LeRobotDataset

    data = LeRobotDataset(
        "ceres/viewer-recording", root=args.dataset,
        download_videos=False, video_backend="pyav",
    )
    info = json.loads((args.dataset / "meta/info.json").read_text())
    provenance = json.loads((args.dataset / "meta/ceres-export.json").read_text())
    profile = provenance.get("profile", "ceres-bridge-observation-v1")
    assert profile in ("ceres-bridge-lerobot3-v1", "ceres-bridge-observation-v1")
    ceres_profile = profile == "ceres-bridge-lerobot3-v1"
    assert ("action" in info["features"]) == ceres_profile
    if ceres_profile:
        assert info["features"]["action"]["shape"] == [2]
        assert info["features"]["action.valid"]["shape"] == [2]
    assert len(data) == info["total_frames"]
    width, height = info["features"]["observation.images.passthrough"]["shape"][1::-1]
    present = 0
    invalid_joints = 0
    for index in range(len(data)):
        row = data[index]
        assert ("action" in row) == ceres_profile
        state = row["observation.state"]
        valid = row["observation.valid"]
        assert tuple(state.shape) == (410,)
        assert tuple(valid.shape) == (51,)
        if ceres_profile:
            assert tuple(row["action"].shape) == (2,)
            assert tuple(row["action.valid"].shape) == (2,)
            for hand, base in enumerate((9, 210)):
                thumb, index_tip = 4, 9
                measured = bool(valid[1 + 25 * hand + thumb]) and bool(
                    valid[1 + 25 * hand + index_tip]
                )
                assert bool(row["action.valid"][hand]) == measured
                expected = math.dist(
                    state[base + 8 * thumb:base + 8 * thumb + 3],
                    state[base + 8 * index_tip:base + 8 * index_tip + 3],
                ) if measured else 0.0
                assert math.isclose(float(row["action"][hand]), expected, abs_tol=1e-6)
        image = row["observation.images.passthrough"]
        assert tuple(image.shape) == (3, height, width)
        if bool(row["observation.video_valid"]):
            present += 1
        else:
            assert float(image.max()) <= 3 / 255
        if not bool(valid[0]):
            assert not bool(state[:8].any())
        for joint in range(50):
            if not bool(valid[joint + 1]):
                invalid_joints += 1
                start = (9 if joint < 25 else 210) + (joint % 25) * 8
                assert not bool(state[start:start + 8].any())
    report = {
        "reader": "LeRobot 0.6.1",
        "profile": profile,
        "frames": len(data), "episodes": data.num_episodes,
        "source_video_frames": present,
        "missing_video_frames": len(data) - present,
        "invalid_joints": invalid_joints,
        "width": width, "height": height,
        "tasks": data.meta.tasks.index.tolist(),
        "status": "passed",
    }
    if args.report:
        args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
