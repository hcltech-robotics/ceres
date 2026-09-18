# Native LeRobot exporter

`ceres-native-exporter` converts completed Ceres viewer MCAP sessions into CERES-compatible LeRobot v3 datasets. It runs on Windows and Linux and uses the state and action ordering from the existing Ceres Rust exporter. Its default output is readable by the CERES Hugging Face dataset viewer and the official LeRobot 0.6.1 reader.

## Build and run

Install Rust 1.91 or later and FFmpeg with the `libx264` encoder, then run from the Ceres checkout:

```text
cargo build --locked --release --manifest-path native/lerobot-exporter/Cargo.toml
native/lerobot-exporter/target/release/ceres-native-exporter --job export-job.json
```

On Windows the executable has an `.exe` extension. `--version` reports the executable version and `--capabilities` returns a JSON object describing the supported job, session and dataset formats.

## Export job

```json
{
  "schema": "ceres-native-export",
  "version": 1,
  "profile": "ceres-bridge-lerobot3-v1",
  "session": "capture.mcap",
  "output": "training-dataset",
  "fps": 30,
  "ffmpeg": "ffmpeg",
  "episodes": [
    {
      "start_us": 0,
      "end_us": 10000000,
      "task": "Place the component in its tray"
    }
  ],
  "video": {
    "stream": "passthrough",
    "key": "observation.images.passthrough",
    "width": 640,
    "height": 480
  },
  "cancel_file": "export.cancel"
}
```

Session, output and cancellation paths are relative to the job file. The FFmpeg value is an executable on `PATH` or an absolute path. The output must not exist. The helper builds the dataset in a temporary sibling directory and renames it into place after every episode and metadata file has completed.

`profile` defaults to `ceres-bridge-lerobot3-v1`. The optional `ceres-bridge-observation-v1` profile retains the observation-only format, including its three-value `ceres.source_timestamp` feature. Both profiles are declared in `meta/info.json` and `meta/ceres-export.json`, while `--capabilities` lists them under `profiles` and identifies the default under `default_profile`.

Ranges use session-relative microseconds with an inclusive start and an exclusive end. Each range requires a task description. Ranges are exported in the order supplied and are split whenever the connection or reference-space epoch changes. FPS defaults to 30 and accepts integer values from 1 to 240. An omitted or empty stream selects the first recorded video stream, while an explicit stream selects that exact label. The default image key is `observation.images.passthrough`. Image dimensions must be positive and even.

The image dimensions must match the recorded source throughout the selected ranges. Camera metadata is checked over those ranges and decoded images are checked before they enter the dataset. Export preserves source dimensions. When a recording changes resolution, select ranges at one resolution for each export and supply that resolution in the job. Other resolutions outside the selected ranges do not prevent export.

Creating `cancel_file` requests cancellation. The helper checks it while reading events and producing output frames, terminates its FFmpeg children and discards its temporary output. The caller can remove that file before starting another job.

Stdout contains newline-delimited JSON progress objects:

```json
{"schema":"ceres-export-progress","version":1,"stage":"exporting","completed":0,"total":2}
```

Stages are `indexing`, `exporting`, `frames`, `complete` and `error`. Counts refer to episodes for `exporting` and `complete`, or frames within the current episode for `frames`. An error includes a `message` and returns exit status 1. Success returns 0.

## Session input

The MCAP channel message encoding is `ceres-session-v1`. Every message has a binary envelope:

```text
4 bytes ASCII CSE1
4 bytes little-endian unsigned JSON header length
UTF-8 JSON header
raw payload bytes to the end of the MCAP message
```

The header includes `kind`, `session_receive_us`, `session_time_us`, `epoch`, `space_epoch`, `stream` and `keyframe`. Original receiver and sender timestamps remain in the recording. Pose messages contain the original CBR1 packet. Video messages contain one complete Annex B H264 access unit with increasing presentation timestamps. A video epoch begins at its first keyframe and the Ceres low-latency stream has no B frames.

The helper memory-maps the MCAP and streams packet payloads into temporary per-epoch files. It retains timestamp/offset indexes rather than complete tracking or video payloads in memory. Parquet output is buffered in 512-row groups, while FFmpeg decoding and encoding use frame pipes. Decoding begins at the selected image's preceding keyframe and restarts when its H264 sequence parameters change. Each FFmpeg decoder, encoder and filter graph uses at most two worker threads, and export uses CPU codecs so the viewer retains the GPU.

## Features and timing

Each output slot selects the nearest unused sample within half a slot independently for the head, each hand and video. Equal distances select the earlier sample. Samples outside the selected range or epoch cannot enter the output. No interpolation or sample reuse occurs.

