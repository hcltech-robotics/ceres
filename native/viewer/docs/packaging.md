# Packaging

Each CERES release provides a separate viewer download. The archive contains the viewer, the native LeRobot exporter, FFmpeg and FFprobe, redistributable assets, runtime libraries, licence notices and source provenance. The installed NVIDIA driver supplies CUDA driver, NVDEC and OpenGL services. The CUDA toolkit is required to build the viewer.

| Package | Build baseline | CUDA device targets |
| --- | --- | --- |
| `ceres-viewer-VERSION-windows-x64.zip` | Windows x64, CUDA 12.4.1 | 75, 86 and 89 |
| `ceres-viewer-VERSION-linux-x64.tar.gz` | Ubuntu 22.04 x64, CUDA 12.9.1 | 75, 86, 89 and 120 |
| `ceres-viewer-VERSION-linux-arm64.tar.gz` | Ubuntu 24.04 ARM64 SBSA, CUDA 13.0.2 | 75, 80, 86, 89, 90, 100, 120 and 121 |

The ARM64 package targets SBSA machines with compatible NVIDIA graphics and video decoding support. DGX Spark is the ARM64 hardware qualification host. Its compute capability does not set the package's minimum GPU target. Jetson requires its own JetPack build. Apple builds are separate from this NVIDIA release matrix.

The root `package.json` supplies the viewer version. The exporter is built from the sibling `native/lerobot-exporter` directory using its Cargo lock and the same repository revision. Source archives can be built without Git metadata. When packaging an extracted source archive, set `CERES_SOURCE_REVISION` to its full release commit and `SOURCE_DATE_EPOCH` to that commit's Unix timestamp. `CERES_RELEASE_VERSION`, when supplied, must match the root package version.

## Windows

From `native/viewer`, after building the application:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-windows.ps1 `
    -BuildDirectory build-native `
    -FfmpegRoot D:\dependencies\ffmpeg `
    -OutputDirectory D:\releases\native
```

`-PackageName` selects the archive's directory name. Each assembly requires an unused destination. `-NoArchive` produces the staged directory alone. `-SkipViewerStartupCheck` supports hosted build workers without an NVIDIA display driver.

Assembly uses the CMake compiler identity to locate its Visual Studio app-local runtime and resolves imported DLLs, including the CUDA runtime. The optional viewer startup check uses the Windows system path with the CUDA toolkit environment removed.

## Linux

From `native/viewer`:

```sh
BUILD_DIRECTORY="$PWD/build-native" \
OUTPUT_DIRECTORY="$PWD/dist" \
PACKAGE_PLATFORM=linux-x64 \
FFMPEG_ROOT=/opt/ceres-ffmpeg \
bash scripts/package-linux.sh
```

Use `PACKAGE_PLATFORM=linux-arm64` for an ARM64 SBSA build. The release workflow supplies the CUDA device targets listed above explicitly. To reproduce its ARM64 configuration, pass `'-DCMAKE_CUDA_ARCHITECTURES=75;80;86;89;90;100;120;121'` to CMake with CUDA 13.0.2.

ARM64 source builds default to `75;80;86;89;90`, which CUDA 12.x can compile. These numeric targets include both native GPU code and PTX for later GPUs. Set `CMAKE_CUDA_ARCHITECTURES` explicitly to select another target set supported by the installed toolkit. Use a fresh build directory or set this option when changing an existing build's cached targets.

`PACKAGE_NAME` overrides the versioned default name. `CUDA_ROOT` selects the build toolkit when it cannot be derived from the configured CUDA compiler.

FFmpeg and FFprobe can be in the supplied directory or its `bin` subdirectory. The distribution must contain its licence and source notices, or `FFMPEG_LICENCES` must name their directory. The release workflow builds FFmpeg and x264 from pinned source revisions, with their source archives and build recipe included in the package. FFmpeg must expose the `libx264` encoder.

The Linux launcher resolves bundled libraries from the adjacent `lib` directory. NVIDIA graphics libraries and the base C library come from the operating system. Build workers can resolve the CUDA driver through toolkit stubs, while hardware qualification uses the installed NVIDIA driver and graphics context.

## Package verification

The package contains `MANIFEST.json`, `SHA256SUMS` and an SPDX 2.3 inventory at `SBOM.spdx.json`. Adjacent archive sidecars contain the archive checksum, manifest and SPDX document. The manifest records the source revision, release version, platform, CUDA architectures and every payload file's size and SHA-256 digest. Symlink targets are recorded explicitly.

The `provenance` directory retains the root package metadata, sibling exporter revision, Cargo lock, dependency declarations, exporter capabilities and FFmpeg source/build receipts. The positive asset allowlist in `assets/redistributable.json` includes fonts, the Apache 2.0 SOMA-X hand meshes and the attributed Quest model. The hand metadata records the pinned model revisions and conversion checksum. User-supplied MANO data is excluded.

Python 3.11 or later verifies a fresh extraction and runs a complete bundled export:

```sh
python scripts/verify-package.py \
  --archive dist/ceres-viewer-VERSION-linux-x64.tar.gz \
  --platform linux-x64 --version VERSION \
  --output /tmp/ceres-package-check
```

The output directory must be empty. Verification checks archive paths, file hashes, architecture, release identity, asset policy and transitive runtime dependencies. The bundled FFmpeg generates H.264 video, which is combined with tracked head/hand samples in an MCAP fixture. The bundled exporter writes a CERES LeRobot dataset, and FFprobe plus a full software decode check its output video. A JSON report records the archive hash and the verified source identity. No third-party Python modules are required.

## Release gates

Hosted workers build all three packages and run native CPU tests, exporter tests and fresh-extraction checks. GPU test executables are retained for trusted hardware qualification. [Hardware qualification](qualification.md) runs initially and whenever relevant viewer, exporter, asset or build inputs change.

Archive entries are ordered and use `SOURCE_DATE_EPOCH`, with numeric ownership in Linux archives. Repeating assembly from the same binaries, sources, assets and notices produces the same archive when the archive tool version, package name and timestamp match.
