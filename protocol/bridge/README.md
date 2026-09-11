# Bridge protocol v1

See the [Bridge specification](specification.md) for operating modes, pairing, receiver behaviour and the headset display, and the [Foxglove specification](foxglove.md) for topics, meshes, projection and layouts.

Bridge establishes one WebRTC peer connection over direct LAN UDP. The browser is the sole SDP offerer and sends one video track. Signalling carries SDP and ICE through CERES, then closes after both peers have completed candidate exchange, connected and acknowledged the stream description.

## Channels

| Channel | Reliability | Content |
| --- | --- | --- |
| `ceres.pose.v1` | Unordered, `maxRetransmits: 0` | One CBR1 component packet per message |
| `ceres.meta.v1` | Reliable, ordered | Description, acknowledgement and four-timestamp clock exchanges |

Metadata messages have a maximum size of 8 KiB. They contain `version: 1` and the connection `epoch`. The receiver sends `ack` after validating the sender's `description`. The description contains the clock identifier/domain, reference space, coordinate axes, metre units, XYZW quaternion order, the 25 joint names and camera source geometry. `camera.calibration` is null when calibration is unavailable.

A `ping` contains `id` and receiver timestamp `t0`. The sender replies with `pong`, preserving those fields and adding receive/send timestamps `t1` and `t2`. The receiver observes `t3`. All values are integer monotonic microseconds. Clock rate and offset are estimated together, with uncertainty retained by the client. Clock messages do not control the sender.

## Binary header

All integers and float32 values use little-endian order. The fixed header is 40 bytes.

| Offset | Type | Field |
| --- | --- | --- |
| 0 | Four bytes | ASCII `CBR1` |
| 4 | uint8 | Version, `1` |
| 5 | uint8 | Kind: head `1`, left hand `2`, right hand `3` |
| 6 | uint16 | Flags: bit 0 is valid, all other bits are zero |
| 8 | uint32 | Connection epoch |
| 12 | uint32 | Reference-space epoch |
| 16 | uint32 | Source observation sequence |
| 20 | uint32 | Payload byte count |
| 24 | uint64 | XR callback observation time in microseconds |
| 32 | uint64 | Predicted XR display time in microseconds |

Timestamps must be non-negative integers no larger than `2^53 - 1`. Sequence comparison uses modular uint32 arithmetic. A sequence is newer when its forward distance is non-zero and less than `2^31`. A new connection resets sequence and clock state. A reference-space reset invalidates all transforms from the previous origin.

## Component payloads

The head packet is 68 bytes. Its payload is seven float32 values: position XYZ and quaternion XYZW.

A hand packet is 844 bytes. Its payload begins with a uint32 joint-validity mask followed by 25 groups of eight float32 values: position XYZ, quaternion XYZW and radius. Bits 0 through 24 follow the canonical [joint order](../../shared/xr-hand-joints.ts). The hand valid flag equals whether its mask contains any valid joint.

Valid transforms have finite values, non-negative radius and a quaternion squared norm between 0.5 and 1.5. Consumers use validity flags and masks when interpreting payloads. The sender writes zeroes for unavailable transforms.

One complete observation occupies 1,756 payload bytes across its three component messages. The sender publishes all components only when they fit below a 2,048-byte data-channel admission limit. It drops the observation when capacity is unavailable and never queues a stale sample for later transmission.

## Video and timing

The original camera track goes directly to the browser's native encoder. The sender requests a 640-pixel-wide encoded stream by scaling the source track while preserving its aspect ratio and field of view. Its initial encoder cap is 2 Mbit/s, and H.264 is preferred with VP8 available for comparison.

Video and poses arrive independently. RTP presentation time is not a calibrated sensor exposure time. The description freezes source geometry for its connection epoch. A camera mode change requires a new connection description.

The Python client preserves raw WebXR coordinates: +X right, +Y up and -Z forward. The ROS adapter changes basis to X forward, Y left and Z up. No camera extrinsic transform is implied by the head pose.

## Fixtures and compatibility

[poses.json](fixtures/poses.json) contains tracked/untracked head and hand packets, including sequence wrap and partial joint masks. Both the [TypeScript codec](../../shared/bridge-protocol.ts) and [Python codec](../../receiver/src/ceres_bridge/protocol.py) consume these fixtures.

Unknown protocol versions, message kinds, metadata operations, flags and invalid lengths are rejected. Application commands, recording controls and task metadata are outside the protocol.
