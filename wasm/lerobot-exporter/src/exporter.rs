use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::bundle::{Artifact, ExportBundle};
use crate::ceres::{CERES_ACTION_NAMES, CERES_STATE_DIM, build_state, parse_sensor_frame_json};
use crate::config::ExportConfig;
use crate::error::{ExportError, Result};
use crate::metadata::{
    FeatureStatsDocument, StatsDocument, VideoAttachment, VideoMetadata, episode_parquet,
    info_json, stats_json, tasks_parquet, validate_video_key,
};
use crate::parquet_io::{DataShardWriter, RowIndices};
use crate::stats::{FeatureStats, ScalarStats, reduce_row_major};

#[derive(Debug, Default, Clone, Serialize)]
pub struct ExportMetrics {
    pub frames: u64,
    pub source_frame_gaps: u64,
    pub row_groups: u64,
    pub cpu_reduction_batches: u64,
    pub gpu_reduction_batches: u64,
    pub reduction_queue_stalls: u64,
    pub scratch_allocations: u64,
    pub scratch_reuses: u64,
    pub input_bytes: u64,
    pub parquet_bytes: u64,
    pub video_bytes: u64,
}

struct DatasetStats {
    state: FeatureStats,
    action: FeatureStats,
    timestamp: FeatureStats,
    frame_index: FeatureStats,
    episode_index: FeatureStats,
    index: FeatureStats,
    task_index: FeatureStats,
    source_frame_index: FeatureStats,
    source_gap: FeatureStats,
    source_timestamp: FeatureStats,
}

impl DatasetStats {
    fn new(action_dim: usize) -> Self {
        Self {
            state: FeatureStats::new(CERES_STATE_DIM),
            action: FeatureStats::new(action_dim),
            timestamp: FeatureStats::new(1),
            frame_index: FeatureStats::new(1),
            episode_index: FeatureStats::new(1),
            index: FeatureStats::new(1),
            task_index: FeatureStats::new(1),
            source_frame_index: FeatureStats::new(1),
            source_gap: FeatureStats::new(1),
            source_timestamp: FeatureStats::new(1),
        }
    }

    fn document(&self) -> StatsDocument {
        [
            ("action", &self.action),
            ("ceres.source_frame_index", &self.source_frame_index),
            ("ceres.source_gap", &self.source_gap),
            ("ceres.source_timestamp", &self.source_timestamp),
            ("episode_index", &self.episode_index),
            ("frame_index", &self.frame_index),
            ("index", &self.index),
            ("observation.state", &self.state),
            ("task_index", &self.task_index),
            ("timestamp", &self.timestamp),
        ]
        .into_iter()
        .map(|(name, stats)| (name.to_owned(), FeatureStatsDocument::from_stats(stats)))
        .collect()
    }
}

pub struct EpisodeExporter {
    config: ExportConfig,
    data_writer: DataShardWriter,
    stats: DatasetStats,
    reduction_values: Vec<f32>,
    reduction_rows: usize,
    state_scratch: Vec<f32>,
    videos: BTreeMap<String, VideoAttachment>,
    used_task_indices: BTreeSet<u64>,
    frame_count: u64,
    last_source_frame: Option<u64>,
    last_source_timestamp: Option<f64>,
    metrics: ExportMetrics,
}

impl EpisodeExporter {
    pub fn new(mut config: ExportConfig) -> Result<Self> {
        config.normalise_and_validate()?;
        let action_dim = config.action_dim();
        let reduction_capacity = config
            .reduction_batch_rows
            .saturating_mul(config.reduction_dim());
        Ok(Self {
            data_writer: DataShardWriter::new(CERES_STATE_DIM, action_dim, config.row_group_size)?,
            stats: DatasetStats::new(action_dim),
            reduction_values: Vec::with_capacity(reduction_capacity),
            reduction_rows: 0,
            state_scratch: Vec::with_capacity(CERES_STATE_DIM),
            videos: BTreeMap::new(),
            used_task_indices: BTreeSet::new(),
            frame_count: 0,
            last_source_frame: None,
            last_source_timestamp: None,
            metrics: ExportMetrics {
                scratch_allocations: 2,
                ..ExportMetrics::default()
            },
            config,
        })
    }

    pub fn from_json(config_json: &str) -> Result<Self> {
        Self::new(ExportConfig::from_json(config_json)?)
    }

