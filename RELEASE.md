CERES provides self-hosted Quest capture, Solo recording, director pairing and Bridge streaming with LeRobot v3 export.

The source is licensed under MIT. Documentation and the project citation are available at https://ceres.cam/documentation/ and https://ceres.cam/about/#ceres-citation.

Release assets include the source, standalone Node.js runtime, container, Python receiver, SPDX SBOMs and Sigstore verification bundles. Verify an artefact with `gh attestation verify <file> --repo hcltech-robotics/ceres`.

Load the container with `docker load --input ceres-container.tar.gz`. The image is `ceres-release:latest` and can run without registry access.

Cite CERES 1.1.0 with DOI https://doi.org/10.5281/zenodo.22729061.
