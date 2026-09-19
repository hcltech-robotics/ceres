# Stereo calibration

Image stereo reconstruction starts with the built-in Quest 3 stereo preset. Load a
measured left/right profile to use device-specific camera geometry. **Depth > Automatic**
prefers [headset environment depth](environment-depth.md) when available. Choose **Stereo**
to use image matching explicitly.

## Quest preset

`quest3-stereo-v1` reuses the viewer's existing `Calibration::quest` camera model for both
eyes. It is a nominal profile and remains `measured: false` in preferences and recordings.
Its geometry is not a factory or device measurement.

| Parameter | Preset value |
| --- | --- |
| Default dimensions | 640 by 480 pixels |
| Focal lengths | `fx = fy = width / 1.62` |
| Principal point | `cx = width / 2`, `cy = height / 2` |
| Left optical centre | `[-0.064, -0.030, -0.035]` metres |
| Right optical centre | `[0.064, -0.030, -0.035]` metres |
| Baseline | 0.128 metres |
| Left/right orientation | -6/+6 degrees about head Y |
| Distortion | Zero Brown coefficients |
| Encoded image flips | Both disabled |

The profile carries `preset_id: "quest3-stereo-v1"` and
`provenance: {"kind": "nominal", "version": 1, "source": "ceres-viewer/Calibration::quest"}`.
The viewer recognises the preset by its identifier and complete camera geometry. An arbitrary
unmeasured profile cannot enable reconstruction by reusing the identifier.

