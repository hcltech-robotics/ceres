"""Read a CERES profile export with the official LeRobot 0.6.1 reader."""

from importlib.metadata import version
from pathlib import Path
import argparse
import json
import numpy as np


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--require-gaps", action="store_true")
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    assert version("lerobot") == "0.6.1"
    from lerobot.datasets.lerobot_dataset import LeRobotDataset

    dataset = LeRobotDataset(
        "ceres/native-export-conformance", root=args.dataset,
        download_videos=False, video_backend="pyav",
    )
    info = json.loads((args.dataset / "meta/info.json").read_text())
    assert info["ceres_profile"] == "ceres-bridge-lerobot3-v1"
    assert info["features"]["action"]["names"] == [
        "left_hand.pinch_distance", "right_hand.pinch_distance",
    ]
    assert len(dataset) == info["total_frames"]
    assert dataset.num_episodes == info["total_episodes"] >= 2
    image_key = "observation.images.passthrough"
    height, width, _ = info["features"][image_key]["shape"]
    image_gaps = invalid_joints = valid_actions = source_gaps = 0
    episodes = {}
    for index in range(len(dataset)):
        row = dataset[index]
        state = np.asarray(row["observation.state"])
        valid = np.asarray(row["observation.valid"])
        assert state.shape == (410,)
        assert valid.shape == (51,)
        action = np.asarray(row["action"])
        action_valid = np.asarray(row["action.valid"])
        assert action.shape == action_valid.shape == (2,)
        assert action.dtype == np.float32
        expected_action = np.zeros(2, dtype=np.float32)
        expected_valid = np.zeros(2, dtype=bool)
        for side, (base, validity) in enumerate([(9, 1), (210, 26)]):
            expected_valid[side] = valid[validity + 4] and valid[validity + 9]
            if expected_valid[side]:
                thumb = state[base + 4 * 8:base + 4 * 8 + 3].astype(np.float64)
                finger = state[base + 9 * 8:base + 9 * 8 + 3].astype(np.float64)
                expected_action[side] = np.linalg.norm(thumb - finger)
            for joint in range(25):
                if not valid[validity + joint]:
                    assert np.count_nonzero(state[base + joint * 8:base + (joint + 1) * 8]) == 0
                    invalid_joints += 1
        np.testing.assert_array_equal(action_valid, expected_valid)
        np.testing.assert_allclose(action, expected_action, atol=1e-7, rtol=1e-6)
        valid_actions += int(np.count_nonzero(action_valid))
        if not valid[0]:
            assert np.count_nonzero(state[:8]) == 0
        image = row[image_key]
        assert tuple(image.shape) == (3, height, width)
        if not bool(row["observation.video_valid"]):
            assert float(image.max()) <= 3 / 255
            image_gaps += 1
        episode = int(row["episode_index"])
        frame = int(row["frame_index"])
        assert abs(float(row["timestamp"]) - frame / info["fps"]) < 1e-5
        assert int(row["index"]) == index
        task_index = int(row["task_index"])
        assert row["task"] == dataset.meta.tasks.index[task_index]
        sequences = np.asarray(row["ceres.sender_sequence"])
        observed = np.asarray(row["ceres.sender_timestamp"])
        target = np.asarray(row["ceres.sender_target_timestamp"])
        assert sequences.shape == observed.shape == target.shape == (3,)
        np.testing.assert_array_equal(sequences < 0, observed < 0)
        np.testing.assert_array_equal(sequences < 0, target < 0)
        assert bool(row["ceres.source_gap"]) == bool((sequences < 0).all())
        source_gaps += int(bool(row["ceres.source_gap"]))
        sidecar = args.dataset / f"shards/episode-{episode:06}/ceres/episode-metadata.json"
        if episode not in episodes:
            metadata = json.loads(sidecar.read_text())
            episodes[episode] = {"rows": 0, "task": row["task"], "start_us": metadata["bridge"]["start_us"]}
        start = episodes[episode]["start_us"]
        # LeRobot's generic scalar-to-tensor conversion uses float32. Parquet
        # storage precision is checked separately by the Rust integration test.
        np.testing.assert_allclose(float(row["ceres.source_timestamp"]), start / 1e6 + frame / info["fps"], atol=1e-8, rtol=1e-7)
        assert int(row["ceres.source_frame_index"]) == start * info["fps"] // 1_000_000 + frame
        episodes[episode]["rows"] += 1
    assert valid_actions > 0
    if args.require_gaps:
        assert image_gaps > 0 and invalid_joints > 0
    receipt = {
        "status": "passed", "reader": f"official LeRobot {version('lerobot')}",
        "dataset": str(args.dataset.resolve()), "rows": len(dataset),
        "episodes": episodes, "image_dimensions": [width, height],
        "decoded_images": len(dataset), "black_video_gaps": image_gaps,
        "invalid_joints_zeroed": invalid_joints, "validated_pinch_actions": valid_actions,
        "source_gaps": source_gaps,
    }
    text = json.dumps(receipt, indent=2)
    if args.receipt:
        args.receipt.write_text(text + "\n", encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