    pub fn push_ceres_frame(
        &mut self,
        source_frame_index: u64,
        telemetry: &[f64],
        action: &[f32],
    ) -> Result<()> {
        let task_index = self.config.task.index;
        self.push_ceres_frame_for_task(source_frame_index, telemetry, action, task_index)
    }

    pub fn push_ceres_frame_for_task(
        &mut self,
        source_frame_index: u64,
        telemetry: &[f64],
        action: &[f32],
        task_index: u64,
    ) -> Result<()> {
        self.push_ceres_frame_for_task_with_gap(
            source_frame_index,
            telemetry,
            action,
            task_index,
            None,
        )
    }

    fn push_ceres_frame_for_task_with_gap(
        &mut self,
        source_frame_index: u64,
        telemetry: &[f64],
        action: &[f32],
        task_index: u64,
        source_gap: Option<bool>,
    ) -> Result<()> {
        if self.reduction_ready() {
            self.metrics.reduction_queue_stalls += 1;
            return Err(ExportError::ReductionPending);
        }
        if self.frame_count >= self.config.max_frames {
            return Err(ExportError::EpisodeFull(self.config.max_frames));
        }
        if action.len() != self.config.action_dim() {
            return Err(ExportError::InvalidFrame(format!(
                "expected {} action values, received {}",
                self.config.action_dim(),
                action.len()
            )));
        }
        if action.iter().any(|value| !value.is_finite()) {
            return Err(ExportError::InvalidFrame(
                "action values must be finite".to_owned(),
            ));
        }
        if !self
            .config
            .tasks
            .iter()
            .any(|task| task.index == task_index)
        {
            return Err(ExportError::InvalidFrame(format!(
                "task index {task_index} is not present in the task catalogue"
            )));
        }
        if let Some(previous) = self.last_source_frame {
            if source_frame_index <= previous {
                return Err(ExportError::InvalidFrame(
                    "source frame indices must be strictly increasing".to_owned(),
                ));
            }
            self.metrics.source_frame_gaps += match source_gap {
                Some(true) => 1,
                Some(false) => 0,
                None => source_frame_index - previous - 1,
            };
        } else if source_gap == Some(true) {
            self.metrics.source_frame_gaps += 1;
        }

        let source_timestamp = build_state(telemetry, &mut self.state_scratch)?;
        if let Some(previous) = self.last_source_timestamp
            && source_timestamp <= previous
        {
            return Err(ExportError::InvalidFrame(
                "source timestamps must be strictly increasing".to_owned(),
            ));
        }
        let frame_index = self.frame_count;
        let timestamp = frame_index as f32 / self.config.fps as f32;
        let global_index = self.config.global_frame_index + frame_index;
        self.data_writer.push(
            &self.state_scratch,
            action,
            timestamp,
            RowIndices {
                frame: frame_index as i64,
                episode: self.config.episode_index as i64,
                global: global_index as i64,
                task: task_index as i64,
                source_frame: source_frame_index as i64,
            },
            source_timestamp,
            source_gap.unwrap_or(false),
        )?;

        self.reduction_values.extend_from_slice(&self.state_scratch);
        self.reduction_values.extend_from_slice(action);
        self.reduction_rows += 1;

        self.stats.timestamp.update_scalar(f64::from(timestamp));
        self.stats.frame_index.update_scalar(frame_index as f64);
        self.stats
            .episode_index
            .update_scalar(self.config.episode_index as f64);
        self.stats.index.update_scalar(global_index as f64);
        self.stats.task_index.update_scalar(task_index as f64);
        self.stats
            .source_frame_index
            .update_scalar(source_frame_index as f64);
        self.stats
            .source_gap
            .update_scalar(if source_gap == Some(true) { 1.0 } else { 0.0 });
        self.stats.source_timestamp.update_scalar(source_timestamp);
        self.used_task_indices.insert(task_index);

        self.frame_count += 1;
        self.last_source_frame = Some(source_frame_index);
        self.last_source_timestamp = Some(source_timestamp);
        self.metrics.frames = self.frame_count;
        self.metrics.input_bytes +=
            (std::mem::size_of_val(telemetry) + std::mem::size_of_val(action)) as u64;
        self.metrics.scratch_reuses += 2;
        Ok(())
    }

    pub fn push_ceres_sensor_frame_json(&mut self, frame_json: &str) -> Result<()> {
        let task_index = self.config.task.index;
        self.push_ceres_sensor_frame_json_for_task(frame_json, task_index)
    }

