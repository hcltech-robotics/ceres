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
| **Bridge** | Stream live video, head pose and both hands to a Linux application. | `/bridge/` |

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

From the `receiver` directory in an Ubuntu 24.04 Python 3.12 environment:

```sh
python -m pip install '.[worker,foxglove,teleop]'
ceres-bridge listen --app-origin https://ceres.example.org --name dual-arm-demo
```

Open `/bridge/` on the Quest at that deployment, enter the displayed pairing code
and select **Start streaming**. In another terminal in the same environment:

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

Use the [signed release](https://github.com/hcltech-robotics/ceres/releases/tag/v1.1.0)
for a standalone Node.js runtime or container, or build the source locally.

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
[release](https://github.com/hcltech-robotics/ceres/releases/tag/v1.1.0) and verify it
with `gh attestation verify ceres-container.tar.gz --repo hcltech-robotics/ceres`.
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
| `test/` | Core behaviour, storage, protocol and browser checks |

Hosted CI builds the public source, checks it on Linux and Windows, rebuilds the
source archive and produces release packages. Releases include SPDX SBOMs,
checksums, Sigstore signatures and build provenance. Verify a downloaded release
artefact with `gh attestation verify <file> --repo hcltech-robotics/ceres`.

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
  version = {1.1.0},
  doi     = {10.5281/zenodo.22729061},
  url     = {https://github.com/hcltech-robotics/ceres},
  license = {MIT}
}
```

Third-party components retain their respective licences. The XLeRobot model
assets and derived geometry retain Apache-2.0 attribution, with source and
conversion records included in the receiver package.
