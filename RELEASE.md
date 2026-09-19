CERES provides self-hosted Quest capture, Solo recording, director pairing and Bridge streaming with LeRobot v3 export.

The source is licensed under MIT. Documentation and the project citation are available at https://ceres.cam/documentation/ and https://ceres.cam/about/#ceres-citation.

Release assets include the source, standalone Node.js runtime, container, Python receiver and separate native viewer packages for Windows x64, Linux x64 and Linux ARM64. Each viewer download includes its native exporter, FFmpeg and runtime libraries. The NVIDIA display driver comes from the system.

Download the viewer for [Windows x64](https://github.com/hcltech-robotics/ceres/releases/download/v1.1.1/ceres-viewer-1.1.1-windows-x64.zip), [Linux x64](https://github.com/hcltech-robotics/ceres/releases/download/v1.1.1/ceres-viewer-1.1.1-linux-x64.tar.gz) or [Linux ARM64](https://github.com/hcltech-robotics/ceres/releases/download/v1.1.1/ceres-viewer-1.1.1-linux-arm64.tar.gz). Extract the package and run `ceres-viewer.exe` on Windows or `./ceres-viewer` on Linux. Windows targets Windows 11, Linux x64 targets Ubuntu 22.04 or newer and Linux ARM64 targets Ubuntu 24.04 or newer on NVIDIA GB10.

Downloads include platform manifests, SPDX SBOMs and signed checksums. For a locally assembled release, verify the complete directory with `node scripts/prepare-local-release.mjs verify release --signer chrisvoncsefalvay`. This checks the SSH signature against the maintainer's independently retrieved GitHub key and then checks every download. Releases built by GitHub Actions also include Sigstore verification bundles for `gh attestation verify <file> --repo hcltech-robotics/ceres`.

Load the container with `docker load --input ceres-container.tar.gz`. The image is `ceres-release:latest` and can run without registry access.

Cite CERES 1.1.1 with DOI https://doi.org/10.5281/zenodo.22729061.
