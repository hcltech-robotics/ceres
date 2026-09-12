use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::ceres::CERES_STATE_DIM;
use crate::error::{ExportError, Result};

pub const LEROBOT_CODEBASE_VERSION: &str = "v3.0";
pub const LEROBOT_ORACLE_TAG: &str = "v0.4.0";
pub const LEROBOT_ORACLE_COMMIT: &str = "f25ac02e6c8fa9c467ab8462289e5f4aed3a2e85";
pub const DEFAULT_CHUNKS_SIZE: u64 = 1_000;

fn default_robot_type() -> String {
    "ceres_xr".to_owned()
}

fn default_row_group_size() -> usize {
    256
}

fn default_reduction_batch_rows() -> usize {
    256
}

fn default_max_frames() -> u64 {
    108_000
}

fn default_data_files_size_in_mb() -> u64 {
    100
}

fn default_video_files_size_in_mb() -> u64 {
    500
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct TaskConfig {
    pub index: u64,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ExportConfig {
    pub fps: u32,
    #[serde(default = "default_robot_type")]
    pub robot_type: String,
    #[serde(default)]
    pub episode_index: u64,
    #[serde(default)]
    pub global_frame_index: u64,
    pub task: TaskConfig,
    #[serde(default)]
    pub tasks: Vec<TaskConfig>,
    pub action_names: Vec<String>,
    #[serde(default = "default_row_group_size")]
    pub row_group_size: usize,
    #[serde(default = "default_reduction_batch_rows")]
    pub reduction_batch_rows: usize,
    #[serde(default = "default_max_frames")]
    pub max_frames: u64,
    #[serde(default = "default_data_files_size_in_mb")]
    pub data_files_size_in_mb: u64,
    #[serde(default = "default_video_files_size_in_mb")]
    pub video_files_size_in_mb: u64,
}

impl ExportConfig {
    pub fn from_json(value: &str) -> Result<Self> {
        let mut config: Self = serde_json::from_str(value)?;
        config.normalise_and_validate()?;
        Ok(config)
    }

    pub fn normalise_and_validate(&mut self) -> Result<()> {
        if self.fps == 0 || self.fps > 1_000 {
            return Err(ExportError::InvalidConfig(
                "fps must be between 1 and 1000".to_owned(),
            ));
        }
        if self.robot_type.trim().is_empty() {
            return Err(ExportError::InvalidConfig(
                "robot_type must not be empty".to_owned(),
            ));
        }
        if self.task.text.trim().is_empty() {
            return Err(ExportError::InvalidConfig(
                "task text must not be empty".to_owned(),
            ));
        }
        if self.action_names.is_empty() || self.action_names.len() > 4_096 {
            return Err(ExportError::InvalidConfig(
                "action_names must contain between 1 and 4096 entries".to_owned(),
            ));
        }
        let mut action_names = BTreeSet::new();
        for name in &self.action_names {
            if name.trim().is_empty() || !action_names.insert(name) {
                return Err(ExportError::InvalidConfig(
                    "action_names must be non-empty and unique".to_owned(),
                ));
            }
        }
        if !(16..=16_384).contains(&self.row_group_size) {
            return Err(ExportError::InvalidConfig(
                "row_group_size must be between 16 and 16384".to_owned(),
            ));
        }
        if !(16..=16_384).contains(&self.reduction_batch_rows) {
            return Err(ExportError::InvalidConfig(
                "reduction_batch_rows must be between 16 and 16384".to_owned(),
            ));
        }
        if self.max_frames == 0 {
            return Err(ExportError::InvalidConfig(
                "max_frames must be greater than zero".to_owned(),
            ));
        }
        if self.data_files_size_in_mb == 0 || self.video_files_size_in_mb == 0 {
            return Err(ExportError::InvalidConfig(
                "file size limits must be greater than zero".to_owned(),
            ));
        }

        if self.tasks.is_empty() {
            self.tasks.push(self.task.clone());
        }
        self.tasks.sort_by_key(|task| task.index);
        let mut task_indices = BTreeSet::new();
        let mut task_texts = BTreeSet::new();
        for task in &self.tasks {
            if task.text.trim().is_empty()
                || !task_indices.insert(task.index)
                || !task_texts.insert(task.text.as_str())
            {
                return Err(ExportError::InvalidConfig(
                    "tasks must have unique indices, unique non-empty text and no duplicates"
                        .to_owned(),
                ));
            }
        }
        if self
            .tasks
            .iter()
            .enumerate()
            .any(|(expected, task)| task.index != expected as u64)
        {
            return Err(ExportError::InvalidConfig(
                "task indices must be contiguous and start at zero".to_owned(),
            ));
        }
        if !self.tasks.iter().any(|task| task == &self.task) {
            return Err(ExportError::InvalidConfig(
                "the selected task must also be present in tasks".to_owned(),
            ));
        }
        Ok(())
    }

    pub fn action_dim(&self) -> usize {
        self.action_names.len()
    }

    pub fn reduction_dim(&self) -> usize {
        CERES_STATE_DIM + self.action_dim()
    }

    pub fn chunk_index(&self) -> u64 {
        self.episode_index / DEFAULT_CHUNKS_SIZE
    }

    pub fn file_index(&self) -> u64 {
        self.episode_index % DEFAULT_CHUNKS_SIZE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> ExportConfig {
        ExportConfig {
            fps: 30,
            robot_type: "ceres_xr".to_owned(),
            episode_index: 1_234,
            global_frame_index: 20,
            task: TaskConfig {
                index: 0,
                text: "pick".to_owned(),
            },
            tasks: Vec::new(),
            action_names: vec!["left.pinch".to_owned()],
            row_group_size: 256,
            reduction_batch_rows: 256,
            max_frames: 1_000,
            data_files_size_in_mb: 100,
            video_files_size_in_mb: 500,
        }
    }

    #[test]
    fn derives_stable_chunk_and_file_indices() {
        let mut config = config();
        config.normalise_and_validate().unwrap();
        assert_eq!(config.chunk_index(), 1);
        assert_eq!(config.file_index(), 234);
        assert_eq!(config.tasks, vec![config.task.clone()]);
    }
}
