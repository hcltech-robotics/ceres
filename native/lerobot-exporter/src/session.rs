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
        data.len() >= 8 && &data[..4] == b"CSE1",
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
    pub video_path: PathBuf,
}
#[derive(Debug)]
pub struct SessionIndex {
    pub epochs: Vec<Epoch>,
}
#[derive(Debug)]
pub struct Segment {
    pub epoch_index: usize,
    pub start_us: i64,
    pub end_us: i64,
    pub task: String,
}

impl SessionIndex {
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
    for message in mcap::MessageStream::new(&map)? {
        job.check_cancelled()?;
        let message = message?;
        if message.channel.message_encoding != "ceres-session-v1" {
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
                    video_path,
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
            files[idx].1.write_all(payload)?;
            epoch.video_times.push(header.session_time_us);
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
    Ok(SessionIndex { epochs })
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

pub fn read_pose(
    file: &mut File,
    offset: u64,
    state: &mut [f32; STATE_DIM],
    valid: &mut [bool; VALID_DIM],
) -> Result<f64> {
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
    Ok(u64::from_le_bytes(bytes[24..32].try_into()?) as f64 / 1_000_000.0)
}

#[cfg(test)]
mod tests {
    use super::*;
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
            video_path: PathBuf::new(),
        };
        let index = SessionIndex {
            epochs: vec![epoch(0, 0, 50), epoch(1, 50, 100)],
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
