# Native LeRobot exporter

`ceres-native-exporter` converts completed Ceres viewer MCAP sessions into observation-only LeRobot v3 datasets. It runs on Windows and Linux and uses the state ordering from the existing Ceres Rust exporter. The official LeRobot 0.6.1 reader is the compatibility oracle.

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

Ranges use session-relative microseconds with an inclusive start and an exclusive end. Each range requires a task description. Ranges are exported in the order supplied and are split whenever the connection or reference-space epoch changes. FPS defaults to 30 and accepts integer values from 1 to 240. An omitted or empty stream selects the first recorded video stream, while an explicit stream selects that exact label. The default image key is `observation.images.passthrough`. Image dimensions must be positive and even.

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

The helper memory-maps the MCAP and streams packet payloads into temporary per-epoch files. It retains timestamp/offset indexes rather than complete tracking or video payloads in memory. Parquet output is buffered in 512-row groups, while FFmpeg decoding and encoding use frame pipes.

## Observation semantics

Each output slot selects the nearest unused sample within half a slot independently for the head, each hand and video. Equal distances select the earlier sample. Samples outside the selected range or epoch cannot enter the output. No interpolation or sample reuse occurs.

| Feature | Shape | Contents |
| --- | --- | --- |
| `observation.state` | 410 | Head tracked flag and 7 pose values, then each hand's tracked flag and 25 groups of 8 joint values |
| `observation.valid` | 51 | Head validity followed by the 25 left and 25 right joint validity flags |
| `observation.video_valid` | 1 | Whether this slot contains an observed camera frame |
| `observation.images.passthrough` | height, width, 3 | H264 MP4 video at the export FPS |
| `ceres.source_timestamp` | 3 | Original head, left hand and right hand observation timestamps in seconds, or -1 when absent |
| `ceres.video_timestamp` | 1 | Session-relative video presentation timestamp in seconds, or -1 when absent |
| `ceres.connection_epoch` | 1 | Connection epoch |
| `ceres.space_epoch` | 1 | Reference-space epoch |

Joint values use position XYZ, quaternion XYZW and radius. Unobserved components are zero with false validity. Missing video is black with false video validity. Each episode has a zero-based uniform timestamp sequence and a separate MP4 file. The dataset includes task, episode, frame and global indexes, aggregate statistics and per-episode statistics. `meta/ceres-export.json` records the export job and timing policy. There is no action feature.

## Verification

```text
cargo test --locked --manifest-path native/lerobot-exporter/Cargo.toml
cargo clippy --locked --all-targets --manifest-path native/lerobot-exporter/Cargo.toml -- -D warnings
```

The integration test creates an MCAP containing real encoded H264, tracking gaps and an epoch transition, then checks the exported Parquet files. Set `CERES_EXPORT_ORACLE_DIR` to a new directory to retain that fixture. `FFMPEG` overrides the FFmpeg executable used by tests.

Install `lerobot[dataset]==0.6.1` in a Python 3.12 environment and run:

```text
python native/lerobot-exporter/tests/verify_lerobot.py <fixture-directory>/dataset
```

The oracle reads every row and decodes both episode videos, including the black gap frames. Continuous integration runs the native tests on Windows and Linux, then runs the official oracle on Linux.
