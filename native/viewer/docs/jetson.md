# Jetson Orin

The native viewer's Jetson backend uses JetPack's `NvVideoDecoder` and `NvBufSurface` APIs for H.264 hardware decoding. It imports decoded surfaces through EGL/CUDA and copies their separate luma and chroma planes into owned NV12 frames. CUDA arrays handle block-linear surfaces, while device pointers handle pitch-linear surfaces. The copy applies the visible crop and retains BT.601/BT.709 and full-range metadata.

Each camera has an independent decoder. Source timestamps, RTP timestamps, camera identities and replay metadata remain attached to the corresponding frame. Recording stores the original compressed events. Replay cancellation and source changes reset the decoder's prediction history and discard stale output, while retained presentation frames remain valid.

## Build

Use Jetson Orin Nano, Orin NX or AGX Orin with JetPack 6/Jetson Linux R36. The build uses CUDA target `87`. Jetson Thor and ARM64 SBSA machines use the CUVID backend with their own CUDA targets and driver stack.

Install the CUDA toolkit and `nvidia-l4t-jetson-multimedia-api` from the repositories matching the installed JetPack release. The usual viewer prerequisites also apply: a C++20 compiler, CMake 3.25 or newer, Ninja, Git, Python, pkg-config and the OpenGL/X11 development libraries. Use `-DGLFW_BUILD_WAYLAND=OFF` for an X11-only build.

From `native/viewer`:

```sh
bash scripts/build-jetson.sh -DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc
./build-jetson/ceres-viewer
```

`BUILD_DIRECTORY` selects the output directory, `BUILD_JOBS` sets build concurrency and `JETSON_API_ROOT` selects the Multimedia API source directory. The default is one build job. Additional arguments are passed to CMake.

A direct CMake build is equivalent:

```sh
cmake -S . -B build-jetson -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCERES_VIDEO_BACKEND=JETSON -DCMAKE_CUDA_ARCHITECTURES=87 \
  -DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc
cmake --build build-jetson --parallel 1
```

The JetPack backend links NVIDIA's `libv4l2.so.0` and `libnvbufsurface.so`. It does not load `libnvcuvid.so.1`. The viewer's status panel and metrics identify the selected backend as `Jetson V4L2`. Device initialisation errors include the underlying device error and the JetPack dependency to check. The process needs access to `/dev/nvhost-nvdec` and the JetPack graphics devices.

## Package

Build and package on the same JetPack installation. Install Python 3.11 or newer and Rust 1.91 or newer for packaging, then supply an ARM64 FFmpeg distribution with `libx264` and its licence notices:

```sh
BUILD_DIRECTORY="$PWD/build-jetson" \
PACKAGE_PLATFORM=linux-arm64-jetpack6 \
FFMPEG_ROOT=/opt/ceres-ffmpeg \
bash scripts/package-linux.sh
```

The archive is named `ceres-viewer-VERSION-linux-arm64-jetpack6.tar.gz`. Its manifest records the decoder backend, CUDA targets and Jetson Linux release. JetPack driver libraries come from the destination system. The package retains the redistribution notices for the compiled Multimedia API helper classes. The ARM64 SBSA package has a separate name and decoder dependency set.

## Checks

Generate the software reference and run the native tests on the Jetson:

```sh
python3 scripts/nvdec-reference.py --inputs tests/fixtures/nvdec
ctest --test-dir build-jetson --output-on-failure
```

The decoder fixtures compare complete NV12 images against software decoding through resolution changes, prediction loss and recovery. They also check two camera identities, coincident source timestamps, replay cancellation, source restart and frame leases surviving decoder destruction. The `video_backend` test exercises delayed hardware delivery, cropped CUDA arrays, separate plane pitches and shutdown with a frame still pending.

For a packaged build, run `scripts/verify-package.py` with `--platform linux-arm64-jetpack6`, then use the [hardware qualification procedure](qualification.md). Jetson qualification records the device model and `/etc/nv_tegra_release`, requires the V4L2 backend and checks recording, replay and both cameras on that system.

NVIDIA documents the [JetPack decoding flow](https://docs.nvidia.com/jetson/archives/r36.4/ApiReference/l4t_mm_02_video_dec_cuda.html) and [NvVideoDecoder interface](https://docs.nvidia.com/jetson/archives/r36.4/ApiReference/classNvVideoDecoder.html).
