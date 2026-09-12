"""Convert a Ceres capture session into an official LeRobot v3 dataset.

The WebXR capture remains available as an EgoVerse-style sidecar containing
head pose, all hand joints and speech annotations. The LeRobot
dataset resamples that state at the outward-camera frame rate, writes video
through LeRobotDataset and finalises its metadata before it can be uploaded.
"""

from __future__ import annotations

import argparse
import bisect
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

try:
    from lerobot.datasets import LeRobotDataset
except ImportError:
    from lerobot.datasets.lerobot_dataset import LeRobotDataset

from task_metadata import lerobot_task_description
from sensor_sidecar import copy_sensor_jsonl


JOINTS = [
    "wrist",
    "thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip",
    "index-finger-metacarpal", "index-finger-phalanx-proximal", "index-finger-phalanx-intermediate", "index-finger-phalanx-distal", "index-finger-tip",
    "middle-finger-metacarpal", "middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate", "middle-finger-phalanx-distal", "middle-finger-tip",
    "ring-finger-metacarpal", "ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate", "ring-finger-phalanx-distal", "ring-finger-tip",
    "pinky-finger-metacarpal", "pinky-finger-phalanx-proximal", "pinky-finger-phalanx-intermediate", "pinky-finger-phalanx-distal", "pinky-finger-tip",
]

