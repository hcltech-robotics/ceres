# Ceres session format

A session is an uncompressed, chunked MCAP file with the profile `ceres-session-v1`.
Channels use the topic `/ceres/<kind>/<stream>` or `/ceres/<kind>` when the stream is empty,
the message encoding `ceres-session-v1` and schema ID zero. The versioned envelope below
defines the message schema. Camera bytes remain compressed H.264 and are never base64 encoded.

## Event envelope

All integer framing fields are little endian. An MCAP message contains:

| Offset | Length | Value |
| --- | --- | --- |
| 0 | 4 | ASCII `CSE1` |
| 4 | 4 | Unsigned JSON header byte length |
| 8 | Header length | UTF-8 JSON header |
| 8 + header length | Remaining message bytes | Unmodified event payload |

The JSON header contains `version` (1), `kind`, `receive_us`, `time_us`,
`session_receive_us`, `session_time_us`, `epoch`, `space_epoch`, `sequence`,
`rtp_timestamp`, `keyframe`, `stream` and an `attributes` object. Pose records also
contain `pose_kind`, with 1 for head, 2 for left hand and 3 for right hand.

`receive_us` is the original receiver steady-clock arrival time in microseconds.
`time_us` is the receiver-local sample time: the mapped observed pose time when
clock synchronisation is valid, arrival time otherwise, or anchored RTP presentation
time for video. It is not a camera exposure timestamp. The session fields subtract
the recording origin and clamp values before that origin to zero. Original times
are retained without modification. MCAP `log_time` is `session_receive_us * 1000`
and `publish_time` is `session_time_us * 1000`.

| Kind | Payload | Attributes |
| --- | --- | --- |
| `pose` | Original CBR1 packet | Clock validity and uncertainty |
| `video` | One complete Annex B H.264 access unit | Codec, RTP clock rate, extended RTP timestamp and PTS |
| `metadata` | Original UTF-8 description when available | Parsed description or connection state |
| `clock` | Empty | Offset, uncertainty, rate, validity and clock exchange timestamps |
| `epoch` | Empty | `reason`: `connection` or `reference-space` |
| `calibration` | Optional original calibration bytes | Complete active calibration profile |
| `episode` | Empty | Episode name and task annotations |
| `asset` | Optional original asset bytes | Asset identifier, format and source information |

Video `keyframe` marks an IDR access unit with the required parameter sets.
Events retain their connection and reference-space epochs. Use distinct `stream`
identifiers for independently restorable assets or calibration profiles.

For dual-camera Bridge input, the declared primary camera uses `passthrough` and the
second uses `passthrough_left` or `passthrough_right`. Every video event retains
`camera_side`, `camera_mid` and `camera_primary`. Assemblers, sequence counters, RTP
anchors and keyframe indexes are independent for each stream. Primary identity follows
the first camera in the description's `cameras` array, rather than arrival order.

Video timestamps remain `receiver-arrival-anchored-rtp`. A recent RTCP sender report adds
`sender_report_ntp`, `sender_report_rtp`, `sender_report_seen_us`, `sender_ntp_us` and
`sender_time_domain: rtcp-sender-report-ntp`. These attributes retain their original
values during replay. `capture_synchronised` is false because RTCP media timing does not
establish synchronised sensor exposure. Stereo matching uses `sender_ntp_us` when both
frames have it and never compares the two raw RTP counters.

Calibration events contain `profile` for the primary image-plane calibration and
`stereo_profile` for measured left/right calibration, or null when no stereo profile is
selected. Both are restored at the replay position. LeRobot export explicitly selects
the `passthrough` stream, retaining the primary-camera feature contract.

The `hand-rig` asset uses schema `ceres-hand-assets`, version 1. Its `CHM1` binary
payload stores both hands in left/right order. Each hand starts with 25 rest-joint
positions as three float32 values, then uint32 vertex/index counts. Each 64-byte
vertex contains position[3], normal[3], UV[2], uint32 joint indices[4] and float32
weights[4]. Uint32 triangle indices follow the vertices. All fields are little
endian. Replay validates sizes, coordinates, joint indices, weights and triangle
references before replacing GPU meshes. Recordings therefore carry the exact
original skinned surfaces and rest rig used by the viewer.

