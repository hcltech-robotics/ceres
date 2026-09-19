mod compatibility;
mod dataset;
pub mod replay;
mod session;
mod video;

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const STATE_DIM: usize = 410;
pub const VALID_DIM: usize = 51;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
pub enum ExportProfile {
    #[default]
    #[serde(rename = "ceres-bridge-lerobot3-v1")]
    Ceres,
    #[serde(rename = "ceres-bridge-observation-v1")]
    Observation,
}
impl ExportProfile {
    pub fn name(self) -> &'static str {
        match self {
            Self::Ceres => "ceres-bridge-lerobot3-v1",
            Self::Observation => "ceres-bridge-observation-v1",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EpisodeRange {
    pub start_us: i64,
    pub end_us: i64,
    pub task: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VideoConfig {
    #[serde(default = "default_stream")]
    pub stream: String,
    #[serde(default = "default_key")]
    pub key: String,
    pub width: u32,
    pub height: u32,
    /// Use encoded image dimensions for the selected ranges. Width and height
    /// remain the black-frame fallback when the ranges contain no camera images.
    #[serde(default)]
    pub source_dimensions: bool,
}
fn default_stream() -> String {
    String::new()
}
fn default_key() -> String {
    "observation.images.passthrough".into()
}
fn default_fps() -> u32 {
    30
}
fn default_ffmpeg() -> PathBuf {
    "ffmpeg".into()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExportJob {
    pub schema: String,
    pub version: u32,
    pub session: PathBuf,
    pub output: PathBuf,
    #[serde(default)]
    pub profile: ExportProfile,
    #[serde(default = "default_fps")]
    pub fps: u32,
    #[serde(default = "default_ffmpeg")]
    pub ffmpeg: PathBuf,
    pub episodes: Vec<EpisodeRange>,
    pub video: VideoConfig,
    #[serde(default)]
    pub cancel_file: Option<PathBuf>,
}

impl ExportJob {
    fn validate(&self) -> Result<()> {
        ensure!(
            self.schema == "ceres-native-export" && self.version == 1,
            "unsupported export job schema/version"
        );
        ensure!(
            (1..=240).contains(&self.fps),
            "fps must be between 1 and 240"
        );
        ensure!(
            !self.episodes.is_empty(),
            "at least one episode range is required"
        );
        for episode in &self.episodes {
            ensure!(
                episode.start_us >= 0 && episode.end_us > episode.start_us,
                "episode ranges must be non-negative and non-empty"
            );
            ensure!(
                !episode.task.trim().is_empty(),
                "each episode requires a task description"
            );
        }
        ensure!(
            self.video.width > 0
                && self.video.width <= 16384
                && self.video.height > 0
                && self.video.height <= 16384,
            "invalid video dimensions"
        );
        ensure!(
            self.video.width.is_multiple_of(2) && self.video.height.is_multiple_of(2),
            "H264 video dimensions must be even"
        );
        ensure!(
            self.video.key.starts_with("observation.images.")
                && self.video.key.len() > 19
                && self
                    .video
                    .key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)),
            "invalid video feature key"
        );
        ensure!(
            !self.output.exists(),
            "output already exists: {}",
            self.output.display()
        );
        Ok(())
    }
    pub(crate) fn check_cancelled(&self) -> Result<()> {
        ensure!(
            !self.cancel_file.as_ref().is_some_and(|path| path.exists()),
            "export cancelled"
        );
        Ok(())
    }
}

pub(crate) fn progress(stage: &str, completed: u64, total: u64) {
    println!(
        "{}",
        serde_json::json!({"schema":"ceres-export-progress","version":1,"stage":stage,"completed":completed,"total":total})
    );
}

pub fn run(job_path: &Path) -> Result<()> {
    let mut job: ExportJob =
        serde_json::from_reader(fs::File::open(job_path).context("open export job")?)
            .context("read export job")?;
    let base = job_path.parent().unwrap_or(Path::new("."));
    if job.session.is_relative() {
        job.session = base.join(&job.session);
    }
    if job.output.is_relative() {
        job.output = base.join(&job.output);
    }
    if let Some(path) = &mut job.cancel_file
        && path.is_relative()
    {
        *path = base.join(&*path);
    }
    job.validate()?;
    job.check_cancelled()?;
    let parent = job
        .output
        .parent()
        .context("output requires a parent directory")?;
    fs::create_dir_all(parent)?;
    let staging = tempfile::Builder::new()
        .prefix(".ceres-export-")
        .tempdir_in(parent)?;
    let spool = staging.path().join("work");
    fs::create_dir(&spool)?;
    progress("indexing", 0, 1);
    let index = session::index(&job, &spool)?;
    let episodes = index.split_ranges(&job.episodes)?;
    ensure!(
        !episodes.is_empty(),
        "selected ranges do not contain a recorded epoch"
    );
    index.resolve_dimensions(&mut job, &episodes, &spool)?;
    job.validate()?;
    let dataset = staging.path().join("dataset");
    fs::create_dir(&dataset)?;
    dataset::export(&job, &index, &episodes, &dataset, &spool)?;
    job.check_cancelled()?;
    fs::rename(
        spool.join(session::SOURCE_EVENTS_FILE),
        dataset.join("meta").join(session::SOURCE_EVENTS_FILE),
    )
    .context("complete source event provenance")?;
    fs::rename(&dataset, &job.output).context("publish completed dataset")?;
    progress("complete", episodes.len() as u64, episodes.len() as u64);
    Ok(())
}

/// Select the nearest unused sample in the half-slot window, preferring the earlier sample.
pub(crate) fn nearest(
    times: &[i64],
    cursor: &mut usize,
    slot_numerator: i128,
    fps: u32,
) -> Option<usize> {
    let distance = |time: i64| (i128::from(time) * i128::from(fps) - slot_numerator).abs();
    let before = |time: i64| i128::from(time) * i128::from(fps) <= slot_numerator;
    let within = |time: i64| distance(time) * 2 <= 1_000_000;
    while *cursor < times.len() && before(times[*cursor]) && !within(times[*cursor]) {
        *cursor += 1;
    }
    let mut best = None;
    let mut pos = *cursor;
    while pos < times.len() && (before(times[pos]) || within(times[pos])) {
        if within(times[pos])
            && best.is_none_or(|old: usize| distance(times[pos]) < distance(times[old]))
        {
            best = Some(pos);
        }
        pos += 1;
    }
    if let Some(best) = best {
        *cursor = best + 1;
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nearest_is_unused_bounded_and_prefers_earlier() {
        let times = [90_000, 110_000, 140_000];
        let mut cursor = 0;
        assert_eq!(nearest(&times, &mut cursor, 100_000 * 30, 30), Some(0));
        assert_eq!(nearest(&times, &mut cursor, 4_000_000, 30), Some(2));
        assert_eq!(nearest(&times, &mut cursor, 5_000_000, 30), None);
    }
    #[test]
    fn half_slot_boundary_is_inclusive_without_rounding() {
        let mut cursor = 0;
        assert_eq!(nearest(&[16_666, 16_667], &mut cursor, 0, 30), Some(0));
        let mut cursor = 0;
        assert_eq!(nearest(&[16_667], &mut cursor, 0, 30), None);
        let mut cursor = 0;
        assert_eq!(nearest(&[50_000], &mut cursor, 1_000_000, 30), Some(0));
    }
}