STATE_NAMES = [
    "head.x", "head.y", "head.z", "head.qx", "head.qy", "head.qz", "head.qw",
    *[f"{hand}.{joint}.{component}" for hand in ("left", "right") for joint in JOINTS for component in ("x", "y", "z", "qx", "qy", "qz", "qw", "radius")],
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def find_video(episode: Path) -> Path | None:
    videos = sorted((episode / "video").glob("passthrough.*"))
    return videos[0] if videos else None


def normalise_video(source: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "ffmpeg", "-y", "-i", str(source), "-map", "0:v:0", "-an",
        "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", str(output),
    ]
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def state_vector(frame: dict) -> np.ndarray:
    values: list[float] = []
    head = frame.get("head") or {}
    head_position = head.get("position") or {}
    head_rotation = head.get("rotation") or {}
    values.extend([head_position.get("x", 0.0), head_position.get("y", 0.0), head_position.get("z", 0.0), head_rotation.get("x", 0.0), head_rotation.get("y", 0.0), head_rotation.get("z", 0.0), head_rotation.get("w", 1.0)])
    for hand_name in ("leftHand", "rightHand"):
        joints = (frame.get(hand_name) or {}).get("joints") or {}
        for joint_name in JOINTS:
            joint = joints.get(joint_name) or {}
            position = joint.get("position") or {}
            rotation = joint.get("rotation") or {}
            values.extend([position.get("x", 0.0), position.get("y", 0.0), position.get("z", 0.0), rotation.get("x", 0.0), rotation.get("y", 0.0), rotation.get("z", 0.0), rotation.get("w", 1.0), joint.get("radius", 0.0)])
    return np.asarray(values, dtype=np.float32)


def nearest_frame(frames: list[dict], timestamps: list[int], target: int) -> dict:
    if not frames:
        return {}
    index = bisect.bisect_left(timestamps, target)
    if index <= 0:
        return frames[0]
    if index >= len(frames):
        return frames[-1]
    return frames[index] if timestamps[index] - target < target - timestamps[index - 1] else frames[index - 1]


def copy_egoverse_sidecar(source: Path, destination: Path, episode_data: dict, frame_count: int, fps: int) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for name in ("episode.json", "transcript.jsonl"):
        original = source / name
        if original.exists():
            shutil.copy2(original, destination / name)
    sensors = source / "sensors.jsonl"
    if sensors.exists():
        copy_sensor_jsonl(sensors, destination / "sensors.jsonl")
    (destination / "manifest.json").write_text(json.dumps({
        "schema": "ceres-egoverse-sidecar-v1",
        "episode": episode_data,
        "modalities": ["outward_video", "head_pose", "hand_joints", "speech"],
        "video_frame_count": frame_count,
        "video_fps": fps,
        "coordinate_space": "WebXR local reference space",
        "camera_alignment": "MediaStream and WebXR timestamps are recorded together; no raw-camera intrinsics are asserted.",
    }, indent=2), encoding="utf-8")


def main() -> int:
    args = parse_args()
    source = args.input.resolve()
    output = args.output.resolve()
    episodes_root = source / "episodes"
    if not episodes_root.exists():
        raise RuntimeError(f"Capture session has no episodes: {episodes_root}")
    if output.exists():
        shutil.rmtree(output)
    output.parent.mkdir(parents=True, exist_ok=True)

    episode_dirs = [path for path in sorted(episodes_root.iterdir()) if path.is_dir() and find_video(path)]
    if not episode_dirs:
        raise RuntimeError("No captured outward-camera videos were found")

    # LeRobot creates `root` itself with exist_ok=False. Keep temporary video
    # work alongside, rather than inside, the destination dataset root.
    normalised_dir = Path(tempfile.mkdtemp(prefix=f".{output.name}.normalised-", dir=output.parent))
    first_video = find_video(episode_dirs[0])
    assert first_video
    normalise_video(first_video, normalised_dir / "first.mp4")
    probe = cv2.VideoCapture(str(normalised_dir / "first.mp4"))
    width = int(probe.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(probe.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = max(1, round(probe.get(cv2.CAP_PROP_FPS) or 30))
    probe.release()

    features = {
        "observation.images.passthrough": {
            "dtype": "video",
            "shape": (height, width, 3),
            "names": ["height", "width", "channel"],
        },
        "observation.state": {
            "dtype": "float32",
            "shape": (len(STATE_NAMES),),
            "names": {"components": STATE_NAMES},
        },
        "action": {
            "dtype": "float32",
            "shape": (2,),
            "names": {"components": ["left_pinch_distance", "right_pinch_distance"]},
        },
    }
    dataset = LeRobotDataset.create(
        repo_id="ceres/quest-webxr",
        root=output,
        fps=fps,
        robot_type="quest_webxr",
        features=features,
        use_videos=True,
    )

    export_manifest: list[dict] = []
    for episode_index, episode_dir in enumerate(episode_dirs):
        episode = json.loads((episode_dir / "episode.json").read_text(encoding="utf-8"))
        task_description = lerobot_task_description(episode)
        video = find_video(episode_dir)
        assert video
        normalised = normalised_dir / f"episode-{episode_index:06d}.mp4"
        normalise_video(video, normalised)
        frames = read_jsonl(episode_dir / "sensors.jsonl")
        timestamps = [int(frame.get("timestampMs", 0)) for frame in frames]
        start_timestamp = timestamps[0] if timestamps else 0
        capture = cv2.VideoCapture(str(normalised))
        frame_count = 0
        while True:
            valid, image = capture.read()
            if not valid:
                break
            if image.shape[1] != width or image.shape[0] != height:
                image = cv2.resize(image, (width, height), interpolation=cv2.INTER_AREA)
            sensor = nearest_frame(frames, timestamps, start_timestamp + round(frame_count * 1000 / fps))
            rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            dataset.add_frame({
                "observation.images.passthrough": Image.fromarray(rgb),
                "observation.state": state_vector(sensor),
                "action": np.asarray([
                    (sensor.get("leftHand") or {}).get("pinch", 0.0),
                    (sensor.get("rightHand") or {}).get("pinch", 0.0),
                ], dtype=np.float32),
                "task": task_description,
            })
            frame_count += 1
        capture.release()
        if frame_count:
            dataset.save_episode()
            copy_egoverse_sidecar(episode_dir, output / "egoverse" / "episodes" / episode_dir.name, episode, frame_count, fps)
            export_manifest.append({"episode_id": episode_dir.name, "task": task_description, "video_frames": frame_count})

    dataset.finalize()
    (output / "egoverse" / "manifest.json").parent.mkdir(parents=True, exist_ok=True)
    (output / "egoverse" / "manifest.json").write_text(json.dumps({
        "schema": "ceres-egoverse-sidecar-v1",
        "episodes": export_manifest,
        "description": "Quest outward video plus WebXR head, hand and speech capture sidecars.",
    }, indent=2), encoding="utf-8")
    shutil.rmtree(normalised_dir, ignore_errors=True)
    print(f"Wrote {len(export_manifest)} episodes to {output}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Ceres export failed: {error}", file=sys.stderr)
        raise
