//! Convert a CERES LeRobot v3 dataset into the viewer's indexed session format.
use anyhow::{Context, Result, bail, ensure};
use arrow_array::{
    Array, BooleanArray, FixedSizeListArray, Float32Array, Float64Array, Int64Array, RecordBatch,
};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
};

#[path = "replay_tasks.rs"]
mod tasks;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportJob {
    schema: String,
    version: u32,
    dataset: PathBuf,
    output: PathBuf,
    ffmpeg: PathBuf,
    #[serde(default)]
    cancel_file: Option<PathBuf>,
}
impl ImportJob {
    fn check_cancelled(&self) -> Result<()> {
        ensure!(
            !self.cancel_file.as_ref().is_some_and(|p| p.exists()),
            "Replay import cancelled"
        );
        Ok(())
    }
}

fn read_json(path: &Path) -> Result<Value> {
    ensure!(
        fs::metadata(path)?.len() <= 4 * 1024 * 1024,
        "Dataset metadata exceeds its size limit"
    );
    serde_json::from_reader(File::open(path)?).with_context(|| format!("Read {}", path.display()))
}

fn parquet_files(root: &Path) -> Result<Vec<PathBuf>> {
    fn visit(root: &Path, paths: &mut Vec<PathBuf>, depth: usize) -> Result<()> {
        ensure!(
            depth <= 8 && paths.len() < 100_000,
            "Dataset layout exceeds its size limit"
        );
        for entry in fs::read_dir(root)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            ensure!(!kind.is_symlink(), "Dataset contains a symbolic link");
            if kind.is_dir() {
                visit(&entry.path(), paths, depth + 1)?;
            } else if kind.is_file() && entry.path().extension().is_some_and(|v| v == "parquet") {
                paths.push(entry.path());
            }
        }
        Ok(())
    }
    let mut paths = Vec::new();
    visit(root, &mut paths, 0)?;
    paths.sort();
    ensure!(
        !paths.is_empty(),
        "Dataset contains no observation Parquet files"
    );
    Ok(paths)
}

fn column<'a>(batch: &'a RecordBatch, name: &str) -> Result<&'a dyn Array> {
    Ok(batch
        .column_by_name(name)
        .with_context(|| format!("Dataset is missing {name}"))?
        .as_ref())
}
fn number(array: &dyn Array, row: usize) -> Result<f64> {
    ensure!(
        row < array.len() && !array.is_null(row),
        "Dataset contains a missing numeric value"
    );
    let value = if let Some(a) = array.as_any().downcast_ref::<Float64Array>() {
        a.value(row)
    } else if let Some(a) = array.as_any().downcast_ref::<Float32Array>() {
        f64::from(a.value(row))
    } else if let Some(a) = array.as_any().downcast_ref::<Int64Array>() {
        a.value(row) as f64
    } else {
        bail!("Unsupported numeric dataset column")
    };
    ensure!(
        value.is_finite(),
        "Dataset contains a non-finite numeric value"
    );
    Ok(value)
}
fn optional_number(batch: &RecordBatch, name: &str, row: usize) -> Result<Option<f64>> {
    batch
        .column_by_name(name)
        .map(|a| number(a.as_ref(), row))
        .transpose()
}
fn optional_bool(batch: &RecordBatch, name: &str, row: usize) -> Result<Option<bool>> {
    batch
        .column_by_name(name)
        .map(|a| {
            let a = a
                .as_any()
                .downcast_ref::<BooleanArray>()
                .context("Expected a Boolean dataset column")?;
            ensure!(!a.is_null(row), "Dataset contains a missing Boolean value");
            Ok(a.value(row))
        })
        .transpose()
}
fn list(
    batch: &RecordBatch,
    name: &str,
    row: usize,
    size: usize,
) -> Result<Option<arrow_array::ArrayRef>> {
    batch
        .column_by_name(name)
        .map(|a| {
            let a = a
                .as_any()
                .downcast_ref::<FixedSizeListArray>()
                .with_context(|| format!("Expected a fixed-size {name} vector"))?;
            ensure!(
                !a.is_null(row) && a.value_length() as usize == size,
                "Invalid {name} vector length"
            );
            Ok(a.value(row))
        })
        .transpose()
}
fn micros(seconds: f64) -> Result<i64> {
    let value = seconds * 1_000_000.0;
    ensure!(
        value.is_finite() && (0.0..9_007_199_254_740_991.0).contains(&value),
        "Dataset timestamp is out of range"
    );
    Ok(value.round() as i64)
}
fn identifier(value: f64) -> Result<u32> {
    ensure!(
        (0.0..=f64::from(u32::MAX)).contains(&value) && value.fract() == 0.0,
        "Dataset identity is out of range"
    );
    Ok(value as u32)
}

