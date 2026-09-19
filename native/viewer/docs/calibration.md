# Calibration profile

Calibration files are UTF-8 JSON. Version 1 stores source image dimensions, pixel-space intrinsics, five Brown-Conrady distortion coefficients and a camera-to-head rigid transform. Coordinates use metres, right-handed X-right/Y-up/Z-back and XYZW quaternions. Image coordinates use X-right/Y-down.

```json
{
  "version": 1,
  "name": "Quest 3 right camera",
  "side": "right",
  "width": 640,
  "height": 480,
  "fx": 395.0617283950617,
  "fy": 395.0617283950617,
  "cx": 320.0,
  "cy": 240.0,
  "distortion": [0, 0, 0, 0, 0],
  "translation": [0.064, -0.03, -0.035],
  "rotation": [0, 0.052335956, 0, 0.998629535],
  "flip_x": false,
  "flip_y": false
}
```

The example contains the built-in right camera preset. Replace it with measured values for a calibrated setup. `distortion` is ordered k1, k2, p1, p2, k3. `translation` locates the camera in head space and `rotation` transforms camera vectors into head space. The left preset mirrors the lateral offset and yaw.

The undistortion kernel samples the original camera image using the profile's distortion model. Intrinsics scale with image dimensions during conversion, with pixel-centre principal points. Image flips describe mirroring of the encoded image and apply after distortion, immediately before sampling. The camera plane uses the same optical axes and intrinsics, with its adjustable distance measured along camera negative Z.

The active profile is embedded in each recording and changes are recorded as calibration events. Replay restores the profile in effect at the selected time. Projection distance and opacity are presentation settings.

Measured left/right profiles for reconstruction use the [stereo calibration format](stereo-calibration.md).
