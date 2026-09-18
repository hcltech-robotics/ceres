use crate::{
    ExportJob, ExportProfile, STATE_DIM, VALID_DIM,
    session::{Segment, SessionIndex},
};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::Path};

pub fn pinch_distances(
    state: &[f32; STATE_DIM],
    valid: &[bool; VALID_DIM],
) -> ([f32; 2], [bool; 2]) {
    let mut distances = [0.0; 2];
    let mut tracked = [false; 2];
    for side in 0..2 {
        let state_base = if side == 0 { 9 } else { 210 };
        let valid_base = if side == 0 { 1 } else { 26 };
        if valid[valid_base + 4] && valid[valid_base + 9] {
            let thumb = state_base + 4 * 8;
            let index = state_base + 9 * 8;
            distances[side] = (0..3)
                .map(|axis| {
                    (f64::from(state[thumb + axis]) - f64::from(state[index + axis])).powi(2)
                })
                .sum::<f64>()
                .sqrt() as f32;
            tracked[side] = true;
        }
    }
    (distances, tracked)
}

pub struct ShardDetails {
    pub number: usize,
    pub frames: i64,
    pub from: i64,
    pub input_bytes: u64,
    pub source_gaps: u64,
    pub video_gaps: u64,
    pub row_groups: u64,
    pub stats: BTreeMap<String, Value>,
}
fn write_json(path: &Path, value: &Value) -> Result<()> {
    fs::create_dir_all(path.parent().context("metadata path has no parent")?)?;
    fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}
fn link_or_copy(source: &Path, target: &Path) -> Result<()> {
    fs::create_dir_all(target.parent().context("shard path has no parent")?)?;
    if fs::hard_link(source, target).is_err() {
        fs::copy(source, target)
            .with_context(|| format!("copy shard file {}", source.display()))?;
    }
    Ok(())
}
fn known(value: Value) -> Value {
    json!({"availability":"known","value":value})
}
fn capture_metadata(job: &ExportJob, index: &SessionIndex, segment: &Segment) -> (Value, Value) {
    let epoch = &index.epochs[segment.epoch_index];
    let mut description = Value::Null;
    let mut calibration = Value::Null;
    for event in &index.capture_events {
        if event["epoch"].as_u64() != Some(u64::from(epoch.epoch))
            || event["session_time_us"]
                .as_i64()
                .is_none_or(|time| time > segment.start_us)
        {
            continue;
        }
        if event["kind"] == "metadata" {
            description = event["attributes"].clone();
        }
        if event["kind"] == "calibration" {
            calibration = event["attributes"].clone();
        }
    }
    let camera = &description["camera"];
    let side = camera["side"]
        .as_str()
        .filter(|s| ["left", "right", "unknown"].contains(s));
    let selection = side.map(|side| known(json!({"label":camera["label"].as_str().unwrap_or("Passthrough camera"),"side":side})))
        .unwrap_or_else(|| json!({"availability":"unknown"}));
    let frame_rate = camera["fps"]
        .as_f64()
        .filter(|v| v.is_finite() && *v > 0.0)
        .map(|fps| known(json!(fps)))
        .unwrap_or_else(|| json!({"availability":"unknown"}));
    // Bridge calibration profiles do not claim the browser's measured RMS,
    // sample count or calibration date. Preserve them in their original schema.
    let capture = json!({
        "schema":"ceres-capture-metadata-v1","version":1,
        "camera":{"selection":selection,"width":known(json!(job.video.width)),"height":known(json!(job.video.height)),"frameRate":frame_rate,"calibration":{"availability":"unknown"}},
        "device":{"headsetModel":{"availability":"unknown"},"questBrowser":{"availability":"unknown"},"sensorSource":{"availability":"unknown"},"handTracking":{"availability":"unknown"}},
        "recorder":{"rateHz":known(json!(job.fps))}
    });
    (
        capture,
        json!({"description":description,"calibration":calibration}),
    )
}

