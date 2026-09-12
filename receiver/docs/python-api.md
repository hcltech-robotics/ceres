# Python API

`ceres-bridge listen` owns pairing, the WebRTC connection and the native decoder. Each `Receiver` connects through a private Unix socket. The worker accepts up to eight consumers owned by the same Linux user.

## Connection

```python
from ceres_bridge import Receiver

with Receiver(video=False) as receiver:
    observation = receiver.latest()
    measurements = receiver.diagnostics()
```

Pass `path="/path/to/receiver.sock"` when the worker uses a custom `--socket`. The default socket is in `$XDG_RUNTIME_DIR/ceres-bridge/receiver.sock`. Pairing credentials live separately under `$XDG_STATE_HOME/ceres-bridge/receiver.json`, or `~/.local/state/ceres-bridge/receiver.json`.

## Observations

`latest()` returns `epoch`, `space_epoch`, `description`, `poses`, `frame`, `encoded`, `audio`, `clock`, `counts`, `buffers` and `connection`. It returns immediately with available observations and does not wait for video, audio and poses to align.

Each pose component reports `fresh`, `tracked`, `received_us`, `age_us` and `pose`. The pose contains a source sequence, connection/reference-space epochs, observation/predicted-display timestamps, validity mask and transform values. Head values contain position XYZ and quaternion XYZW. Hand values contain 25 groups of XYZ, XYZW and joint radius in metres.

Source coordinates are right-handed, with +X right, +Y up and -Z forward. A reset of the XR origin advances `space_epoch` and clears poses from the previous origin. A rebuilt connection advances `epoch` and clears its clock mapping and observations.

`clock` describes an affine conversion from sender microseconds to receiver monotonic microseconds:

```text
receiver_us = sender_us * rate + offset_us
```

`uncertainty_us` includes clock-exchange uncertainty, fit residuals and extrapolation. `observed_us` is the time CERES entered the XR callback. `target_us` is WebXR's predicted display time. Neither is a camera exposure timestamp. Decoded frame metadata reports receiver arrival time and RTP presentation time independently.

## Frame ownership

`Receiver(video=True)` reserves two RGB frame slots. Each slot has a maximum size of 640 x 1280 x 3 bytes. `frame.metadata` provides width, height, row stride, byte count, connection epoch, generation and receive time. Use row stride when constructing an array because rows may include padding.

```python
import numpy as np
from ceres_bridge import Receiver

with Receiver() as receiver:
    frame = receiver.latest()["frame"]
    if frame:
        with frame:
            meta = frame.metadata
            image = np.ndarray((meta["height"], meta["width"], 3), dtype=np.uint8,
                               buffer=frame.data, strides=(meta["stride"], 3, 1)).copy()
```

An optional `Receiver(video=False, encoded=True)` reserves two 256 KiB slots for Annex B H.264 access units. Read `observation["encoded"]` with the same lease interface. A dropped access unit puts that consumer into keyframe recovery, and `latest(keyframe=True)` requests a new decodable sequence. VP8 is available through decoded RGB frames.

The worker never overwrites leased data. A slow consumer drops its own new frames, and each output has independent slots. IPC responses are capped at 32 KiB and a blocked response is disconnected after 100 ms. Raw pixel data and encoded access units remain in the private shared mappings.

## Microphone audio

Enable audio with the square microphone button beside **Start streaming** on the headset. Outgoing audio starts off and does not affect local voice commands. `Receiver(audio=True)` reserves two audio slots of 11,520 bytes each. `latest()["audio"]` is a lease containing mono 48 kHz S16LE samples. Its metadata includes `sample_rate`, `channels`, `samples`, `bytes`, `received_us`, `pts_ns` and `epoch`. Chunks older than 100 ms are unavailable.

```python
with Receiver(video=False, audio=True) as receiver:
    audio = receiver.latest()["audio"]
    if audio:
        with audio:
            pcm = bytes(audio.data)
```

Each call returns the latest available chunk. Release it before polling again. Pausing the headset stream suspends audio along with video and poses.