Meta's [Passthrough Camera API](https://developers.meta.com/horizon/documentation/unity/unity-pca-documentation/)
provides camera intrinsics, extrinsics and image timestamps for device-specific profiles.
The [Spatial SDK camera overview](https://developers.meta.com/horizon/documentation/spatial-sdk/spatial-sdk-pca-overview/)
describes camera access from Spatial SDK applications.

## Measured profiles

A measured profile is a JSON object with `version: 1`, a `name`, `measured: true` and two camera
objects named `left` and `right`. It has no `preset_id` and retains the existing version 1
format. Each camera uses the existing calibration schema:

| Field | Meaning |
| --- | --- |
| `version` | `1` |
| `name`, `side` | Camera name and `left` or `right` |
| `width`, `height` | Calibrated capture dimensions, both even |
| `fx`, `fy`, `cx`, `cy` | Intrinsics in source pixels |
| `distortion` | Brown coefficients `[k1, k2, p1, p2, k3]` |
| `translation` | Optical centre in head-local metres |
| `rotation` | Camera-to-head XYZW unit quaternion |
| `flip_x`, `flip_y` | Mirroring applied to the encoded source image |

Camera transforms use WebXR coordinates: X right, Y up and Z back. An optical ray points
along negative Z, while pixel rows increase downwards. Brown distortion is defined in the
unmirrored source image, with image flips applied after distortion. Calibration dimensions
may exceed the encoded dimensions when WebRTC reduces the resolution. The viewer scales each
eye's focal lengths and pixel-centre principal point for uniform downscaling, preserving the
recorded profile. For horizontal scale `sx`, this uses `fx * sx` and `(cx + 0.5) * sx - 0.5`,
with the same rule vertically. Decoded dimensions must be even and at least 32 pixels, with
at most one pixel of aspect rounding along either axis. Cropping, aspect changes and upscaling
require a matching calibration.

The baseline runs from the left optical centre to the right optical centre. Profiles require
a baseline between 0.01 and 0.4 metres, overlapping forward views and correctly labelled
cameras. Measured profiles use intrinsics, distortion and camera-to-head transforms obtained
for the capture configuration.

## Reconstruction

The viewer reconstructs stereo at a selected update rate and fuses the observations into a
coloured voxel volume on the GPU. The default rate is 2 Hz. Each scheduled update opens a
pair-acquisition window of up to 120 ms, accepting one qualifying image pair before closing
the window. An update without a qualifying pair leaves the existing volume to age. Camera
decoding, display and recording continue at their own cadence.

CUDA rectifies both NV12 images into a common camera basis, calculates 5 by 5 census
descriptors and matches 3 by 3 descriptor windows along epipolar rows. Texture range,
uniqueness and left/right consistency reject unsupported correspondences. Accepted
disparities receive a subpixel quadratic refinement and are triangulated into head-local
metres. The associated head pose places these points in the current world reference space.
Depth defaults to 0.2 to 5 metres. Invalid correspondences do not enter the volume.

The default rectified width is 320 pixels. Dimensions are bounded to 384 by 384 and disparity
search to 96 pixels. Scratch memory is allocated once for a workspace, with no pixel readback
or device-wide synchronisation in its enqueue path. The renderer owns input frame leases and
the CUDA/OpenGL output buffer until its completion event signals. A workspace serves one
ordered CUDA stream. Context, calibration or dimensions changes require retiring outstanding
work before replacing the workspace.

The volume contains at most 262,144 cells, with a default voxel size of 3 cm. CUDA merges
observations into world-space cells, fuses their colour and refreshes the age of cells seen
again. The volume stays fixed in the reference space as the headset moves. Graphics shaders
fade ageing cells between reconstruction updates and hide them when their finite lifetime
expires. The default fade period is 20 seconds after the most recent observation.

Live viewing measures cell age in receiver session time. Replay uses the playhead, so pausing
freezes the fade as well as playback. Seeking, a connection or reference-space epoch change
and a calibration change clear the volume. Depth comes from image correspondence and the
active camera profile, independently of hand tracking or image-plane projection distance.

## Viewing stereo

Select **DEPTH** in the sidebar footer and choose **Stereo** in the **Depth** panel to use the Quest stereo preset. Load a
measured JSON profile under **Calibration > Stereo**, or use **Quest preset** to restore
the built-in profile. Headset environment depth uses its own recorded view transforms and
does not depend on this image calibration.

| Control | Default | Range | Effect |
| --- | --- | --- | --- |
| Update | 2 Hz | 0.2 to 5 Hz | Reconstruction and fusion cadence |
| Voxel | 3 cm | 1 to 10 cm | Size of each world-space cell |
| Fade | 20 s | 2 to 60 s | Lifetime since a cell was last observed |

**Pair limit** sets the maximum difference between the two media timestamps, with an 8 ms
default. **Near**, **Far** and **Points** control the depth range and point size. **Preview**
shows the primary and secondary images with left/right labels. **Image** and **Frustum**
apply to both camera planes.

Each camera has an independent RTP clock origin. Recent RTCP sender reports map those clocks
to a common sender NTP timeline. Reconstruction requires mappings for both frames and selects
the closest unused images within the pair limit. It does not fall back to network arrival time.
Sender reports identify media time, while the cameras still expose independently.

Pairs require the same connection epoch, reference-space epoch and replay generation. Both
images require valid head associations. Pairs with more than 2 cm translation or 2 degrees
rotation between their associated heads are rejected. A missing stream, timing mapping or
valid head association prevents a new merge. Existing cells continue to fade during a gap
within the same connection and reference space, retaining spatial context until they expire.

The MCAP retains both compressed streams, their source timing, camera identities and complete
stereo profile. Replay uses the same reconstruction and fusion path. The reconstruction
cadence does not reduce the recorded frame cadence. Voxel fusion is a presentation layer,
so MCAP and CERES-compatible LeRobot export formats remain unchanged. Source observations
retain their original validity and timing, and the dataset's state vector has no added depth
fields.

The geometry follows the calibrated pinhole stereo model documented in
[OpenCV's camera calibration reference](https://docs.opencv.org/4.8.0/d9/d0c/group__calib3d.html).
CUDA work follows the stream-ordering rules in the
[CUDA asynchronous execution guide](https://docs.nvidia.com/cuda/cuda-programming-guide/02-basics/asynchronous-execution.html).
