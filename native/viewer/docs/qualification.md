# Hardware qualification

Viewer release qualification covers Windows x64 on an RTX 3090, Linux x64 on an RTX 6000 Pro and Linux ARM64 on a GB10. Each run uses the downloaded package and the matching GPU test executables. An NVIDIA OpenGL context is required for CUDA/OpenGL interop and rendering.

Hosted build workers run the native CPU tests and package exporter round trip. Trusted GPU hosts run the CUDA image, stereo, voxel, depth and NVDEC tests, then exercise the packaged viewer with bounded recording and replay. The viewer records actual GPU identity, driver, graphics context and frame/decode counters with its evidence. A hidden window provides the same graphics context without interrupting the desktop.

The hardware receipt identifies the package hash, release version, source revision and relevant build-input fingerprint. Release checks accept an existing successful receipt when that fingerprint is unchanged. Changes to viewer/exporter code, packaged assets, GPU fixtures or toolchain inputs require a fresh receipt. Version-only releases reuse the qualification of the same relevant inputs.

## Run qualification

On the matching GPU host, use the verifier and GPU test bundle from the trusted build:

```sh
python native/viewer/scripts/qualification.py record \
  --root . \
  --archive release/native/ceres-viewer-VERSION-linux-x64.tar.gz \
  --inputs release/native/workflow-inputs.json \
  --build-tests release/native/gpu-tests \
  --output qualification-linux-x64.json \
  --work-dir /tmp/ceres-hardware-check
```

Each run needs an unused working directory. Use the corresponding Windows or ARM64 paths on those platforms. Keep qualification processes bounded on unified-memory systems such as GB10.

Only reviewed source and the associated package run on persistent GPU machines. Public pull requests use hosted workers. Maintainers transfer the built package and tests to trusted GPU hosts and attach the resulting receipt after checking its identity and evidence.

## Check a release

The release gate checks all three package manifests against their hardware receipts:

```sh
python native/viewer/scripts/qualification.py check \
  --root . --artifacts release/native \
  --receipts native/viewer/qualification
```

The NVDEC test compares decoded NV12 pixels against independently decoded FFmpeg reference frames. Recording checks cover complete MCAP framing, pose/video observations, successful finalisation and replay. Package verification separately checks the bundled exporter and FFmpeg from a clean extraction, including dataset frame counts and complete video decoding.