    pub fn push_ceres_sensor_frame_json_for_task(
        &mut self,
        frame_json: &str,
        task_index: u64,
    ) -> Result<()> {
        if self.config.action_names
            != CERES_ACTION_NAMES
                .iter()
                .map(|name| (*name).to_owned())
                .collect::<Vec<_>>()
        {
            return Err(ExportError::InvalidConfig(format!(
                "sensor frame JSON requires action_names {:?}",
                CERES_ACTION_NAMES
            )));
        }
        let frame = parse_sensor_frame_json(frame_json)?;
        self.push_ceres_frame_for_task_with_gap(
            frame.source_frame_index,
            &frame.telemetry,
            &frame.action,
            task_index,
            frame.source_gap,
        )
    }

    pub fn reduction_ready(&self) -> bool {
        self.reduction_rows >= self.config.reduction_batch_rows
    }

    pub fn pending_reduction_rows(&self) -> usize {
        self.reduction_rows
    }

    pub fn pending_reduction_dimensions(&self) -> usize {
        self.config.reduction_dim()
    }

    pub fn pending_reduction_values(&self) -> &[f32] {
        &self.reduction_values
    }

    pub fn reduce_pending_cpu(&mut self) -> Result<()> {
        if self.reduction_rows == 0 {
            return Ok(());
        }
        let partial = reduce_row_major(
            &self.reduction_values,
            self.reduction_rows,
            self.config.reduction_dim(),
        )?;
        self.merge_reduction(&partial)?;
        self.metrics.cpu_reduction_batches += 1;
        self.clear_reduction();
        Ok(())
    }

    pub fn accept_gpu_reduction(
        &mut self,
        counts: &[u32],
        means: &[f32],
        m2: &[f32],
        minimums: &[f32],
        maximums: &[f32],
    ) -> Result<()> {
        let dimensions = self.config.reduction_dim();
        if self.reduction_rows == 0 {
            return Err(ExportError::InvalidFrame(
                "there is no pending reduction batch".to_owned(),
            ));
        }
        if [
            counts.len(),
            means.len(),
            m2.len(),
            minimums.len(),
            maximums.len(),
        ]
        .iter()
        .any(|length| *length != dimensions)
        {
            return Err(ExportError::InvalidFrame(
                "GPU reduction result has the wrong dimension".to_owned(),
            ));
        }
        let mut partial = Vec::with_capacity(dimensions);
        for dimension in 0..dimensions {
            if counts[dimension] as usize != self.reduction_rows {
                return Err(ExportError::InvalidFrame(
                    "GPU reduction count does not match the pending row count".to_owned(),
                ));
            }
            let values = [
                means[dimension],
                m2[dimension],
                minimums[dimension],
                maximums[dimension],
            ];
            if values.iter().any(|value| !value.is_finite()) || m2[dimension] < -1e-3 {
                return Err(ExportError::InvalidFrame(
                    "GPU reduction output must be finite with non-negative M2".to_owned(),
                ));
            }
            partial.push(ScalarStats {
                count: counts[dimension] as u64,
                mean: f64::from(means[dimension]),
                m2: f64::from(m2[dimension].max(0.0)),
                min: f64::from(minimums[dimension]),
                max: f64::from(maximums[dimension]),
            });
        }
        self.merge_reduction(&partial)?;
        self.metrics.gpu_reduction_batches += 1;
        self.clear_reduction();
        Ok(())
    }

    fn merge_reduction(&mut self, partial: &[ScalarStats]) -> Result<()> {
        let (state, action) = partial.split_at(CERES_STATE_DIM);
        self.stats.state.merge_partial(state)?;
        self.stats.action.merge_partial(action)?;
        Ok(())
    }

    fn clear_reduction(&mut self) {
        self.reduction_values.clear();
        self.reduction_rows = 0;
    }