Version 2 uses `CHM2` and preserves up to 16 influences per vertex. Its first 64
bytes retain the version 1 fields, followed by 12 additional uint32 joint indices
and 12 additional float32 weights, for 160 bytes per vertex. The rest-joint,
count and triangle layout is unchanged. Asset attributes retain the model source
and retargeting method. Readers accept both hand asset versions.

The `headset-rig` stream uses schema `ceres-headset-asset`, version 1. Its `model`
attribute contains the `ceres-static-model` manifest with geometry counts,
material factors, texture dimensions and a column-major rigid `model_to_head`
matrix. The `CQM1` payload starts with its four-byte magic, then float32
position[3], normal[3] and UV[2] per vertex, followed by uint32 triangle indices.
RGBA8 texture pixels follow in base-colour, normal and packed
occlusion/roughness/metallic order when present. Rows are bottom-up for OpenGL.
Base colour is sRGB and the other maps are linear. The asset is bounded to 60 MiB.
Geometry and texture data therefore remain available without the original USDZ.

## Recording and recovery

The recorder receives complete events before presentation drops. A separate writer
drains a byte-bounded queue into MCAP chunks, emits message/chunk indexes and performs
periodic durable checkpoints. Queue exhaustion stops recording with an error while
the writer preserves accepted events. File errors preserve the partial file.

Active files have the suffix `.mcap.partial`. Normal completion writes the MCAP
summary, closes the file and renames it to `.mcap`. Existing destinations are never
overwritten. The `ceres.session` MCAP metadata record stores the format version and
recording origin. The indexed attachment `ceres.keyframes.json` contains a version
and an array of stream, receive time, sample time, sequence, connection epoch and
reference-space epoch for every IDR.

Recorder status reports `duration_us` as the maximum written event receive time
relative to the recording origin. Once recording stops, it matches the duration
reported by reopening the MCAP file.

Manual pause omits pose, video and depth observations while retaining current
stream descriptions, clock mappings, calibration and assets. Resume restores that
state and accepts each video stream from its next keyframe. `record-pause` and
`record-resume` epoch events mark these boundaries and reset replay decoding.
Source timestamps and source epoch identifiers remain unchanged.

`active_duration_us` measures elapsed recording time excluding manual and scheduled pauses.
Task episode ranges use the original session timeline and end before a manual
pause, then restart on resume. Imported CERES task specifications are retained in
the `task-specification` asset stream. Task episode markers identify the task,
cycle and repetition.

Timed tasks accept observations whose receive timestamps fall within the active
episode, including its start and excluding its end. The recorder enforces these
boundaries independently of rendering while retaining stream control events.

Recovery writes a new file from complete messages in complete chunks, rebuilds
indexes and retains the interrupted source. A truncated final chunk is omitted.
The reader supports this application's uncompressed chunks and does not materialise
video payloads while indexing. The index is rebuilt from event headers, which also
allows partial files without a summary to be inspected.

## Replay

Playback follows the original receive timeline so hands remain independent of
camera cadence. Seeking restores the most recent clock, epoch, calibration, asset,
description and pose state, then decodes video from the preceding IDR. Reference-space
changes clear pose history while preserving video decode dependencies. Connection
changes start a new decode history.

Event callbacks include `replay_generation`, `replay_preroll`, `session_receive_us`,
`session_time_us`, `recorded_receive_us` and `recorded_time_us` in attributes. A seek
starts with an epoch event carrying `reason: seek` and `reset_decoder: true`.
Consumers flush queued decode work on that event, reject older generations and
decode preroll frames without presenting them. The last frame at the target is
delivered with `replay_preroll: false`. Callback arrival/sample times are rebased to
the active playback clock and raw packet timestamps remain unchanged.

The replay worker performs file reads and timed delivery. Pause, speed changes and
seeks wake it immediately, and newer seek generations cancel obsolete preroll work.
Frame stepping pauses playback and seeks to the adjacent primary-camera receive
timestamp. It follows variable camera cadence and clamps to the first/last frame.
Dataset export reads original envelope times and payloads rather than rebased replay
callbacks or presentation state.