#[derive(Clone, Copy)]
struct PoseIdentity {
    epoch: u32,
    space: u32,
    sequence: u32,
    observed: i64,
    target: i64,
}
fn pose_packet(
    state: &[f32],
    valid: Option<&BooleanArray>,
    gap: bool,
    part: usize,
    id: &PoseIdentity,
) -> Result<Vec<u8>> {
    let (tracked, begin, valid_begin, joints, width) = match part {
        0 => (0, 1, 0, 1, 7),
        1 => (8, 9, 1, 25, 8),
        _ => (209, 210, 26, 25, 8),
    };
    let mut payload = vec![0; if part == 0 { 68 } else { 844 }];
    payload[..4].copy_from_slice(b"CBR1");
    payload[4] = 1;
    payload[5] = part as u8 + 1;
    payload[8..12].copy_from_slice(&id.epoch.to_le_bytes());
    payload[12..16].copy_from_slice(&id.space.to_le_bytes());
    payload[16..20].copy_from_slice(&id.sequence.to_le_bytes());
    let size = (payload.len() - 40) as u32;
    payload[20..24].copy_from_slice(&size.to_le_bytes());
    payload[24..32].copy_from_slice(&(id.observed as u64).to_le_bytes());
    payload[32..40].copy_from_slice(&(id.target as u64).to_le_bytes());
    let mut mask = 0_u32;
    for joint in 0..joints {
        let values = &state[begin + joint * width..begin + (joint + 1) * width];
        let norm: f32 = values[3..7].iter().map(|v| v * v).sum();
        let observed = !gap
            && if let Some(valid) = valid {
                ensure!(
                    !valid.is_null(valid_begin + joint),
                    "Missing joint validity"
                );
                valid.value(valid_begin + joint)
            } else {
                state[tracked] > 0.0 && norm > 0.0
            };
        if observed {
            ensure!(
                values.iter().all(|v| v.is_finite()) && (0.5..=1.5).contains(&norm),
                "Invalid tracked dataset transform"
            );
            ensure!(
                width == 7 || values[7] >= 0.0,
                "Invalid dataset joint radius"
            );
            mask |= 1 << joint;
            for (i, value) in values.iter().enumerate() {
                let at = if part == 0 { 40 } else { 44 } + (joint * width + i) * 4;
                payload[at..at + 4].copy_from_slice(&value.to_le_bytes());
            }
        }
    }
    payload[6] = u8::from(mask != 0);
    if part != 0 {
        payload[40..44].copy_from_slice(&mask.to_le_bytes());
    }
    crate::session::validate_pose(&payload, id.epoch, id.space)?;
    Ok(payload)
}

struct Session {
    writer: mcap::Writer<File>,
    channels: BTreeMap<String, u16>,
    origin: i64,
}
impl Session {
    fn new(file: File) -> Result<Self> {
        Ok(Self {
            writer: mcap::WriteOptions::default()
                .compression(None)
                .chunk_size(Some(4 * 1024 * 1024))
                .create(file)?,
            channels: BTreeMap::new(),
            origin: 0,
        })
    }
    fn event(
        &mut self,
        kind: &str,
        time: i64,
        id: &PoseIdentity,
        attrs: Value,
        payload: &[u8],
        keyframe: bool,
    ) -> Result<()> {
        let topic = format!("/ceres/{kind}");
        let channel = if let Some(id) = self.channels.get(&topic) {
            *id
        } else {
            let id = self
                .writer
                .add_channel(0, &topic, "ceres-session-v1", &BTreeMap::new())?;
            self.channels.insert(topic, id);
            id
        };
        let stream = if kind == "video" { "passthrough" } else { "" };
        let pose_kind = if kind == "pose" {
            payload.get(5).copied().unwrap_or(0)
        } else {
            0
        };
        let header = json!({"version":1,"kind":kind,"receive_us":self.origin+time,"time_us":self.origin+time,"session_receive_us":time,"session_time_us":time,"epoch":id.epoch,"space_epoch":id.space,"sequence":id.sequence,"rtp_timestamp":((time as u64 * 90 / 1000) & 0xffffffff) as u32,"keyframe":keyframe,"stream":stream,"pose_kind":pose_kind,"attributes":attrs});
        let header = serde_json::to_vec(&header)?;
        ensure!(
            header.len() <= 1024 * 1024,
            "Replay event metadata exceeds its size limit"
        );
        let mut bytes = Vec::with_capacity(8 + header.len() + payload.len());
        bytes.extend_from_slice(b"CSE1");
        bytes.extend_from_slice(&(header.len() as u32).to_le_bytes());
        bytes.extend(header);
        bytes.extend_from_slice(payload);
        self.writer.write_to_known_channel(
            &mcap::records::MessageHeader {
                channel_id: channel,
                sequence: id.sequence,
                log_time: time as u64 * 1000,
                publish_time: time as u64 * 1000,
            },
            &bytes,
        )?;
        Ok(())
    }
}

