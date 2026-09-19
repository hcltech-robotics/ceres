use crate::{EpisodeRange, ExportJob, STATE_DIM, VALID_DIM};
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

pub const SOURCE_EVENTS_FILE: &str = "ceres-source-events.jsonl";
const MAX_ENVELOPE_BYTES: usize = 128 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = MAX_ENVELOPE_BYTES + 64 * 1024;
// A writer may exceed its normal 4 MiB target by one maximal event plus framing.
const MAX_CHUNK_BYTES: usize = 136 * 1024 * 1024;

fn split_record(bytes: &[u8], limit: usize) -> Result<(u8, &[u8], &[u8])> {
    ensure!(bytes.len() >= 9, "truncated MCAP record header");
    let length = u64::from_le_bytes(bytes[1..9].try_into()?);
    ensure!(
        length <= limit as u64,
        "MCAP record exceeds {limit} byte limit"
    );
    let length = length as usize;
    ensure!(length <= bytes.len() - 9, "truncated MCAP record body");
    Ok((bytes[0], &bytes[9..9 + length], &bytes[9 + length..]))
}

fn validate_compressed_chunk(
    mut bytes: &[u8],
    check_cancelled: &mut impl FnMut() -> Result<()>,
) -> Result<()> {
    use mcap::sans_io::{LinearReadEvent, LinearReader, LinearReaderOptions};
    let mut reader = LinearReader::new_with_options(
        LinearReaderOptions::default()
            .with_skip_start_magic(true)
            .with_skip_end_magic(true)
            .with_record_length_limit(MAX_RECORD_BYTES)
            .with_validate_chunk_crcs(true),
    );
    while let Some(event) = reader.next_event() {
        check_cancelled()?;
        if let LinearReadEvent::ReadRequest(wanted) = event? {
            let count = wanted.min(bytes.len()).min(64 * 1024);
            reader.insert(count).copy_from_slice(&bytes[..count]);
            reader.notify_read(count);
            bytes = &bytes[count..];
        }
    }
    Ok(())
}

fn validated_messages(
    bytes: &[u8],
    mut check_cancelled: impl FnMut() -> Result<()>,
) -> Result<mcap::read::RawMessageStream<'_>> {
    ensure!(
        bytes.len() >= 16 && bytes.starts_with(mcap::MAGIC) && bytes.ends_with(mcap::MAGIC),
        "invalid or incomplete MCAP framing"
    );
    let mut remaining = &bytes[8..bytes.len() - 8];
    while !remaining.is_empty() {
        check_cancelled()?;
        let chunk = remaining[0] == mcap::records::op::CHUNK;
        let limit = if chunk {
            MAX_CHUNK_BYTES
        } else {
            MAX_RECORD_BYTES
        };
        let (_, body, next) = split_record(remaining, limit)?;
        if chunk {
            ensure!(body.len() >= 40, "truncated MCAP chunk header");
            let uncompressed = u64::from_le_bytes(body[16..24].try_into()?);
            ensure!(
                uncompressed <= MAX_CHUNK_BYTES as u64,
                "MCAP chunk exceeds {MAX_CHUNK_BYTES} byte uncompressed limit"
            );
            let compression_length = u32::from_le_bytes(body[28..32].try_into()?) as usize;
            ensure!(
                compression_length <= 16 && body.len() >= 40 + compression_length,
                "invalid MCAP chunk compression field"
            );
            let records_start = 40 + compression_length;
            let compressed = u64::from_le_bytes(body[records_start - 8..records_start].try_into()?);
            ensure!(
                compressed <= MAX_CHUNK_BYTES as u64
                    && compressed <= (body.len() - records_start) as u64,
                "invalid or oversized MCAP chunk data"
            );
            if compression_length == 0 {
                ensure!(
                    uncompressed == compressed,
                    "uncompressed MCAP chunk lengths differ"
                );
                let mut records = &body[records_start..records_start + compressed as usize];
                while !records.is_empty() {
                    check_cancelled()?;
                    let (opcode, _, rest) = split_record(records, MAX_RECORD_BYTES)?;
                    ensure!(
                        opcode != mcap::records::op::CHUNK,
                        "nested MCAP chunks are unsupported"
                    );
                    records = rest;
                }
            } else {
                // The mapped reader does not expose record limits. Validate compressed
                // records with the bounded reader before it can allocate a decoded record.
                validate_compressed_chunk(&remaining[..9 + body.len()], &mut check_cancelled)?;
            }
        }
        remaining = next;
    }
    Ok(mcap::read::RawMessageStream::new(bytes)?)
}

