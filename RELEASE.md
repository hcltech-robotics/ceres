CERES provides self-hosted Quest capture, Solo recording, director pairing and Bridge streaming with LeRobot v3 export.

The source is licensed under MIT. Documentation and the project citation are available at https://ceres.cam/documentation/ and https://ceres.cam/about/#ceres-citation.

Release assets include the source, standalone Node.js runtime, container, Python receiver and separate native viewer packages for Windows x64, Linux x64 and Linux ARM64. Each viewer download includes its native exporter, FFmpeg and runtime libraries. The NVIDIA display driver comes from the system.

Download the viewer for [Windows x64](https://github.com/hcltech-robotics/ceres/releases/download/v1.1.1/ceres-viewer-1.1.1-windows-x64.zip), [Linux x64](https://github.com/hcltech-robotics/ceres/releases/download/v1.1.1/ceres-viewer-1.1.1-linux-x64.tar.gz) or [Linux ARM64](https://github.com/hcltech-robotics/ceres/releases/download/v1.1.1/ceres-viewer-1.1.1-linux-arm64.tar.gz). Extract the package and run `ceres-viewer.exe` on Windows or `./ceres-viewer` on Linux. Windows targets Windows 11, Linux x64 targets Ubuntu 22.04 or newer and Linux ARM64 targets Ubuntu 24.04 or newer on NVIDIA GB10.

The native viewer includes:

- Anatomical SOMA-X hands with 25-joint tracking, a textured Quest 3 model, camera video and depth. The Apache 2.0 hand assets include their source provenance, and authorised user-supplied MANO assets are supported locally.
- A **Recording** pane for the save destination, episode review, LeRobot export and Hugging Face uploads through browser sign-in.
- A separate **Replay** pane for local files and Hugging Face repositories. Browse and filter multiple MCAP recordings, then load a selection with its saved episode sidecar. The bottom playback strip provides a timeline, play/pause, frame stepping and speed controls.
- Recording toolbar controls for restarting a repetition with a short **Replay** press or restarting a task with a long press. During a prescribed pause, these return to the preceding repetition or task. **Done** completes a repetition, **Next** ends a prescribed pause and **Pass**/**Fail** mark the result and advance.
- An empty **Publish** section.

See the [viewer guide](https://github.com/hcltech-robotics/ceres/blob/v1.1.1/native/viewer/README.md) for pairing, recording, replay and export.

Downloads include platform manifests, SPDX SBOMs and signed checksums. For a locally assembled release, verify the complete directory with `node scripts/prepare-local-release.mjs verify release --signer chrisvoncsefalvay`. This checks the SSH signature against the maintainer's independently retrieved GitHub key and then checks every download. Releases built by GitHub Actions also include Sigstore verification bundles for `gh attestation verify <file> --repo hcltech-robotics/ceres`.

Load the container with `docker load --input ceres-container.tar.gz`. The image is `ceres-release:latest` and can run without registry access.

Cite CERES 1.1.1 with DOI https://doi.org/10.5281/zenodo.22729061.
