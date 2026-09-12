use serde::Serialize;

use crate::config::{LEROBOT_CODEBASE_VERSION, LEROBOT_ORACLE_COMMIT};
use crate::error::{ExportError, Result};

#[derive(Debug)]
pub struct Artifact {
    pub path: String,
    pub media_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug)]
pub struct ExportBundle {
    artifacts: Vec<Artifact>,
}

#[derive(Serialize)]
struct ManifestArtifact<'a> {
    path: &'a str,
    media_type: &'a str,
    byte_length: usize,
}

#[derive(Serialize)]
struct Manifest<'a> {
    format: &'static str,
    oracle_commit: &'static str,
    artifacts: Vec<ManifestArtifact<'a>>,
}

impl ExportBundle {
    pub fn new(mut artifacts: Vec<Artifact>) -> Result<Self> {
        artifacts.sort_by(|left, right| left.path.cmp(&right.path));
        let manifest = Manifest {
            format: LEROBOT_CODEBASE_VERSION,
            oracle_commit: LEROBOT_ORACLE_COMMIT,
            artifacts: artifacts
                .iter()
                .map(|artifact| ManifestArtifact {
                    path: &artifact.path,
                    media_type: &artifact.media_type,
                    byte_length: artifact.bytes.len(),
                })
                .collect(),
        };
        artifacts.push(Artifact {
            path: "ceres/export-manifest.json".to_owned(),
            media_type: "application/json".to_owned(),
            bytes: serde_json::to_vec_pretty(&manifest)?,
        });
        artifacts.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(Self { artifacts })
    }

    pub fn artifact_count(&self) -> usize {
        self.artifacts.len()
    }

    pub fn artifact_path(&self, index: usize) -> Result<&str> {
        self.artifacts
            .get(index)
            .map(|artifact| artifact.path.as_str())
            .ok_or_else(|| ExportError::InvalidConfig("artifact index is out of range".to_owned()))
    }

    pub fn artifact_media_type(&self, index: usize) -> Result<&str> {
        self.artifacts
            .get(index)
            .map(|artifact| artifact.media_type.as_str())
            .ok_or_else(|| ExportError::InvalidConfig("artifact index is out of range".to_owned()))
    }

    pub fn artifact_bytes(&self, index: usize) -> Result<&[u8]> {
        self.artifacts
            .get(index)
            .map(|artifact| artifact.bytes.as_slice())
            .ok_or_else(|| ExportError::InvalidConfig("artifact index is out of range".to_owned()))
    }

    pub fn find(&self, path: &str) -> Option<&[u8]> {
        self.artifacts
            .iter()
            .find(|artifact| artifact.path == path)
            .map(|artifact| artifact.bytes.as_slice())
    }
}
