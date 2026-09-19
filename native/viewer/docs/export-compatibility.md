# Export compatibility

The default `ceres-bridge-lerobot3-v1` export is readable by the CERES Hugging Face dataset viewer and the official LeRobot 0.6.1 reader. Upload the complete export directory at the dataset repository root. The generated dataset card also lets the generic Hugging Face datasets loader select observation rows directly.

The contract was checked on 18 September 2026 against native exporter `1b27821db654d15ab24ab4d1956b8636707d04ce`, LeRobot 0.6.1 and the unchanged CERES HF Space loader at revision `5b06722d597bc87f1ea6567c033bef73056b97ae`.

## Dataset layout

Root `data`, `meta` and `videos` directories form one multi-episode LeRobot v3 dataset. Each `shards/episode-NNNNNN` directory supplies an episode view for the CERES HF viewer with observation Parquet, episode metadata, task metadata, one MP4 and CERES capture/metrics sidecars. Shards preserve the root dataset's episode, task and global row indices. Local exports hard-link identical Parquet and video files where supported, with a file-copy fallback.

`ceres/metrics.json` records frame counts, tracking/video gaps, selected input bytes, output bytes and native reduction/buffer counters. The sidecar defines the scope of its counters. `ceres/episode-metadata.json` records the selected range, task, connection/reference-space epochs and capture metadata. Known camera dimensions and recorded camera selection/FPS use the CERES capture schema. Original native calibration is retained under `bridge.capture` and in source-event provenance.

The dataset card selects only root observation tables:

```yaml
---
configs:
  - config_name: default
    data_files:
      - split: train
        path: data/**/*.parquet
---
```

The original `.mcap` remains the native viewer's replay recording. Its exported LeRobot directory is the dataset for HF viewing and training.

## Features and timing

| Feature | Stored type and shape | Meaning |
| --- | --- | --- |
| `observation.state` | `float32[410]` | Head tracking flag and pose, then left-hand tracking flag and 25 joints, then right-hand tracking flag and 25 joints |
| `observation.valid` | `bool[51]` | Head validity followed by left and right joint validity |
| `observation.images.passthrough` | H.264 MP4, source dimensions | RGB video on the output grid, normally 30 Hz |
| `observation.video_valid` | `bool[1]` | Whether the slot contains a source image |
| `action` | `float32[2]` | Left/right Euclidean thumb-tip to index-finger-tip distances in metres |
| `action.valid` | `bool[2]` | Whether both fingertips for each distance were observed |
| `ceres.source_timestamp` | `float64[1]` | Receiver-session resampling-grid time in seconds |
| `ceres.source_frame_index` | `int64[1]` | `floor(episode_start_us * fps / 1000000) + frame_index` |
| `ceres.source_gap` | `bool[1]` | No head or hand packet was selected for the slot |
| `ceres.sender_timestamp` | `float64[3]` | Original head/left/right sender observation times in seconds, or -1 when absent |
| `ceres.sender_target_timestamp` | `float64[3]` | Original head/left/right predicted pose target times in seconds, or -1 when absent |
| `ceres.sender_sequence` | `int64[3]` | Original head/left/right XR-frame sequences, or -1 when absent |
| `ceres.video_timestamp` | `float64[1]` | Selected receiver-anchored RTP presentation time in session seconds, or -1 when absent |
| `ceres.connection_epoch`, `ceres.space_epoch` | `int64[1]` | Connection and reference-space identity |

The state uses the existing CERES ordering. The head tracking flag is offset 0, the left-hand flag is offset 8 and the right-hand flag is offset 209. Each joint contributes position XYZ, rotation XYZW and radius. Action names are `left_hand.pinch_distance` and `right_hand.pinch_distance`, matching the browser recorder. Distances are computed from observed fingertip positions. Missing fingertips produce a zero action with false action validity.

Each output slot selects the nearest unused head, hand and video sample within half a slot, with earlier samples winning ties. Missing geometry is zero with false per-joint validity, while missing images are black with false video validity. Epoch changes split episode ranges.

The viewer exports video at the dimensions decoded from the selected recording ranges. Capture metadata may describe a larger image than WebRTC actually sent, so it does not determine the output size. Ranges containing different encoded resolutions must be exported separately. The job's width and height supply the black-frame size when the selected ranges contain no video.

