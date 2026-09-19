CERES 1.1.3 brings clearer native viewer controls, saved-map placement and more reliable pairing to self-hosted Quest capture, recording, replay and LeRobot v3 export.

- Unified fonts, text sizes and field alignment throughout the viewer. Spatial map controls are grouped into acquisition, appearance and storage, with responsive layouts and keyboard navigation.
- Added Spectral, Viridis, Plasma, Inferno and Greys gradients for distance, recency and confidence colours, selected from a preview strip.
- Saved maps can be translated, rotated and scaled independently on each axis before placement. **FUSE** merges live depth into the placed map, while recording depth and saved maps have independent visibility and opacity during replay.
- Confirmed surfaces retain fine detail as weaker regions coarsen under storage pressure. Newly acquired points fade in over the measured depth-update interval, and the point budget uses the selected file allowance.
- Live capture and replay keep task descriptions, repetition boundaries and recording controls accessible alongside the scene. Recorded depth remains available when live acquisition is disabled.
- Pairing uses unambiguous letters, accepts mixed case and surrounding whitespace and adapts to the code length supported by the service. Rate-limit deadlines survive restarts and pairing changes, while rejected requests stop automatic retries until reconnecting.

Download the viewer for [Windows x64](https://github.com/hcltech-robotics/ceres/releases/download/v1.1.3/ceres-viewer-1.1.3-windows-x64.zip), [Linux x64](https://github.com/hcltech-robotics/ceres/releases/download/v1.1.3/ceres-viewer-1.1.3-linux-x64.tar.gz) or [Linux ARM64](https://github.com/hcltech-robotics/ceres/releases/download/v1.1.3/ceres-viewer-1.1.3-linux-arm64.tar.gz). Each package includes the native exporter, FFmpeg, runtime libraries and licence notices. Extract it and run `ceres-viewer.exe` on Windows or `./ceres-viewer` on Linux.

Windows packages target Windows 11 with an NVIDIA GPU. Linux x64 targets Ubuntu 22.04 or newer, and Linux ARM64 targets Ubuntu 24.04 or newer on NVIDIA GB10. The installed NVIDIA driver supplies graphics and video decoding.

Release assets also include the source, standalone Node.js runtime, container and Python receiver. Downloads include platform manifests, SPDX SBOMs and signed checksums. For locally assembled downloads, verify the complete directory with `node scripts/prepare-local-release.mjs verify release --signer chrisvoncsefalvay`. GitHub Actions releases include Sigstore bundles for `gh attestation verify <file> --repo hcltech-robotics/ceres`.

See the [viewer guide](https://github.com/hcltech-robotics/ceres/blob/v1.1.3/native/viewer/README.md) for pairing, recording, replay and export. CERES is licensed under MIT. Cite version 1.1.3 using the [project DOI](https://doi.org/10.5281/zenodo.22729060).
