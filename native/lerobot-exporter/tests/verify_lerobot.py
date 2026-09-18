"""Load the native exporter fixture with the official LeRobot 0.6.1 reader."""

from importlib.metadata import version
from pathlib import Path
import argparse
import json
import numpy as np


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    args = parser.parse_args()
    assert version("lerobot") == "0.6.1"
    from lerobot.datasets.lerobot_dataset import LeRobotDataset

    data = LeRobotDataset(
        "ceres/native-export-conformance", root=args.dataset,
        download_videos=False, video_backend="pyav",
    )
    info = json.loads((args.dataset / "meta/info.json").read_text())
    assert len(data) == info["total_frames"] == 7
    assert data.num_episodes == 2
    expected_video = [True, True, False, True, False, True, False]
    for index in range(len(data)):
        row = data[index]
        assert "action" not in row
        assert tuple(row["observation.state"].shape) == (410,)
        assert tuple(row["observation.valid"].shape) == (51,)
        assert bool(row["observation.video_valid"]) == expected_video[index]
        image = row["observation.images.passthrough"]
        assert tuple(image.shape) == (3, 16, 16)
        if not expected_video[index]:
            assert float(image.max()) <= 2 / 255
            assert not bool(row["observation.valid"].any())
            assert not bool(row["observation.state"].any())
    assert np.asarray(data.meta.stats["observation.images.passthrough"]["mean"]).shape == (3, 1, 1)
    assert data.meta.tasks.index.tolist() == ["Move the tracked head"]
    print("PASS: official LeRobot 0.6.1 loaded all 7 rows and decoded both episode videos")


if __name__ == "__main__":
    main()
