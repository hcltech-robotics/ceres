# CERES

CERES captures outward video, audio, head pose and hand tracking on Meta Quest,
aligns them with task and run metadata and exports LeRobot v3 datasets.
It supports paired capture with a director browser, Solo capture on the headset
and Bridge streaming to a Python receiver.

Run CERES on your own infrastructure or work on its recorder, capture and export
logic. Recordings stay in browser storage or your selected local destination.

[Documentation](https://ceres.cam/documentation/)

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

CERES is licensed under [MIT](LICENCE.md). When CERES contributes to your work,
please cite the version you used using [CITATION.cff](CITATION.cff) or
[citation.bib](citation.bib). The same citation is available on the
[CERES website](https://ceres.cam/about/#ceres-citation).

Third-party components retain their respective licences. Release artefacts
include an SBOM, checksums and signed build provenance.