    pub fn attach_video(
        &mut self,
        key: &str,
        metadata: VideoMetadata,
        bytes: Vec<u8>,
    ) -> Result<()> {
        validate_video_key(key)?;
        metadata.validate()?;
        if bytes.is_empty() {
            return Err(ExportError::InvalidVideo(
                "video bytes must not be empty".to_owned(),
            ));
        }
        let max_bytes = self.config.video_files_size_in_mb.saturating_mul(1_048_576);
        if bytes.len() as u64 > max_bytes {
            return Err(ExportError::InvalidVideo(format!(
                "video is larger than the configured {} MiB file limit",
                self.config.video_files_size_in_mb
            )));
        }
        if (metadata.fps - self.config.fps as f64).abs() > 1e-6 {
            return Err(ExportError::InvalidVideo(
                "video fps must match the dataset fps".to_owned(),
            ));
        }
        if self.videos.contains_key(key) {
            return Err(ExportError::InvalidVideo(format!(
                "video key {key:?} is already attached"
            )));
        }
        self.metrics.video_bytes += bytes.len() as u64;
        self.videos.insert(
            key.to_owned(),
            VideoAttachment {
                key: key.to_owned(),
                metadata,
                bytes,
            },
        );
        Ok(())
    }

    pub fn metrics(&self) -> &ExportMetrics {
        &self.metrics
    }

    pub fn metrics_json(&self) -> Result<String> {
        Ok(serde_json::to_string(&self.metrics)?)
    }

    fn validate_final_state(&self) -> Result<()> {
        if self.frame_count == 0 {
            return Err(ExportError::InvalidFrame(
                "an episode must contain at least one frame".to_owned(),
            ));
        }
        for video in self.videos.values() {
            if video.metadata.frame_count != self.frame_count {
                return Err(ExportError::InvalidVideo(format!(
                    "video {} has {} frames but the episode has {} rows",
                    video.key, video.metadata.frame_count, self.frame_count
                )));
            }
            let expected_duration = self.frame_count as f64 / self.config.fps as f64;
            if (video.metadata.duration_s - expected_duration).abs() > 1.0 / self.config.fps as f64
            {
                return Err(ExportError::InvalidVideo(format!(
                    "video {} duration differs from the episode by more than one frame",
                    video.key
                )));
            }
        }
        Ok(())
    }

    pub fn finish(mut self) -> Result<ExportBundle> {
        self.validate_final_state()?;
        self.reduce_pending_cpu()?;
        let stats = self.stats.document();
        let info = info_json(&self.config, self.frame_count, &self.videos)?;
        let stats_bytes = stats_json(&stats)?;
        let tasks = tasks_parquet(&self.config)?;
        let episode_tasks = self
            .config
            .tasks
            .iter()
            .filter(|task| self.used_task_indices.contains(&task.index))
            .map(|task| task.text.clone())
            .collect::<Vec<_>>();
        let episodes = episode_parquet(
            &self.config,
            self.frame_count,
            &stats,
            &self.videos,
            &episode_tasks,
        )?;
        let (data, rows_written, row_groups) = self.data_writer.finish()?;
        debug_assert_eq!(rows_written, self.frame_count);
        self.metrics.row_groups = row_groups;
        self.metrics.parquet_bytes = (data.len() + tasks.len() + episodes.len()) as u64;

        let mut artifacts = vec![
            Artifact {
                path: format!(
                    "data/chunk-{:03}/file-{:03}.parquet",
                    self.config.chunk_index(),
                    self.config.file_index()
                ),
                media_type: "application/vnd.apache.parquet".to_owned(),
                bytes: data,
            },
            Artifact {
                path: format!(
                    "meta/episodes/chunk-{:03}/file-{:03}.parquet",
                    self.config.chunk_index(),
                    self.config.file_index()
                ),
                media_type: "application/vnd.apache.parquet".to_owned(),
                bytes: episodes,
            },
            Artifact {
                path: "meta/info.json".to_owned(),
                media_type: "application/json".to_owned(),
                bytes: info,
            },
            Artifact {
                path: "meta/stats.json".to_owned(),
                media_type: "application/json".to_owned(),
                bytes: stats_bytes,
            },
            Artifact {
                path: "meta/tasks.parquet".to_owned(),
                media_type: "application/vnd.apache.parquet".to_owned(),
                bytes: tasks,
            },
            Artifact {
                path: "ceres/metrics.json".to_owned(),
                media_type: "application/json".to_owned(),
                bytes: serde_json::to_vec_pretty(&self.metrics)?,
            },
        ];
        for (_, video) in self.videos {
            artifacts.push(Artifact {
                path: format!(
                    "videos/{}/chunk-{:03}/file-{:03}.mp4",
                    video.key,
                    self.config.chunk_index(),
                    self.config.file_index()
                ),
                media_type: "video/mp4".to_owned(),
                bytes: video.bytes,
            });
        }
        ExportBundle::new(artifacts)
    }
}
