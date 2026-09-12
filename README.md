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

CERES captures outward video, audio, head pose and hand tracking on Meta Quest,
aligns them with task and run metadata and exports LeRobot v3 datasets.
It supports paired capture with a director browser, Solo capture on the headset
and Bridge streaming to a Python receiver.

Run CERES on your own infrastructure or work on its recorder, capture and export
logic. Recordings stay in browser storage or your selected local destination.


## Three modes, one system

| Mode | How you work | Local route |
| --- | --- | --- |
| **Solo** | Configure, record, review and export a run entirely on the headset. | `/launch/capture/?mode=solo` |
| **Duet** | Prepare tasks and supervise a demonstrator from another browser. | `/monitor/` |
| **Bridge** | Stream live video, head pose and both hands to a Linux application. | `/bridge/` |

## Run CERES

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
on Windows. To run the container behind your HTTPS reverse proxy, set
`CERES_PUBLIC_ORIGIN` and run `docker compose up -d`.

Hugging Face uploads and Gist imports are enabled separately with
`CERES_ALLOW_HUGGING_FACE=1` and `CERES_ALLOW_GIST=1`. Core capture and local export
use local assets and make no external service calls. Voice model files are served
from `/models/` on the same host. Speech recognition is enabled with
`CERES_SPEECH_ENABLED=1` and a local ASR endpoint.

## Licence and citation

CERES is licensed under [MIT](LICENCE.md). When CERES contributes to your work,
please cite the version you used using [CITATION.cff](CITATION.cff) or
[citation.bib](citation.bib). The same citation is available on the
[CERES website](https://ceres.cam/about/#ceres-citation).

Third-party components retain their respective licences. Release artefacts
include an SBOM, checksums and signed build provenance.

## Develop the core

Run `npm run check`, `npm test` and `npm run build` against your changes. These
commands use public source and dependencies. Submit core changes through a pull
request. Official releases also verify the complete export manifest with
`npm run check:boundary -- --verify-export`.