#[derive(Debug, Deserialize)]
pub struct Header {
    pub kind: String,
    pub session_receive_us: i64,
    pub session_time_us: i64,
    pub epoch: u32,
    pub space_epoch: u32,
    #[serde(default)]
    pub keyframe: bool,
    #[serde(default)]
    pub stream: String,
}

pub fn envelope(data: &[u8]) -> Result<(Header, &[u8])> {
    ensure!(
        data.len() >= 8 && data.len() <= MAX_ENVELOPE_BYTES && &data[..4] == b"CSE1",
        "invalid CSE1 session envelope"
    );
    let length = u32::from_le_bytes(data[4..8].try_into()?) as usize;
    ensure!(
        length <= 1_048_576 && length <= data.len() - 8,
        "invalid CSE1 header length"
    );
    let header: Header =
        serde_json::from_slice(&data[8..8 + length]).context("invalid CSE1 header")?;
    ensure!(
        header.session_time_us >= 0 && header.session_receive_us >= 0,
        "negative session timestamp"
    );
    Ok((header, &data[8 + length..]))
}

#[derive(Debug)]
pub struct Samples {
    pub times: Vec<i64>,
    pub offsets: Vec<u64>,
    pub path: PathBuf,
}
impl Samples {
    fn new(path: PathBuf) -> Self {
        Self {
            times: vec![],
            offsets: vec![],
            path,
        }
    }
    fn sort(&mut self) {
        let mut entries: Vec<_> = self.times.drain(..).zip(self.offsets.drain(..)).collect();
        entries.sort_by_key(|&(time, offset)| (time, offset));
        (self.times, self.offsets) = entries.into_iter().unzip();
    }
}

#[derive(Debug)]
pub struct Epoch {
    pub epoch: u32,
    pub space_epoch: u32,
    pub start_us: i64,
    pub end_us: i64,
    pub poses: [Samples; 3],
    pub video_times: Vec<i64>,
    pub video_bytes: Vec<usize>,
    pub video_path: PathBuf,
    pub video_keyframes: Vec<(usize, u64)>,
    pub video_reconfigurations: Vec<usize>,
    video_sps: Vec<u8>,
}
#[derive(Debug)]
pub struct SessionIndex {
    pub epochs: Vec<Epoch>,
    pub capture_events: Vec<serde_json::Value>,
}
#[derive(Debug)]
pub struct Segment {
    pub epoch_index: usize,
    pub start_us: i64,
    pub end_us: i64,
    pub task: String,
}

impl SessionIndex {
    pub fn resolve_dimensions(
        &self,
        job: &mut ExportJob,
        segments: &[Segment],
        spool: &Path,
    ) -> Result<()> {
        let mut configurations = BTreeMap::new();
        let mut dimensions = None;
        for segment in segments {
            job.check_cancelled()?;
            let epoch = &self.epochs[segment.epoch_index];
            let begin = epoch.video_times.partition_point(|&t| t < segment.start_us);
            let end = epoch.video_times.partition_point(|&t| t < segment.end_us);
            if begin == end {
                continue;
            }
            // Camera metadata describes the capture track. WebRTC may encode at
            // a smaller resolution, so only decoded H264 determines the dataset.
            // Probe each configuration once, including the one active at mark-in.
            for sample in std::iter::once(begin).chain(
                epoch
                    .video_reconfigurations
                    .iter()
                    .copied()
                    .filter(|&first| first > begin && first < end),
            ) {
                job.check_cancelled()?;
                let configuration = epoch
                    .video_reconfigurations
                    .partition_point(|&first| first <= sample);
                let key = (segment.epoch_index, configuration);
                let current = if let Some(&value) = configurations.get(&key) {
                    value
                } else {
                    let keyframe = epoch
                        .video_keyframes
                        .partition_point(|&(first, _)| first <= sample)
                        .saturating_sub(1);
                    let (_, offset) = epoch.video_keyframes[keyframe];
                    let value = crate::video::Decoder::source_dimensions(
                        job,
                        &epoch.video_path,
                        &spool.join(format!(
                            "dimensions-{}-{configuration}.log",
                            segment.epoch_index
                        )),
                        offset,
                    )?;
                    configurations.insert(key, value);
                    value
                };
                let expected = dimensions.get_or_insert(current);
                ensure!(
                    current == *expected,
                    "selected range {}..{} us contains source camera dimensions {}x{}, which differ from {}x{} in the other selected images; select ranges at a single source resolution and use those exact dimensions",
                    segment.start_us,
                    segment.end_us,
                    current.0,
                    current.1,
                    expected.0,
                    expected.1
                );
            }
        }
        if let Some((width, height)) = dimensions {
            if job.video.source_dimensions {
                job.video.width = width;
                job.video.height = height;
            } else {
                ensure!(
                    (job.video.width, job.video.height) == (width, height),
                    "selected source image is {width}x{height}, but the export requests {}x{}; select ranges at a single source resolution and use those exact dimensions",
                    job.video.width,
                    job.video.height
                );
            }
        }
        Ok(())
    }
    pub fn split_ranges(&self, ranges: &[EpisodeRange]) -> Result<Vec<Segment>> {
        let mut result = Vec::new();
        for range in ranges {
            for (epoch_index, epoch) in self.epochs.iter().enumerate() {
                let start_us = range.start_us.max(epoch.start_us);
                let end_us = range.end_us.min(epoch.end_us);
                if start_us < end_us {
                    result.push(Segment {
                        epoch_index,
                        start_us,
                        end_us,
                        task: range.task.trim().to_owned(),
                    });
                }
            }
        }
        Ok(result)
    }
}

