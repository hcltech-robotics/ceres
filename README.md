<p align="center">
  <a href="https://ceres.cam/">
    <img src="receiver/assets/ceres-logo.webp" alt="CERES" width="200">
  </a>
</p>

<h1 align="center">
  CERES<br>
  <sub><a href="https://nerc2026.github.io/">[NERC'26]</a></sub>
</h1>

<p align="center">
  <strong>Egocentric capture for robotics and embodied AI.</strong>
</p>

<p align="center">
  <a href="https://ceres.cam/documentation/setup-and-system-requirements/"><img src="https://img.shields.io/badge/Meta_Quest-3-0081FB?style=flat-square&amp;logo=meta&amp;logoColor=white" alt="Meta Quest 3"></a>
  <a href="https://ceres.cam/"><img src="https://img.shields.io/badge/Built_for-WebXR-5A45FF?style=flat-square" alt="Built for WebXR"></a>
  <a href="https://ceres.cam/documentation/data-description-and-output-format/"><img src="https://img.shields.io/badge/Datasets-LeRobot_v3-FFD21E?style=flat-square&amp;logo=huggingface&amp;logoColor=black" alt="LeRobot v3 datasets"></a>
  <a href="LICENCE.md"><img src="https://img.shields.io/badge/Licence-MIT-4C76BA?style=flat-square" alt="Licence: MIT"></a>
  <a href="https://doi.org/10.5281/zenodo.22729061"><img src="https://zenodo.org/badge/DOI/10.5281/zenodo.22729061.svg" alt="DOI: 10.5281/zenodo.22729061"></a>
</p>

<p align="center">
  <a href="https://ceres.cam/"><strong>Open CERES</strong></a>
  &nbsp;&middot;&nbsp;
  <a href="https://ceres.cam/documentation/">User guide</a>
  &nbsp;&middot;&nbsp;
  <a href="https://ceres.cam/documentation/getting-started/">Quickstart</a>
  &nbsp;&middot;&nbsp;
  <a href="https://huggingface.co/spaces/chrisvoncsefalvay/ceres-dataset-viewer">Dataset viewer</a>
</p>

---

CERES, **Capturing Egocentric Recordings with Ease and Speed**, turns a Meta Quest
headset into an egocentric recording and live streaming system. It combines the
wearer's view with audio, head pose, articulated hand tracking and task metadata
so that demonstrations can be recorded, supervised, reviewed and exported for
robotics and embodied AI.

Run it in the Quest browser, pair it with a capture director's browser or stream
its observations into a Python application. This repository contains the core
application, recorder, dataset exporter, self-hosting server and Bridge receiver.
The [user documentation](https://ceres.cam/documentation/) covers setup, capture
workflows, data formats and integrations.

## What CERES records

| Stream | Contents |
| --- | --- |
| Outward video | The headset wearer's view of the task and objects being manipulated |
| Audio | Microphone audio aligned with the recording |
| Head pose | Head position and orientation in the XR reference space |
| Hands | Both hands' joint positions, orientations, radii and tracking validity |
| Task metadata | Task definitions, instructions, runs, takes and review decisions |
| Timing and quality | Timestamps, recording-slot accounting and explicit gaps in observations |

The recorder uses a fixed-rate clock and writes blocks into browser-local storage.
Capture and export run independently of visualisation so that rendering does not
set the recording pace. In paired capture, acknowledged blocks also reach the
capture director or configured local host. Review accepted takes and export
LeRobot v3 datasets with aligned media, sensor rows and task metadata.

Read the [output format](https://ceres.cam/documentation/data-description-and-output-format/)
and [review and export guide](https://ceres.cam/documentation/review-and-export/).

## Three modes, one system

| Mode | How you work | Local route |
| --- | --- | --- |
| **Solo** | Configure, record, review and export a run entirely on the headset. | `/launch/capture/?mode=solo` |
| **Duet** | Prepare tasks and supervise a demonstrator from another browser. | `/monitor/` |
| **Bridge** | Stream live video, head pose and both hands to a Linux or macOS application. | `/bridge/` |

**Solo** keeps task selection, recording, review and export on the headset.
**Duet** gives a capture director a separate view of readiness, task progress and
the live feed while the demonstrator follows instructions in XR. Both use the
same task model and recorder. **Bridge** feeds live observations to a receiver
for visualisation, retargeting and robotics applications.

## Example uses

### Collect demonstrations for robot learning

Record hand-object interactions such as folding laundry, arranging objects or
placing a cup on a saucer. Use Solo for individual collection or Duet when a
capture director needs to cue tasks and review takes. Export the accepted
episodes as LeRobot v3 datasets and inspect them with the
[CERES dataset viewer](https://huggingface.co/spaces/chrisvoncsefalvay/ceres-dataset-viewer).

### Retarget two arms with Bridge

The [XLeRobot dual-arm example](receiver/examples/dual_arm.py) maps left and right
wrist poses to two robot arm models through a fixed coordinate transform. CPU
inverse kinematics produces joint positions, while thumb-to-index distance
controls each gripper. It includes the XLeRobot model geometry and an optional
IsaacTeleop adapter.

The Foxglove workspace presents two 3D views, one for the robot and one for Quest
acquisition, alongside live video, wrist position and rotation waveforms, arm
joint plots, frame rates and process load. It runs without Isaac Sim. The Python
API exposes the joint targets and link transforms for application integration.

Follow the [receiver installation guide](receiver/README.md) for Ubuntu or macOS, then run these commands from the `receiver` directory:

```sh
python -m pip install '.[worker,foxglove,teleop]'
ceres-bridge listen --app-origin https://ceres.example.org --name dual-arm-demo
```

Open `/bridge/` on the Quest at that deployment and enter the displayed pairing
code. For camera video, enable the camera and choose the left or right outward
camera, then enter XR to start streaming. Optional WebXR environment depth travels
independently to supporting receivers. A motion and depth session can start
without enabling an RGB camera. In another terminal in the same environment:

```sh
ceres-bridge foxglove --robot xlerobot --robot-rate 60
```

Open the printed Foxglove connection and import its dual-arm layout. Follow the
[dual-arm guide](https://ceres.cam/documentation/dual-arm-demo/) for frame mapping,
tracking-loss behaviour, model assets and the IsaacTeleop adapter.

### Connect perception and robotics applications

Read the latest observations through the [Python receiver](receiver/src/ceres_bridge),
publish them through the [ROS 2 adapter](receiver/ros2) or inspect them in Foxglove.
Bridge provides a shared acquisition source for applications that consume camera
frames, head pose and hand motion. The receiver keeps video and pose updates
independent and exposes tracking freshness to its consumers.

### Record within your own environment

Host the application and signalling server on infrastructure you control. Keep
recordings in browser storage or a selected local destination, and use local
dataset export. The core has no hosted-account requirement or analytics service.
Hugging Face uploads, Gist imports and speech services are explicit options.

## Run CERES

Use the [signed release](https://github.com/hcltech-robotics/ceres/releases/latest)
for the native viewer, standalone Node.js runtime or container, or build the source locally.

### Run the native viewer

Ceres viewer receives Bridge streams in a native 3D scene with anatomical SOMA-X
hands, a textured Quest 3 model, camera planes and depth. It records MCAP sessions
and exports LeRobot datasets. Download the package for your machine from the
release assets:

| Platform | Download | System |
| --- | --- | --- |
| Windows x64 | [Download ZIP](https://github.com/hcltech-robotics/ceres/releases/download/v1.1.2/ceres-viewer-1.1.2-windows-x64.zip) | Windows 11 with an NVIDIA GPU |
| Linux x64 | [Download tar.gz](https://github.com/hcltech-robotics/ceres/releases/download/v1.1.2/ceres-viewer-1.1.2-linux-x64.tar.gz) | Ubuntu 22.04 or newer with an NVIDIA GPU |
| Linux ARM64 | [Download tar.gz](https://github.com/hcltech-robotics/ceres/releases/download/v1.1.2/ceres-viewer-1.1.2-linux-arm64.tar.gz) | Ubuntu 24.04 or newer on NVIDIA GB10 |

Extract the archive and start `ceres-viewer.exe` on Windows or `./ceres-viewer` on
Linux. Each download includes the exporter, FFmpeg, runtime libraries, product
documentation and licence notices. Install the NVIDIA display driver for your
machine. The CUDA toolkit is needed only when building from source.

**Recording** contains the save destination, episode review, LeRobot export and
Hugging Face upload. Sign in through the browser, choose an organisation or
username and repository, then upload the recording with its episode selections
and optional LeRobot export. **Replay** opens a local file or lists the MCAP
recordings in a Hugging Face repository. Select a recording to download and play
it using the bottom timeline, frame controls and speed selector.

The recording toolbar can restart a repetition with a short **Replay** press or
restart the task with a long press. During a prescribed pause, these controls
return to the preceding repetition or task. **Done** completes a repetition,
**Next** ends a prescribed pause and **Pass**/**Fail** mark the result and advance.
The **Publish** section is empty. The included SOMA-X meshes retain their Apache
2.0 licence and source provenance, and users can also load authorised MANO assets
locally.

The **Spatial map** pane controls TSDF fusion, freeze/resume, point size, spacing and
display density. Distance colours follow the current headset position, with Recency
and Confidence available as alternative shaders. Maps save automatically as `.cmap`
files within a configurable size limit and reopen frozen. Automatic storage keeps
the three most recent maps.

The archive's version matches its CERES release. Compare its SHA-256 digest with
the signed `SHA256SUMS` file. To verify a complete locally assembled release,
run `node scripts/prepare-local-release.mjs verify release --signer chrisvoncsefalvay`
from the source checkout. This verifies the SSH signature against the
maintainer's GitHub key and checks every download. Releases built by GitHub
Actions also support `gh attestation verify <archive> --repo hcltech-robotics/ceres`.
Platform manifests record the source revision, compiler, CUDA runtime and bundled
dependencies.

The [viewer guide](native/viewer/README.md) describes pairing, recording, replay
and the source build.

### Build from source

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.127 --locked
npm ci
npm run build
npm start
```

Set `CERES_PUBLIC_ORIGIN` to the deployment's HTTPS origin, `CERT_FILE` and
`KEY_FILE` to its certificate and key, and `CERES_DATA_DIR` to persistent storage.
The director is at `/monitor/` and headset capture is at `/launch/capture/`.
Use `/launch/capture/?mode=solo` for Solo.

The source build uses Node.js 22 and Rust 1.91.0, selected by `rust-toolchain.toml`.
The runtime archive starts with `node dist-server/ceres-server.cjs`, or `./start.ps1`
on Windows.

### Run the container

Download `ceres-container.tar.gz` from the
[release](https://github.com/hcltech-robotics/ceres/releases/latest) and verify its
digest against the signed `SHA256SUMS` file.
To run the container behind your HTTPS reverse proxy, set `CERES_PUBLIC_ORIGIN`
and load the image before starting Compose:

```sh
docker load --input ceres-container.tar.gz
docker compose up -d
```

The container archive can be transferred to a host without network access.
Compose uses the loaded image and persistent local storage.

Hugging Face uploads and Gist imports are enabled separately with
`CERES_ALLOW_HUGGING_FACE=1` and `CERES_ALLOW_GIST=1`. Core capture and local export
use local assets and make no external service calls. Voice model files are served
from `/models/` on the same host. Speech recognition is enabled with
`CERES_SPEECH_ENABLED=1` and a local ASR endpoint.

## Develop the core

Run `npm run check`, `npm test` and `npm run build` against your changes. These
commands use public source and dependencies. Submit core changes through a pull
request. Official releases also verify the complete export manifest with
`npm run check:boundary -- --verify-export`.

| Source | Responsibility |
| --- | --- |
| `src/` and `ui/` | Quest capture, director interface, browser workers and XR controls |
| `src/recorder/` | Recording clock, block encoding and durable browser storage |
| `src/lerobot-export/` and `wasm/` | Dataset export and Wasm recorder/export kernels |
| `shared/` | Task, recording and signalling contracts |
| `server/` | Self-hosted HTTP/WebSocket server, pairing and local recording storage |
| `receiver/` | Python Bridge receiver, ROS 2, Foxglove and dual-arm example |
| `native/viewer/` | Native Windows/Linux viewer, recording and runtime packaging |
| `native/lerobot-exporter/` | Native LeRobot exporter used by the viewer |
| `test/` | Core behaviour, storage, protocol and browser checks |

Hosted CI builds the public source, checks it on Linux and Windows, rebuilds the
source archive and produces separate viewer packages for Windows x64, Linux x64
and Linux ARM64. Native runtime changes require matching NVIDIA hardware
qualification before publication. Releases include SPDX SBOMs, signed checksums
and source provenance. Locally assembled releases use a maintainer's SSH
signature and hosted releases also include Sigstore signatures and attestations.

For local release assembly, collect the three verified platform directories with
`node scripts/collect-native-release.mjs native-artifacts release`, then add the
source, runtime, container, receiver distributions, SBOMs and successful hardware
qualification report. Set `GITHUB_SHA` to the exact public source commit. Run
`node scripts/prepare-local-release.mjs prepare release --signer chrisvoncsefalvay --signing-key <key-path>`
to sign and verify the complete payload. The key must already belong to the
maintainer's GitHub account. The publisher checks the matching `v<version>` tag
on public `main`, uploads and verifies every draft asset, then publishes once
with `node scripts/publish-public-release.mjs release`. It reads the public
repository, tag and credentials from `GITHUB_REPOSITORY`, `GITHUB_REF_NAME` and
`GH_TOKEN`.

## Licence and citation

CERES is licensed under [MIT](LICENCE.md). When CERES contributes to your work,
please cite the version you used. The citation below is also available in
[CITATION.cff](CITATION.cff), [citation.bib](citation.bib) and on the
[CERES website](https://ceres.cam/about/#ceres-citation).

```bibtex
@software{hcltech_robotics_ceres_2026,
  author  = {Foldi, Tamas and von Csefalvay, Chris and Unni Krishnan, Achyuthan},
  title   = {{CERES: Capturing Egocentric Recordings with Ease and Speed}},
  year    = {2026},
  version = {1.1.2},
  doi     = {10.5281/zenodo.22729061},
  url     = {https://github.com/hcltech-robotics/ceres},
  license = {MIT}
}
```

Third-party components retain their respective licences. The XLeRobot model
assets and derived geometry retain Apache-2.0 attribution, with source and
conversion records included in the receiver package.