| Feature | Shape | Contents |
| --- | --- | --- |
| `observation.state` | 410 | Head tracked flag and 7 pose values, then each hand's tracked flag and 25 groups of 8 joint values |
| `observation.valid` | 51 | Head validity followed by the 25 left and 25 right joint validity flags |
| `observation.video_valid` | 1 | Whether this slot contains an observed camera frame |
| `observation.images.passthrough` | height, width, 3 | H264 MP4 video at the export FPS |
| `action` | 2 | Left and right thumb-tip to index-finger-tip distances in metres |
| `action.valid` | 2 | Whether both corresponding fingertips were observed |
| `ceres.source_timestamp` | 1 | Receiver session resampling-grid timestamp in seconds |
| `ceres.source_frame_index` | 1 | `floor(episode_start_us * fps / 1000000) + frame_index` |
| `ceres.source_gap` | 1 | No head or hand packet was selected for this slot |
| `ceres.sender_timestamp` | 3 | Original head, left hand and right hand observation timestamps in seconds, or -1 when absent |
| `ceres.sender_target_timestamp` | 3 | Original predicted pose target timestamps in seconds, in the same order |
| `ceres.sender_sequence` | 3 | Original XR-frame sequences, in the same order, or -1 when absent |
| `ceres.video_timestamp` | 1 | Session-relative video presentation timestamp in seconds, or -1 when absent |
| `ceres.connection_epoch` | 1 | Connection epoch |
| `ceres.space_epoch` | 1 | Reference-space epoch |

Joint values use position XYZ, quaternion XYZW and radius. Unobserved components are zero with false validity. Missing video is black with false video validity. Pinch distance uses the selected hand's actual observed fingertip positions. An unobserved fingertip gives a zero distance and false action validity. The action names are `left_hand.pinch_distance` and `right_hand.pinch_distance`, matching the browser recorder.

Each episode has a zero-based uniform `timestamp` sequence in seconds and a separate MP4 file. The scalar `ceres.source_timestamp` supplies the monotonic receiver-session timeline used for CERES playback telemetry. Its clock domain differs from the browser recorder's wall-origin source time. Original sender observation and prediction clocks remain separate in the three-value sender features. The video timestamp comes from receiver-anchored RTP timing and does not claim to measure exposure time. `meta/ceres-export.json` records the profile and exact feature semantics.

The dataset includes task, episode, frame and global indexes, aggregate statistics and per-episode statistics.

`meta/ceres-source-events.jsonl` preserves every original Ceres event header in recording order, including sequences, RTP timestamps, receiver and session times, epochs, calibration, clock metadata and image/head associations. Each line is one JSON header with all original attributes and extension fields. This provenance covers the source session, including events outside the selected episode ranges. H264 and binary tracking payloads remain in the MCAP. Headers are compacted and written individually through a 64 KiB buffer.

## Repository layout

Upload the complete export directory at the dataset repository root. Root `data`, `meta` and `videos` directories form the ordinary multi-episode LeRobot v3 dataset. `shards/episode-NNNNNN` provides each episode to the CERES HF viewer with matching global episode and row indices, task metadata, one video and CERES sidecars. Parquet and MP4 files have identical content in both views. Local exports use hard links where supported and copy files otherwise.

Each shard's `ceres/metrics.json` contains measured frame, gap, selected-input and output-byte counts. Reduction and scratch-buffer counters describe the native exporter operations, with their scope recorded alongside the counters. `ceres/episode-metadata.json` records the selected range, task, epochs and capture metadata. Known camera dimensions and recorded camera selection/FPS are supplied in the CERES capture schema. Original native calibration remains under the `bridge.capture` object and in the source-event provenance.

The generated dataset card selects `data/**/*.parquet`. This lets the generic Hugging Face datasets loader read observation rows without merging episode metadata tables or duplicate shard files. The optional observation profile writes the root LeRobot layout without CERES episode shards or actions.

## Verification

```text
cargo test --locked --manifest-path native/lerobot-exporter/Cargo.toml
cargo clippy --locked --all-targets --manifest-path native/lerobot-exporter/Cargo.toml -- -D warnings
```

The integration tests create MCAP fixtures containing real encoded H264, partial hand tracking, gaps, two tasks and an epoch transition. They check both export profiles, sender clocks/sequences, pinch geometry, shard locators and byte-identical shared files. Set `CERES_EXPORT_ORACLE_DIR` to a new directory to retain the observation fixture and `CERES_EXPORT_CERES_ORACLE_DIR` to retain the default CERES fixture. `FFMPEG` overrides the FFmpeg executable used by tests.

Install `lerobot[dataset]==0.6.1` in a Python 3.12 environment and run:

```text
python native/lerobot-exporter/tests/verify_lerobot.py <fixture-directory>/dataset
python native/lerobot-exporter/tests/verify_ceres_lerobot.py <ceres-fixture-directory>/dataset --require-gaps
```

Both oracles read every row and decode both episode videos, including black gap frames. The CERES oracle also checks pinch distances against the observed joints, action validity, task indices and both clock domains. Continuous integration runs native tests on Windows and Linux, then both official oracles on Linux.

`tests/verify_ceres_loader.mjs` runs the unchanged CERES HF loader against a local export. Bundle `src/lib/dataset.ts` from the HF Space revision `5b06722d597bc87f1ea6567c033bef73056b97ae` as a Node ES module, including its dependencies, then run:

```text
node native/lerobot-exporter/tests/verify_ceres_loader.mjs <loader.mjs> <ceres-export-directory>
```

The conformance export from a viewer recording contains 540 frames in two episodes with distinct tasks. The pinned HF loader reads all 540 rows. LeRobot 0.6.1 decodes all 540 images at 640 by 480, including 49 black video gaps, and verifies 1,074 valid pinch measurements and 150 zeroed invalid joints. The generated card also loads exactly 540 observation rows through the generic Hugging Face datasets loader.