/// Access units are emitted in presentation order with lossless pixel encoding.
/// Removing B frames makes decoder output and replay timestamps one-to-one.
fn prepare_video(
    job: &ImportJob,
    input: &Path,
    output: &Path,
    errors: &Path,
    boundaries: &[u64],
) -> Result<()> {
    let mut command = Command::new(&job.ffmpeg);
    command
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-xerror",
            "-threads",
            "2",
            "-i",
        ])
        .arg(input)
        .args([
            "-map",
            "0:v:0",
            "-an",
            "-c:v",
            "libx264",
            "-threads",
            "2",
            "-preset",
            "ultrafast",
            "-qp",
            "0",
            "-bf",
            "0",
            "-x264-params",
            if boundaries.len() > 512 {
                "aud=1:repeat-headers=1:keyint=1"
            } else {
                "aud=1:repeat-headers=1:keyint=30"
            },
            "-fps_mode",
            "passthrough",
            "-f",
            "h264",
            "-forced-idr",
            "1",
        ]);
    if (2..=512).contains(&boundaries.len()) {
        command.arg("-force_key_frames").arg(format!(
            "expr:{}",
            boundaries
                .iter()
                .map(|frame| format!("eq(n,{frame})"))
                .collect::<Vec<_>>()
                .join("+")
        ));
    }
    command
        .arg(output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(File::create(errors)?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().context("Start replay video conversion")?;
    loop {
        if let Err(error) = job.check_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        if let Some(status) = child.try_wait()? {
            ensure!(
                status.success(),
                "Cannot prepare replay video: {}",
                fs::read_to_string(errors).unwrap_or_default().trim()
            );
            return Ok(());
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn video_boundaries(job: &ImportJob, path: &Path) -> Result<Vec<u64>> {
    let batches = ParquetRecordBatchReaderBuilder::try_new(File::open(path)?)?
        .with_batch_size(256)
        .build()?;
    let mut boundaries = Vec::new();
    let mut previous = None;
    let mut frame = 0;
    for batch in batches {
        job.check_cancelled()?;
        let batch = batch?;
        for row in 0..batch.num_rows() {
            let identity = (
                identifier(number(column(&batch, "episode_index")?, row)?)?,
                identifier(optional_number(&batch, "ceres.connection_epoch", row)?.unwrap_or(1.0))?,
                identifier(optional_number(&batch, "ceres.space_epoch", row)?.unwrap_or(0.0))?,
            );
            if previous != Some(identity) {
                boundaries.push(frame);
            }
            previous = Some(identity);
            frame += 1;
        }
    }
    Ok(boundaries)
}

fn access_units(bytes: &[u8]) -> Result<Vec<(usize, usize, bool)>> {
    let mut result = Vec::new();
    let mut start = None;
    let mut keyframe = false;
    let mut cursor = 0;
    while cursor + 4 < bytes.len() {
        let prefix = if bytes[cursor..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if bytes[cursor..].starts_with(&[0, 0, 1]) {
            3
        } else {
            cursor += 1;
            continue;
        };
        let kind = bytes[cursor + prefix] & 31;
        if kind == 9 {
            if let Some(start) = start {
                result.push((start, cursor, keyframe));
            }
            start = Some(cursor);
            keyframe = false;
        } else if kind == 5 {
            keyframe = true;
        }
        cursor += prefix + 1;
    }
    if let Some(start) = start {
        result.push((start, bytes.len(), keyframe));
    }
    ensure!(
        result.first().is_some_and(|frame| frame.0 == 0 && frame.2),
        "Video has no initial replay keyframe"
    );
    Ok(result)
}

fn description(info: &Value, metadata: &Value, video_key: &str, epoch: u32) -> Result<Value> {
    let shape = &info["features"][video_key]["shape"];
    let height = shape[0].as_u64().context("Missing video height")?;
    let width = shape[1].as_u64().context("Missing video width")?;
    ensure!(
        width > 0 && height > 0 && width <= 8192 && height <= 8192,
        "Invalid video dimensions"
    );
    let side = metadata["captureMetadata"]["camera"]["selection"]["value"]["side"]
        .as_str()
        .filter(|s| ["left", "right"].contains(s))
        .unwrap_or("unknown");
    Ok(
        json!({"type":"description","version":1,"epoch":epoch,"axes":"right-handed-x-right-y-up-z-back","units":"metres","quaternion":"xyzw","referenceSpace":"local-floor","clock":{"units":"microseconds","domain":"sender-monotonic","id":"lerobot-replay"},"joints":ceres_lerobot_exporter::XR_HAND_JOINTS,"camera":{"side":side,"width":width,"height":height,"requestedWidth":width,"fps":info["fps"],"calibration":null}}),
    )
}

pub fn run(job_path: &Path) -> Result<()> {
    let mut job: ImportJob = serde_json::from_reader(File::open(job_path)?)?;
    ensure!(
        job.schema == "ceres-lerobot-replay" && job.version == 1,
        "Unsupported replay import job"
    );
    let base = job_path.parent().unwrap_or(Path::new("."));
    for path in [&mut job.dataset, &mut job.output] {
        if path.is_relative() {
            *path = base.join(&*path);
        }
    }
    if let Some(path) = &mut job.cancel_file
        && path.is_relative()
    {
        *path = base.join(&*path);
    }
    job.check_cancelled()?;
    ensure!(!job.output.exists(), "Replay destination already exists");
    let info = read_json(&job.dataset.join("meta/info.json"))?;
    ensure!(
        info["codebase_version"] == "v3.0",
        "Replay requires a LeRobot v3 dataset"
    );
    ensure!(
        info["features"]["observation.state"]["names"]
            == json!(ceres_lerobot_exporter::state_names()),
        "Dataset does not use the CERES observation layout"
    );
    let fps = info["fps"]
        .as_f64()
        .context("Dataset is missing its frame rate")?;
    ensure!(
        fps.is_finite() && (1.0..=240.0).contains(&fps),
        "Invalid dataset frame rate"
    );
    let video_key = info["features"]
        .as_object()
        .context("Dataset is missing its features")?
        .iter()
        .filter(|(_, feature)| feature["dtype"] == "video")
        .min_by_key(|(key, _)| (*key != "observation.images.passthrough", *key))
        .map(|(key, _)| key.clone())
        .context("Dataset contains no video feature")?;
    ensure!(
        video_key
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || b"._-".contains(&v)),
        "Invalid dataset video key"
    );
    let data_root = job.dataset.join("data");
    let files = parquet_files(&data_root)?;
    let metadata_path = job.dataset.join("ceres/episode-metadata.json");
    let metadata = if metadata_path.is_file() {
        read_json(&metadata_path)?
    } else {
        json!({})
    };
    let mut tasks = tasks::TaskTimeline::load(&job.dataset, &metadata)?;
    let parent = job
        .output
        .parent()
        .context("Replay destination has no parent")?;
    fs::create_dir_all(parent)?;
    let staging = tempfile::Builder::new()
        .prefix(".ceres-replay-")
        .tempdir_in(parent)?;
    let output = staging.path().join("session.mcap");
    let mut session = Session::new(File::create(&output)?)?;
    let mut frame_count = 0_u64;
    let mut episode = None;
    let mut last_identity = None;
    let mut episode_base = 0;
    let mut previous_timestamp = None;
    let mut last_time = 0;
    let mut last_id = PoseIdentity {
        epoch: 1,
        space: 0,
        sequence: 0,
        observed: 0,
        target: 0,
    };
    for (file_index, path) in files.iter().enumerate() {
        job.check_cancelled()?;
        crate::progress("importing", file_index as u64, files.len() as u64);
        let video = job
            .dataset
            .join("videos")
            .join(&video_key)
            .join(path.strip_prefix(&data_root)?)
            .with_extension("mp4");
        ensure!(
            video.is_file(),
            "Dataset video file is missing: {}",
            video.display()
        );
        let h264 = staging.path().join(format!("video-{file_index}.h264"));
        prepare_video(
            &job,
            &video,
            &h264,
            &staging.path().join("ffmpeg.log"),
            &video_boundaries(&job, path)?,
        )?;
        // The conversion file is private to this staging directory and remains immutable while mapped.
        let map = unsafe { memmap2::Mmap::map(&File::open(&h264)?)? };
        let units = access_units(&map)?;
        let batches = ParquetRecordBatchReaderBuilder::try_new(File::open(path)?)?
            .with_batch_size(256)
            .build()?;
        let mut video_index = 0;
        for batch in batches {
            let batch = batch?;
            for row in 0..batch.num_rows() {
                job.check_cancelled()?;
                let timestamp = micros(number(column(&batch, "timestamp")?, row)?)?;
                let current_episode = identifier(number(column(&batch, "episode_index")?, row)?)?;
                let new_episode = episode != Some(current_episode);
                if new_episode {
                    if episode.is_some() {
                        episode_base = last_time + micros(1.0 / fps)?;
                    }
                    episode = Some(current_episode);
                    previous_timestamp = None;
                }
                ensure!(
                    previous_timestamp.is_none_or(|v| timestamp > v),
                    "Dataset timestamps must increase within an episode"
                );
                previous_timestamp = Some(timestamp);
                let time = episode_base + timestamp;
                let source = batch
                    .column_by_name("ceres.source_timestamp")
                    .filter(|a| {
                        !matches!(a.data_type(), arrow_schema::DataType::FixedSizeList(_, _))
                    })
                    .map(|a| number(a.as_ref(), row))
                    .transpose()?
                    .unwrap_or(timestamp as f64 / 1_000_000.0);
                let observed = micros(source)?;
                if frame_count == 0 {
                    session.origin = observed.saturating_sub(timestamp);
                }
                let epoch = identifier(
                    optional_number(&batch, "ceres.connection_epoch", row)?.unwrap_or(1.0),
                )?;
                let space =
                    identifier(optional_number(&batch, "ceres.space_epoch", row)?.unwrap_or(0.0))?;
                let sequence = identifier(
                    optional_number(&batch, "ceres.source_frame_index", row)?
                        .unwrap_or(number(column(&batch, "frame_index")?, row)?),
                )?;
                let mut id = PoseIdentity {
                    epoch,
                    space,
                    sequence,
                    observed,
                    target: observed,
                };
                tasks.observe(&batch, row, time, &id)?;
                if last_identity != Some((epoch, space)) || new_episode {
                    session.event(
                        "epoch",
                        time,
                        &id,
                        json!({"reason":"connection"}),
                        &[],
                        false,
                    )?;
                    session.event(
                        "metadata",
                        time,
                        &id,
                        description(&info, &metadata, &video_key, epoch)?,
                        &[],
                        false,
                    )?;
                    last_identity = Some((epoch, space));
                }
                let states = list(&batch, "observation.state", row, crate::STATE_DIM)?
                    .context("Missing observation state")?;
                let states = states
                    .as_any()
                    .downcast_ref::<Float32Array>()
                    .context("Observation state must contain float32 values")?;
                ensure!(
                    states.null_count() == 0,
                    "Observation state contains missing values"
                );
                let valid = list(&batch, "observation.valid", row, crate::VALID_DIM)?;
                let valid = valid
                    .as_ref()
                    .map(|a| {
                        a.as_any()
                            .downcast_ref::<BooleanArray>()
                            .context("Observation validity must contain Boolean values")
                    })
                    .transpose()?;
                let gap = optional_bool(&batch, "ceres.source_gap", row)?.unwrap_or(false);
                let sender = if batch.column_by_name("ceres.sender_timestamp").is_some() {
                    list(&batch, "ceres.sender_timestamp", row, 3)?
                } else if batch
                    .column_by_name("ceres.source_timestamp")
                    .is_some_and(|a| {
                        matches!(a.data_type(), arrow_schema::DataType::FixedSizeList(_, _))
                    })
                {
                    list(&batch, "ceres.source_timestamp", row, 3)?
                } else {
                    None
                };
                let target = list(&batch, "ceres.sender_target_timestamp", row, 3)?;
                let sequences = list(&batch, "ceres.sender_sequence", row, 3)?;
                let clock_source = if let Some(sender) = &sender {
                    (0..3)
                        .map(|part| number(sender.as_ref(), part))
                        .collect::<Result<Vec<_>>>()?
                        .into_iter()
                        .find(|value| *value >= 0.0)
                        .map(micros)
                        .transpose()?
                        .unwrap_or(observed)
                } else {
                    observed
                };
                session.event("clock",time,&id,json!({"offset_us":session.origin+time-clock_source,"uncertainty_us":0,"rate":1.0,"valid":true}),&[],false)?;
                let mut head_sequence = None;
                for part in 0..3 {
                    let sender_time = sender
                        .as_ref()
                        .map(|a| number(a.as_ref(), part))
                        .transpose()?
                        .filter(|v| *v >= 0.0);
                    id.observed = sender_time.map(micros).transpose()?.unwrap_or(observed);
                    id.target = target
                        .as_ref()
                        .map(|a| number(a.as_ref(), part))
                        .transpose()?
                        .filter(|v| *v >= 0.0)
                        .map(micros)
                        .transpose()?
                        .unwrap_or(id.observed);
                    id.sequence = sequences
                        .as_ref()
                        .map(|a| number(a.as_ref(), part))
                        .transpose()?
                        .filter(|v| *v >= 0.0)
                        .map(identifier)
                        .transpose()?
                        .unwrap_or(sequence);
                    let payload = pose_packet(states.values(), valid, gap, part, &id)?;
                    if part == 0 && payload[6] != 0 {
                        head_sequence = Some(id.sequence);
                    }
                    session.event(
                        "pose",
                        time,
                        &id,
                        json!({"source_gap":gap}),
                        &payload,
                        false,
                    )?;
                }
                id.sequence = sequence;
                let &(start, end, keyframe) = units
                    .get(video_index)
                    .context("Dataset video has fewer frames than its observations")?;
                let mut attrs = json!({"camera_primary":true,"rtp_clock_hz":90000,"source_timestamp":source,"video_valid":optional_bool(&batch,"observation.video_valid",row)?.unwrap_or(true)});
                if let Some(sequence) = head_sequence {
                    attrs["head_sequence"] = json!(sequence);
                    attrs["head_pose"] = json!(&states.values()[1..8]);
                }
                session.event("video", time, &id, attrs, &map[start..end], keyframe)?;
                video_index += 1;
                frame_count += 1;
                last_time = time;
                last_id = id;
            }
        }
        ensure!(
            video_index > 0 && video_index == units.len(),
            "Dataset video and observation frame counts differ"
        );
    }
    ensure!(frame_count > 0, "Dataset contains no replay frames");
    for interval in tasks.finish(last_time + micros(1.0 / fps)?)? {
        session.event(
            "episode",
            interval.start_us,
            &interval.identity,
            interval.attributes,
            &[],
            false,
        )?;
    }
    session.event(
        "metadata",
        last_time + micros(1.0 / fps)?,
        &last_id,
        json!({"type":"replay-end"}),
        &[],
        false,
    )?;
    session.writer.finish()?;
    drop(session);
    job.check_cancelled()?;
    File::options().write(true).open(&output)?.sync_all()?;
    fs::rename(&output, &job.output).context("Publish replay session")?;
    crate::progress("complete", frame_count, frame_count);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gap_and_missing_joints_do_not_reuse_tracking() {
        let mut state = [0.0; crate::STATE_DIM];
        state[0] = 1.0;
        state[7] = 1.0;
        state[8] = 1.0;
        state[15] = 1.0;
        state[16] = 0.02;
        let id = PoseIdentity {
            epoch: 7,
            space: 4,
            sequence: 91,
            observed: 1786897432038984,
            target: 1786897432039999,
        };
        let head = pose_packet(&state, None, false, 0, &id).unwrap();
        assert_eq!(head[6], 1);
        assert_eq!(
            u64::from_le_bytes(head[24..32].try_into().unwrap()),
            id.observed as u64
        );
        let hand = pose_packet(&state, None, false, 1, &id).unwrap();
        assert_eq!(u32::from_le_bytes(hand[40..44].try_into().unwrap()), 1);
        assert!(hand[76..].iter().all(|v| *v == 0));
        let gap = pose_packet(&state, None, true, 1, &id).unwrap();
        assert_eq!(gap[6], 0);
        assert!(gap[40..].iter().all(|v| *v == 0));
    }
    #[test]
    fn access_units_keep_keyframes_and_both_start_codes() {
        let bytes = [
            0, 0, 0, 1, 9, 1, 0, 0, 1, 7, 1, 0, 0, 1, 5, 2, 0, 0, 1, 9, 1, 0, 0, 1, 1, 2,
        ];
        assert_eq!(
            access_units(&bytes).unwrap(),
            vec![(0, 16, true), (16, 26, false)]
        );
        assert!(access_units(&[0, 0, 1, 9, 1, 0, 0, 1, 1, 2]).is_err());
    }
}
