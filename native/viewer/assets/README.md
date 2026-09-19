# Viewer assets

Release packages contain the converted Quest 3 model and fonts listed in `redistributable.json`. The viewer supplies original articulated hand geometry in its executable. The positive package allowlist excludes user-supplied MANO assets.

## MANO hands

Place authorised version 1 `mano-left.json` and `mano-right.json` files under `assets/local/mano` to use optional MANO geometry locally. These files remain outside source control and release packages. Each contains the original 778 vertices, 1,538 faces, 16 joints, all skinning weights and fingertip vertex indices. The loader validates dimensions, topology, handedness, joint names, normals and weights.

The renderer maps the named MANO joints to WebXR joints and uses palm landmarks to align the bind pose. All 16 influences remain in GPU skinning. Partial tracking that no longer supports a stable palm orientation uses the same dimmed one-second presentation hold as a tracking gap. Recorded validity remains unchanged.

New recordings embed the full hand assets with the version 2 `CHM2` encoding. Replay also reads the original four-influence `CHM1` format.

## Quest 3

Convert a USDZ asset using Python with `usd-core`, NumPy and Pillow:

```text
python scripts/convert-quest-model.py --help
```

The runtime reads `assets/quest3/model.json`, compact triangle buffers and three RGBA8 maps. USD is needed only for conversion. The GPU retains the geometry and base colour, normal and packed occlusion/roughness/metallic textures.

The supplied `Meta_Quest_3.usdz` model preserves all 47,622 vertices and 76,260 triangles. Conversion removes its outer presentation scale, rotates the forward direction into WebXR negative Z and aligns the geometric lens midpoint to the head origin. The manifest records the original transforms, scale correction and source hashes. `NOTICE` retains the model's CC-BY-4.0 attribution to Elin.

The visual rig transform does not change the camera calibration profile. Recordings embed the geometry, texture pixels, material and placement using the `CQM1` headset asset format.

## Calibration

Camera calibration profiles use version 1 JSON with pixel-space fx, fy, cx and cy, source width and height, five Brown-Conrady distortion coefficients, camera-to-head translation in metres and an XYZW unit quaternion. Image axes are X right/Y down. Camera transforms use the viewer's X-right/Y-up/Z-back convention. Optional flip_x and flip_y values describe image transformations.