pub fn write(
    job: &ExportJob,
    index: &SessionIndex,
    episodes: &[Segment],
    root: &Path,
    details: &[ShardDetails],
) -> Result<()> {
    let provenance_path = root.join("meta/ceres-export.json");
    let mut provenance: Value = serde_json::from_reader(fs::File::open(&provenance_path)?)?;
    provenance["profile"] = json!(job.profile.name());
    if job.profile == ExportProfile::Ceres {
        provenance["feature_semantics"] = json!({
            "action":"left/right Euclidean thumb-tip to index-finger-tip distance in metres, matching CERES browser ordering",
            "action.valid":"true only when both corresponding fingertips were observed in the selected hand packet; invalid distance is zero",
            "ceres.source_timestamp":"seconds on the receiver session resampling grid, not a sender wall clock or camera exposure time",
            "ceres.source_frame_index":"floor(episode_start_us * fps / 1000000) plus frame_index on the receiver session grid",
            "ceres.source_gap":"no head, left-hand or right-hand packet selected for this slot",
            "ceres.sender_timestamp":"original CBR1 observed_us in seconds, ordered head/left_hand/right_hand; -1 when absent",
            "ceres.sender_target_timestamp":"original CBR1 target_us in seconds with the same ordering; -1 when absent",
            "ceres.sender_sequence":"original CBR1 XR-frame sequence with the same ordering; -1 when absent",
            "observation.valid":"original head and per-joint tracking validity, ordered head/left 25/right 25",
            "observation.video_valid":"false for a black slot without a selected source video frame",
            "ceres.video_timestamp":"selected source frame receiver-anchored RTP presentation time in session seconds; -1 when absent"
        });
        provenance["layout"] = json!({"lerobot_root":".","ceres_episode_shards":"shards/episode-NNNNNN","shared_files":"identical Parquet and MP4 content, hard-linked locally when supported"});
        let info: Value = serde_json::from_reader(fs::File::open(root.join("meta/info.json"))?)?;
        for (segment, detail) in episodes.iter().zip(details) {
            job.check_cancelled()?;
            let number = detail.number;
            let shard = root.join(format!("shards/episode-{number:06}"));
            let suffix = format!("chunk-{:03}/file-{:03}", number / 1000, number % 1000);
            let data = format!("data/{suffix}.parquet");
            let video = format!("videos/{}/{suffix}.mp4", job.video.key);
            for relative in [
                &data,
                &video,
                &format!("meta/episodes/{suffix}.parquet"),
                "meta/tasks.parquet",
            ] {
                link_or_copy(&root.join(relative), &shard.join(relative))?;
            }
            let mut shard_info = info.clone();
            // Browser shards retain the collection's episode/global indices.
            shard_info["total_episodes"] = json!(number + 1);
            shard_info["total_frames"] = json!(detail.from + detail.frames);
            shard_info["splits"] = json!({"train":format!("0:{}",number+1)});
            shard_info["features"][&job.video.key]["info"]["video.duration_s"] =
                json!(detail.frames as f64 / f64::from(job.fps));
            write_json(&shard.join("meta/info.json"), &shard_info)?;
            write_json(&shard.join("meta/stats.json"), &json!(detail.stats))?;
            write_json(
                &shard.join("ceres/metrics.json"),
                &json!({
                    "frames":detail.frames,"source_frame_gaps":detail.source_gaps,"video_frame_gaps":detail.video_gaps,
                    "row_groups":detail.row_groups,"cpu_reduction_batches":detail.frames,"gpu_reduction_batches":0,
                    "reduction_queue_stalls":0,"scratch_allocations":2,"scratch_reuses":detail.frames.saturating_sub(1),
                    "input_bytes":detail.input_bytes,"parquet_bytes":fs::metadata(root.join(&data))?.len(),"video_bytes":fs::metadata(root.join(&video))?.len(),
                    "profile":job.profile.name(),"metric_semantics":{"cpu_reduction_batches":"one streaming moment update per output row","scratch_allocations":"retained RGB and row-group buffers","scratch_reuses":"RGB buffer reuse after the first output frame","input_bytes":"selected CBR1 packets and compressed H264 access units"}
                }),
            )?;
            let (capture, original) = capture_metadata(job, index, segment);
            let epoch = &index.epochs[segment.epoch_index];
            write_json(
                &shard.join("ceres/episode-metadata.json"),
                &json!({
                    "schema":"ceres-episode-export-metadata","version":3,"episodeId":format!("bridge-{number:06}"),"episodeIndex":number,
                    "captureMetadata":capture,"segments":null,"profile":job.profile.name(),
                    "bridge":{"start_us":segment.start_us,"end_us":segment.end_us,"connection_epoch":epoch.epoch,"space_epoch":epoch.space_epoch,"task":segment.task,"capture":original,"timestamp_domain":"receiver-session-resampling-grid","source_events_repository_path":"meta/ceres-source-events.jsonl"}
                }),
            )?;
        }
    }
    write_json(&provenance_path, &provenance)?;
    let shard_note = if job.profile == ExportProfile::Ceres {
        " The `shards/episode-NNNNNN` directories provide episode views for the CERES dataset viewer."
    } else {
        " This profile contains observations without an action feature."
    };
    fs::write(
        root.join("README.md"),
        format!(
            "---\nconfigs:\n  - config_name: default\n    data_files:\n      - split: train\n        path: data/**/*.parquet\n---\n\n# Ceres Bridge dataset\n\nThis dataset uses LeRobot v3 with the `{}` profile. Load the repository root with the official LeRobot reader.{shard_note}\n\nThe dataset card selects observation rows and excludes metadata tables and duplicate shard paths. Source camera dimensions are retained. Missing images are black with `observation.video_valid=false`, and missing geometry is zero with per-joint `observation.valid`.\n\nFrame `timestamp` is episode-relative in seconds. Detailed feature timing, source epochs, selected ranges and validity semantics are in `meta/ceres-export.json`. Original event headers and calibration changes are in `meta/ceres-source-events.jsonl`.\n",
            job.profile.name()
        ),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pinch_uses_observed_tip_coordinates_in_browser_order() {
        let mut state = [0.0; STATE_DIM];
        let mut valid = [false; VALID_DIM];
        for (base, validity, dx, dy) in [(9, 1, 0.03, 0.04), (210, 26, 0.0, 0.02)] {
            state[base + 4 * 8] = 1.0;
            state[base + 9 * 8] = 1.0 + dx;
            state[base + 9 * 8 + 1] = dy;
            valid[validity + 4] = true;
            valid[validity + 9] = true;
        }
        let (distance, tracked) = pinch_distances(&state, &valid);
        assert!((distance[0] - 0.05).abs() < 1e-6 && (distance[1] - 0.02).abs() < 1e-6);
        assert_eq!(tracked, [true, true]);
        valid[1 + 4] = false;
        let (distance, tracked) = pinch_distances(&state, &valid);
        assert_eq!(distance[0], 0.0);
        assert_eq!(tracked, [false, true]);
    }
}
