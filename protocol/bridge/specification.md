# Bridge specification

Bridge sends live Quest 3 observations to a Linux application on the same network. It shares Solo's loading sequence, camera acquisition, IWSDK world, hand rendering and XR input. Python, ROS 2 and Foxglove consume the receiver's single incoming stream.

## Operating modes

| Mode | Purpose | Destination |
| --- | --- | --- |
| Duet | Directed recording with tasks, takes and review | Capture director |
| Solo | Recording and dataset export controlled from the headset | Local Solo authority |
| Bridge | Continuous live camera and pose observations | Paired Linux receiver |

Bridge appears beside Duet and Solo on the capture page, through **Launch > Bridge mode** and at `/bridge/`. Switching modes opens the selected operating surface. Mode changes are locked while XR or a recording workflow is active.

Bridge starts no recorder worker, recording journal, task service or dataset exporter. Its microphone feeds local voice commands independently of optional outgoing audio. The receiver cannot control the headset or issue robot commands through this protocol.

## Pairing and connection

1. `ceres-bridge listen` creates an eight-character code and headset link. The invitation lasts five minutes.
2. The headset claims the invitation and displays the receiver name. Sender and receiver retain separate credentials for a durable, revocable binding.
3. After the demonstrator enables the camera and selects **Start streaming**, the headset creates the SDP offer. CERES's internet signalling service exchanges SDP and ICE candidates.
4. The connection uses direct LAN UDP. After candidate exchange, connection establishment and stream-description acknowledgement, signalling closes.
5. A restart recovers the remembered binding and establishes a new connection epoch. A recovery room lasts 24 hours and can be replaced without repeating pairing.

**Forget receiver** or `ceres-bridge listen --forget` revokes the binding. A browser Web Lock and receiver process lock prevent competing local instances from using the same binding.

## Observation contract

The [wire protocol](README.md) defines CBR1 packets, metadata, clock exchange and fixtures. Video and poses advance independently. Each consumer reads the latest available component without matching video frames to poses or replaying queued observations.

| Stream | Contract |
| --- | --- |
| Video | One native camera track, scaled to 640 pixels wide with its aspect ratio and field of view preserved. H.264 is preferred, VP8 is supported and the initial encoder cap is 2 Mbit/s. |
| Audio | Optional Opus track capped at 32 kbit/s, off on each page load. The receiver exposes mono 48 kHz S16LE samples through bounded leases. |
| Head | Position and XYZW quaternion from each fresh XR observation. |
| Hands | 25 named joints per hand, with position, XYZW quaternion, radius and validity mask. |
| Timing | Separate observation and predicted XR display timestamps. Four-timestamp exchanges estimate clock rate, offset and uncertainty. |
| Coordinates | Metres in WebXR, with +X right, +Y up and -Z forward. Reference-space resets increment a separate epoch. |

The pose channel is unordered with zero retransmissions. The sender admits a whole observation only when the channel has capacity below its 2 KiB limit. The Python API makes stale poses unavailable after 50 ms and also accounts for source age and clock uncertainty.

## Receiver and consumers

The Linux worker owns GStreamer, WebRTC and one decoder. Applications use a private Unix socket and bounded shared-memory leases. Up to eight consumers can attach. Each raw-video consumer has two RGB slots and each encoded-video consumer has two bounded H.264 access-unit slots. Leased memory remains unchanged until released. A stalled consumer cannot hold another consumer's buffers.

`Receiver(video=False)` allocates no raw-video slots. The base Python import does not load GStreamer, ROS 2 or Foxglove. The worker can run in a separate Python environment from the application.

- [Receiver installation](../../receiver/README.md)
- [Python API](../../receiver/docs/python-api.md)
- [ROS 2 Jazzy adapter](../../receiver/docs/ros2.md)
- [Foxglove specification](foxglove.md)

## Headset display

Bridge retains the circular reticle and camera margin. Video FPS appears above the left side and motion FPS above the right. Connection status and the receiver name appear beneath the reticle. The task bar and coloured task markers are hidden.

REC and the microphone status occupy the upper left. Audio starts off with a crossed-out red microphone. The square microphone button beside **Start streaming** changes outgoing audio without affecting local voice commands. Pause/resume is at the upper right and Exit at the lower left. Pause suspends video, audio and poses while keeping the peer connection and local voice control. REC pulses faintly during a pause. Exit closes XR and streaming while leaving the camera preview available.

The four lower-right controls select hand appearance, shading, trails and HUD mode. They remain at 10% opacity when idle and become visible on hover.

| HUD mode | Display |
| --- | --- |
| OFF | Reticle, REC, Exit, Pause and lower-right controls |
| LIGHT | Standard display with rates, connection state, receiver name and camera margin |
| FULL | LIGHT plus a pitch ladder and horizon line at 50% opacity |

## Distribution

The public CERES repository contains the receiver, ROS adapter, Foxglove layouts, specifications and fixtures. `EXPORT-MANIFEST.json` identifies the source revision and SHA-256 hashes. Python packages carry that revision in `ceres_bridge/data/release.json`. Mesh assets are installed separately under their respective licences.