`timestamp` starts at zero in each episode and drives video playback. The CERES scalar source timestamp provides a monotonic receiver-session timeline for playback telemetry. The browser recorder's source timestamp is wall-origin time, while Bridge sender clocks are monotonic. The native profile therefore declares its receiver timeline explicitly and preserves the original sender clocks separately. Video timing comes from RTP presentation timing rather than a measured camera exposure timestamp.

`meta/ceres-export.json` records the profile, exact feature meanings, selected job and timing policy. `meta/ceres-source-events.jsonl` preserves every original event header in recording order, including attributes, extension fields, receiver/session times, epochs, calibration changes, clock estimates, sequences and image/head associations. Raw payloads remain in the MCAP.

LeRobot 0.6.1 returns scalar features as scalar tensors and array features as vectors. Its scalar tensor conversion uses float32 even where the underlying Parquet field is float64. Original storage types and values are checked directly in the Rust tests.

## Verified readers

The conformance recording export contains 540 frames in two episodes with distinct tasks: `Open and close both hands` and `Observe independent camera and hand motion`.

| Check | Result |
| --- | --- |
| Unchanged CERES HF loader | Discovers both shards and loads all 540 rows, task mappings, pinch actions, source gaps and video paths |
| Official LeRobot 0.6.1 | Reads all 540 rows and decodes all 540 images at 640 by 480 |
| Missing observations | All 49 missing-video slots are black and all 150 invalid joint observations are zero |
| Pinch actions | All 1,074 valid measurements agree with their observed fingertip geometry |
| Generic `datasets.load_dataset(export_root)` | Reads exactly 540 observation rows and excludes metadata and duplicate shard tables |
| Partial-tracking fixture | Both readers load two episodes/seven frames with independent sender clocks, partial fingertips, three gaps and two tasks |
| Observation profile regression | Official LeRobot reads all seven rows and both videos without an action feature |

The HF loader was compiled directly from the audited Space source files. Their SHA-256 hashes match the downloaded revision and no loader source was changed for these checks. The loader consumes the actual exported JSON and Parquet through its normal source interface. LeRobot independently decodes the actual MP4 files.

## Profile selection

Export jobs may declare `"profile": "ceres-bridge-lerobot3-v1"` explicitly or omit `profile` to use this default. Helper capabilities declare `actions: true`, `action_dimension: 2`, `ceres_episode_shards: true`, the `default_profile` and both supported `profiles`.

`"profile": "ceres-bridge-observation-v1"` selects the original observation-only export. It writes the root LeRobot layout without action features or CERES episode shards and retains its three-value `ceres.source_timestamp` sender-clock feature. Its versioned profile is declared in both metadata files.

To load the complete uploaded dataset with the official reader:

```python
from lerobot.datasets.lerobot_dataset import LeRobotDataset

dataset = LeRobotDataset(
    "owner/dataset",
    revision="pinned-repository-revision",
    video_backend="pyav",
)
```

## Evidence

Receipts are under `D:/data/ceres-viewer/acceptance`:

- `ceres-profile-roundtrip-reader.json` and `ceres-profile-viewer-reader.json`: independent official-reader image/action checks.
- `ceres-profile-roundtrip-hf-loader.json`: unchanged HF loader over the two-episode recording export.
- `ceres-profile-loader-source.json`: pinned Space revision, unchanged source hashes and compiled loader hash.
- `ceres-profile-dataset-card-reader.json`: generic HF dataset-card selection.
- `ceres-profile-fixture-reader.json` and `ceres-profile-fixture-hf-loader.json`: partial-tracking and clock fixture checks.

The native exporter includes the repeatable Rust integration tests and `tests/verify_ceres_lerobot.py`/`tests/verify_ceres_loader.mjs` reader checks. Its 19 Rust tests, formatting check and strict Clippy check pass. CI runs native tests on Windows/Linux and both profile oracles on Linux.

Source contracts are the [official LeRobot 0.6.1 dataset implementation](https://github.com/huggingface/lerobot/blob/v0.6.1/src/lerobot/datasets/lerobot_dataset.py), the [checked CERES HF loader](https://huggingface.co/spaces/chrisvoncsefalvay/ceres-dataset-viewer/blob/5b06722d597bc87f1ea6567c033bef73056b97ae/src/lib/dataset.ts) and [Hugging Face data-file configuration](https://huggingface.co/docs/hub/datasets-data-files-configuration).