pub fn index(job: &ExportJob, spool: &Path) -> Result<SessionIndex> {
    let mut capture_events = Vec::new();
    let source = File::open(&job.session).context("open session MCAP")?;
    // The file remains open and immutable throughout this read-only mapping.
    let map = unsafe { memmap2::Mmap::map(&source)? };
    let mut epochs: Vec<Epoch> = Vec::new();
    let mut by_key = BTreeMap::new();
    let mut files: Vec<([File; 3], File)> = Vec::new();
    let mut source_events = BufWriter::with_capacity(
        64 * 1024,
        File::create(spool.join(SOURCE_EVENTS_FILE)).context("create source event provenance")?,
    );
    let mut final_time = 0;
    let mut selected_stream = if job.video.stream.is_empty() {
        None
    } else {
        Some(job.video.stream.clone())
    };
    let mut messages = validated_messages(&map, || job.check_cancelled())?;
    while let Some(message) = messages.next() {
        job.check_cancelled()?;
        let message = message?;
        let channel = messages
            .get_channel(message.header.channel_id)
            .context("message references an unknown MCAP channel")?;
        if channel.message_encoding != "ceres-session-v1" {
            continue;
        }
        let (header, payload) = envelope(&message.data)?;
        // Compact one original header at a time. Unknown fields and all attributes
        // are preserved while media and tracking payloads stay in the MCAP.
        let header_end = message.data.len() - payload.len();
        let original_header: serde_json::Value =
            serde_json::from_slice(&message.data[8..header_end])?;
        serde_json::to_writer(&mut source_events, &original_header)?;
        source_events.write_all(b"\n")?;
        let attributes = &original_header["attributes"];
        if header.kind == "calibration"
            || (header.kind == "metadata" && attributes.get("camera").is_some())
        {
            capture_events.push(original_header.clone());
        }
        final_time = final_time
            .max(header.session_receive_us)
            .max(header.session_time_us);
        if !matches!(header.kind.as_str(), "pose" | "video" | "epoch") {
            continue;
        }
        let key = (header.epoch, header.space_epoch);
        let idx = match by_key.get(&key) {
            Some(&idx) => idx,
            None => {
                let idx = epochs.len();
                let poses = std::array::from_fn(|part| {
                    Samples::new(spool.join(format!("epoch-{idx}-pose-{part}.bin")))
                });
                let pose_files = [
                    File::create(&poses[0].path)?,
                    File::create(&poses[1].path)?,
                    File::create(&poses[2].path)?,
                ];
                let video_path = spool.join(format!("epoch-{idx}.h264"));
                let video_file = File::create(&video_path)?;
                epochs.push(Epoch {
                    epoch: header.epoch,
                    space_epoch: header.space_epoch,
                    start_us: header.session_receive_us.min(header.session_time_us),
                    end_us: i64::MAX,
                    poses,
                    video_times: vec![],
                    video_bytes: vec![],
                    video_path,
                    video_keyframes: vec![],
                    video_reconfigurations: vec![],
                    video_sps: vec![],
                });
                files.push((pose_files, video_file));
                by_key.insert(key, idx);
                idx
            }
        };
        if header.kind == "pose" {
            let part = validate_pose(payload, header.epoch, header.space_epoch)?;
            let file = &mut files[idx].0[part];
            let offset = file.stream_position()?;
            file.write_all(&(payload.len() as u32).to_le_bytes())?;
            file.write_all(payload)?;
            epochs[idx].poses[part].times.push(header.session_time_us);
            epochs[idx].poses[part].offsets.push(offset);
        } else if header.kind == "video" {
            let selected = selected_stream.get_or_insert_with(|| header.stream.clone());
            if &header.stream != selected {
                continue;
            }
            let epoch = &mut epochs[idx];
            if epoch.video_times.is_empty() && !header.keyframe {
                continue;
            }
            ensure!(!payload.is_empty(), "empty H264 access unit");
            ensure!(
                payload.starts_with(&[0, 0, 0, 1]) || payload.starts_with(&[0, 0, 1]),
                "video must contain Annex B H264 access units"
            );
            ensure!(
                epoch
                    .video_times
                    .last()
                    .is_none_or(|&t| header.session_time_us > t),
                "video presentation timestamps must increase within an epoch"
            );
            if header.keyframe {
                let signature = sps_signature(payload);
                if signature != epoch.video_sps {
                    epoch.video_reconfigurations.push(epoch.video_times.len());
                    epoch.video_sps = signature;
                }
                epoch
                    .video_keyframes
                    .push((epoch.video_times.len(), files[idx].1.stream_position()?));
            }
            files[idx].1.write_all(payload)?;
            epoch.video_times.push(header.session_time_us);
            epoch.video_bytes.push(payload.len());
        }
    }
    source_events
        .flush()
        .context("flush source event provenance")?;
    drop(files);
    epochs.sort_by_key(|epoch| epoch.start_us);
    for idx in 0..epochs.len() {
        epochs[idx].end_us = if idx + 1 < epochs.len() {
            epochs[idx + 1].start_us
        } else {
            final_time.saturating_add(1)
        };
        for samples in &mut epochs[idx].poses {
            samples.sort();
        }
    }
    ensure!(!epochs.is_empty(), "session contains no Ceres observations");
    Ok(SessionIndex {
        epochs,
        capture_events,
    })
}

