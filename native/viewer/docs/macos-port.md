# Apple Silicon macOS port

The application port is in progress. There is no distributable macOS viewer yet.
`CERES_GRAPHICS_BACKEND=AUTO` selects `METAL` and `CERES_VIDEO_BACKEND=AUTO`
selects `VIDEOTOOLBOX` on macOS. The current Metal build exposes the core, service
tests and backend feasibility probes. Enabling the full application reports the
missing renderer explicitly, instead of falling through to CUDA configuration.

## Build the first implementation gate

Use an Apple Silicon Mac, macOS 14 or newer, Xcode 26 or newer, CMake 3.25 or
newer and Ninja. The build host may run a newer macOS release. Xcode 26's C++
library supplies `std::jthread` and `std::stop_token` without experimental flags.
Select the desired Xcode with `DEVELOPER_DIR`; do not change the system selection
on a shared build machine. If the Metal compiler is missing, install its Xcode
component using `xcodebuild -downloadComponent MetalToolchain`.

From the repository root:

```sh
cmake -S native/viewer -B build-macos -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=14.0 \
  -DCERES_BUILD_APP=OFF -DCERES_BUILD_APP_SERVICES=ON \
  -DCERES_BUILD_BACKEND_PROBES=ON
cmake --build build-macos --parallel 3
ctest --test-dir build-macos --output-on-failure -LE 'gpu|display'
python3 native/viewer/scripts/probe-macos.py --build build-macos \
  --output macos-backend-evidence --require-baseline
```

The last command requires a physical Apple M1 with 16 GiB RAM. Omit
`--require-baseline` when diagnosing other Apple Silicon hardware; its receipt
records `baseline_match=false` and must not be used to claim M1 qualification.
The output directory must not already exist. Probe receipts deliberately use a
separate schema from release qualification and set `application_qualified=false`.

The hosted macOS workflow compiles the probes, checks Mach-O arm64/deployment and
runtime dependency closure, and runs portable/service/export tests. It does not
claim hardware decoding, GPU performance or display presentation based on a
hosted runner. Its `ceres-macos-foundation-probes-REVISION` artifact contains a
`.tar.gz` archive that preserves executable permissions. Download and unpack it
on the physical Mac, then run (with Python 3):

```sh
cd ceres-macos-backend-probes
python3 probe-macos.py --build . --fixtures fixtures \
  --output ../macos-backend-evidence --require-baseline
```

This runs the same shaders and decoder fixtures built by CI, without rebuilding
on the Mac. Keep the full evidence directory, including the input hashes, logs
and decoder, image-conversion and reduction reports. It is not a signed application or a distribution test.

For a CPU-only build, leave both `CERES_BUILD_APP_SERVICES` and
`CERES_BUILD_BACKEND_PROBES` off. No CUDA, Objective-C++, windowing or Apple GPU
framework dependencies are required by that configuration. Platform path and
trust-root helpers use CoreFoundation and Security on macOS.

## Implemented boundaries

- `VideoDecoder` owns the common bounded worker, replay generations, cancellation,
  keyframe recovery, metadata and lease presentation. Device startup completes
  before the live queue starts aging frames. GPU-specific types are confined to
  backend implementation headers.
- The NVIDIA adapter retains the existing CUVID/Jetson decode implementations,
  CUDA context lifetime, cropped plane transfers and four-surface presentation
  pool. Existing leases survive resets and decoder destruction.
- VideoToolbox converts Annex B access units to length-prefixed samples and
  rebuilds hardware-required sessions when SPS/PPS change. Its four outstanding
  decode submissions and four retained presentation slots bound internal queues.
  Pixel buffers become R8/RG8 Metal textures through a shared texture cache. Frame
  leases retain both CoreVideo textures, the pixel buffer and the Metal device.
  GPU consumers must retain their lease until command-buffer completion.
- The decoder probe uses the existing independent FFmpeg NV12 references across
  resolution changes. It also covers dual-camera metadata, retained frames,
  preroll and rapid seek/cancel generations. Metal readback is test-only.
- Metal NV12 conversion ports limited/full range, BT.601/BT.709 matrices, image
  flips and calibrated radial/tangential undistortion. Encoding stays on the GPU
  and does not wait or read pixels back. CUDA and Metal adapters share the same
  image assertions and tolerances; hardware parity is pending the physical gate.
  The Metal application renderer does not consume this kernel yet.
- The reduction probe sorts 262,144 records with 64-bit spatial keys and stable
  observation identifiers, then performs segmented compensated FP32 summation.
  It checks exact evidence counts and compares sums against an FP64 CPU reference.
  It uses no FP64, 64-bit atomics or CUDA warp assumptions. This is a feasibility
  probe, not TSDF fusion or a validated production sorting implementation.
- macOS helpers locate bundle resources and sibling executables independently of
  the working directory. Preferences/private state use Application Support,
  downloads use Caches, default recordings use Movies/Ceres Viewer, and a custom
  `--config-dir` isolates private state and caches. Browser launch and exporter
  process groups use macOS APIs. curl uses SecureTransport; libdatachannel receives
  system roots through Security.framework, retaining CA override precedence.

## Remaining full-parity work

1. Pass the hardware decode and reduction gate on the M1 baseline. Measure sorting
   scratch memory and latency before selecting production TSDF data structures.
2. Implement CAMetalLayer/GLFW/ImGui presentation and extract shared camera/scene
   preparation. Port scene materials, skinning, trails, frusta, video planes, map
   shading, screenshots, GPU timing, Retina/display changes and completion-based
   resource reuse. The UI texture identifier now accommodates Metal object handles.
3. Validate/integrate Metal NV12 processing and undistortion; port stereo, environment-depth unprojection,
   TSDF fusion, coarsening, hand masking, LOD, snapshots and resumed saved-map
   fusion. Reuse backend-specific adapters for existing numerical/identity tests.
4. Assemble the self-contained app/exporter/FFmpeg bundle; relocate dylibs, sign
   nested code and the app, notarize and staple. Hash the final sealed payload in
   external manifests. The Mach-O verifier is ready; app packaging/signing and
   backend-aware full release qualification are still to be integrated.
5. Run cross-platform recording/map interchange, bundled import/export/replay,
   macOS interaction/sleep/reconnect checks, performance and 30-minute soak tests.
   Require the real 1080p/60 Hz presentation target on M1/16 GiB (58 fps minimum,
   p95 frame interval <=20 ms and p95 receive-to-presentation latency <=50 ms).
   Verify quarantined downloads on macOS 14 and a current release without developer
   tools. Only then add macOS to the required release matrix.

Developer ID credentials and physical hardware qualification remain release
prerequisites. A successful build or an offscreen image is not a release receipt.