fn sps_signature(bytes: &[u8]) -> Vec<u8> {
    let mut result = Vec::new();
    let mut nal_start = None;
    let mut cursor = 0;
    let append = |nal: &[u8], result: &mut Vec<u8>| {
        if nal.first().is_some_and(|byte| byte & 31 == 7) {
            result.extend_from_slice(&(nal.len() as u64).to_le_bytes());
            result.extend_from_slice(nal);
        }
    };
    while cursor + 3 <= bytes.len() {
        let prefix = if bytes[cursor..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if bytes[cursor..].starts_with(&[0, 0, 1]) {
            3
        } else {
            cursor += 1;
            continue;
        };
        if let Some(start) = nal_start {
            append(&bytes[start..cursor], &mut result);
        }
        cursor += prefix;
        nal_start = Some(cursor);
    }
    if let Some(start) = nal_start {
        append(&bytes[start..], &mut result);
    }
    result
}

pub fn validate_pose(bytes: &[u8], epoch: u32, space_epoch: u32) -> Result<usize> {
    ensure!(
        bytes.len() >= 40 && &bytes[..4] == b"CBR1" && bytes[4] == 1,
        "invalid CBR1 pose header"
    );
    let kind = bytes[5];
    ensure!((1..=3).contains(&kind), "unknown CBR1 pose kind");
    let expected = if kind == 1 { 68 } else { 844 };
    ensure!(bytes.len() == expected, "incorrect CBR1 pose length");
    let flags = u16::from_le_bytes(bytes[6..8].try_into()?);
    ensure!(flags <= 1, "invalid CBR1 validity flags");
    ensure!(
        u32_at(bytes, 8) == epoch && u32_at(bytes, 12) == space_epoch,
        "CBR1 epoch differs from session envelope"
    );
    ensure!(
        u32_at(bytes, 20) as usize == expected - 40,
        "incorrect CBR1 payload size"
    );
    for at in [24, 32] {
        ensure!(
            u64::from_le_bytes(bytes[at..at + 8].try_into()?) < (1_u64 << 53),
            "CBR1 source timestamp is out of range"
        );
    }
    let values_start = if kind == 1 { 40 } else { 44 };
    let mask = if kind == 1 {
        u32::from(flags)
    } else {
        u32_at(bytes, 40)
    };
    ensure!(
        mask < (1 << 25) && (kind == 1 || (mask != 0) == (flags != 0)),
        "invalid CBR1 joint mask"
    );
    for joint in 0..if kind == 1 { 1 } else { 25 } {
        let width = if kind == 1 { 7 } else { 8 };
        let values: Vec<f32> = (0..width)
            .map(|i| f32_at(bytes, values_start + (joint * width + i) * 4))
            .collect();
        ensure!(values.iter().all(|v| v.is_finite()), "non-finite CBR1 pose");
        if mask & (1 << joint) == 0 {
            ensure!(
                values.iter().all(|&v| v == 0.0),
                "invalid CBR1 component must be zero"
            );
        } else {
            let norm: f32 = values[3..7].iter().map(|v| v * v).sum();
            ensure!((0.5..=1.5).contains(&norm), "invalid CBR1 quaternion");
            ensure!(kind == 1 || values[7] >= 0.0, "negative CBR1 joint radius");
        }
    }
    Ok((kind - 1) as usize)
}
fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}
fn f32_at(bytes: &[u8], at: usize) -> f32 {
    f32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}

pub struct PoseSource {
    pub observed: f64,
    pub target: f64,
    pub sequence: i64,
    pub bytes: usize,
}

pub fn read_pose(
    file: &mut File,
    offset: u64,
    state: &mut [f32; STATE_DIM],
    valid: &mut [bool; VALID_DIM],
) -> Result<PoseSource> {
    file.seek(SeekFrom::Start(offset))?;
    let mut length = [0; 4];
    file.read_exact(&mut length)?;
    let mut bytes = vec![0; u32::from_le_bytes(length) as usize];
    file.read_exact(&mut bytes)?;
    let kind = bytes[5];
    let tracked = bytes[6] != 0;
    if kind == 1 {
        state[0] = u8::from(tracked) as f32;
        valid[0] = tracked;
        for i in 0..7 {
            state[1 + i] = f32_at(&bytes, 40 + 4 * i);
        }
    } else {
        let state_at = if kind == 2 { 8 } else { 209 };
        let valid_at = if kind == 2 { 1 } else { 26 };
        state[state_at] = u8::from(tracked) as f32;
        for i in 0..200 {
            state[state_at + 1 + i] = f32_at(&bytes, 44 + 4 * i);
        }
        let mask = u32_at(&bytes, 40);
        for i in 0..25 {
            valid[valid_at + i] = mask & (1 << i) != 0;
        }
    }
    Ok(PoseSource {
        observed: u64::from_le_bytes(bytes[24..32].try_into()?) as f64 / 1_000_000.0,
        target: u64::from_le_bytes(bytes[32..40].try_into()?) as f64 / 1_000_000.0,
        sequence: i64::from(u32_at(&bytes, 16)),
        bytes: bytes.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_validation_preserves_uncompressed_message_bytes() {
        let mut bytes = std::io::Cursor::new(Vec::new());
        {
            let mut writer = mcap::WriteOptions::default()
                .compression(None)
                .create(&mut bytes)
                .unwrap();
            let channel = writer
                .add_channel(0, "ceres/events", "ceres-session-v1", &BTreeMap::new())
                .unwrap();
            writer
                .write_to_known_channel(
                    &mcap::records::MessageHeader {
                        channel_id: channel,
                        sequence: 1,
                        log_time: 0,
                        publish_time: 0,
                    },
                    &[0x51; 8192],
                )
                .unwrap();
            writer.finish().unwrap();
        }
        let data = bytes.into_inner();
        let message = validated_messages(&data, || Ok(()))
            .unwrap()
            .next()
            .unwrap()
            .unwrap();
        assert_eq!(message.data.as_ref(), &[0x51; 8192]);
    }
    #[test]
    fn oversized_record_and_chunk_declarations_are_rejected_before_reading() {
        let mut record = vec![mcap::records::op::MESSAGE];
        record.extend_from_slice(&((MAX_RECORD_BYTES + 1) as u64).to_le_bytes());
        assert!(
            split_record(&record, MAX_RECORD_BYTES)
                .unwrap_err()
                .to_string()
                .contains("limit")
        );

        let mut body = vec![0; 40];
        body[16..24].copy_from_slice(&((MAX_CHUNK_BYTES + 1) as u64).to_le_bytes());
        let mut bytes = mcap::MAGIC.to_vec();
        bytes.push(mcap::records::op::CHUNK);
        bytes.extend_from_slice(&(body.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&body);
        bytes.extend_from_slice(mcap::MAGIC);
        let error = validated_messages(&bytes, || Ok(())).err().unwrap();
        assert!(error.to_string().contains("uncompressed limit"));

        body[16..24].copy_from_slice(&(record.len() as u64).to_le_bytes());
        body[32..40].copy_from_slice(&(record.len() as u64).to_le_bytes());
        body.extend(record);
        let mut nested = mcap::MAGIC.to_vec();
        nested.push(mcap::records::op::CHUNK);
        nested.extend_from_slice(&(body.len() as u64).to_le_bytes());
        nested.extend(body);
        nested.extend_from_slice(mcap::MAGIC);
        let error = validated_messages(&nested, || Ok(())).err().unwrap();
        assert!(error.to_string().contains("limit"));
    }
    #[test]
    fn envelope_rejects_truncation_and_missing_relative_time() {
        assert!(envelope(b"CSE1\xff\xff\xff\xff").is_err());
        let mut bytes = b"CSE1".to_vec();
        bytes.extend_from_slice(&2_u32.to_le_bytes());
        bytes.extend_from_slice(b"{}");
        assert!(envelope(&bytes).is_err());
    }
    #[test]
    fn packet_rejects_nonzero_invalid_head() {
        let mut bytes = vec![0; 68];
        bytes[..4].copy_from_slice(b"CBR1");
        bytes[4] = 1;
        bytes[5] = 1;
        bytes[20..24].copy_from_slice(&28_u32.to_le_bytes());
        assert_eq!(validate_pose(&bytes, 0, 0).unwrap(), 0);
        bytes[40..44].copy_from_slice(&1_f32.to_le_bytes());
        assert!(validate_pose(&bytes, 0, 0).is_err());
    }

    #[test]
    fn partial_hand_preserves_joint_layout_and_validity() {
        let mut bytes = vec![0; 844];
        bytes[..4].copy_from_slice(b"CBR1");
        bytes[4] = 1;
        bytes[5] = 3;
        bytes[6] = 1;
        bytes[20..24].copy_from_slice(&804_u32.to_le_bytes());
        bytes[40..44].copy_from_slice(&(1_u32 << 24).to_le_bytes());
        let joint = 44 + 24 * 32;
        bytes[joint..joint + 4].copy_from_slice(&2.0_f32.to_le_bytes());
        bytes[joint + 24..joint + 28].copy_from_slice(&1.0_f32.to_le_bytes());
        bytes[joint + 28..joint + 32].copy_from_slice(&0.01_f32.to_le_bytes());
        assert_eq!(validate_pose(&bytes, 0, 0).unwrap(), 2);
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(&844_u32.to_le_bytes()).unwrap();
        file.write_all(&bytes).unwrap();
        let mut state = [0.0; STATE_DIM];
        let mut valid = [false; VALID_DIM];
        read_pose(&mut file, 0, &mut state, &mut valid).unwrap();
        assert_eq!(state[209], 1.0);
        assert_eq!(state[402], 2.0);
        assert_eq!(state[409], 0.01);
        assert!(valid[50]);
        assert_eq!(valid.iter().filter(|&&v| v).count(), 1);
    }

    #[test]
    fn reference_space_change_splits_user_range() {
        let epoch = |space_epoch, start_us, end_us| Epoch {
            epoch: 1,
            space_epoch,
            start_us,
            end_us,
            poses: std::array::from_fn(|_| Samples::new(PathBuf::new())),
            video_times: vec![],
            video_bytes: vec![],
            video_path: PathBuf::new(),
            video_keyframes: vec![],
            video_reconfigurations: vec![],
            video_sps: vec![],
        };
        let index = SessionIndex {
            epochs: vec![epoch(0, 0, 50), epoch(1, 50, 100)],
            capture_events: vec![],
        };
        let segments = index
            .split_ranges(&[EpisodeRange {
                start_us: 20,
                end_us: 80,
                task: "Place part".into(),
            }])
            .unwrap();
        assert_eq!(segments.len(), 2);
        assert_eq!((segments[0].start_us, segments[0].end_us), (20, 50));
        assert_eq!((segments[1].start_us, segments[1].end_us), (50, 80));
    }
}
