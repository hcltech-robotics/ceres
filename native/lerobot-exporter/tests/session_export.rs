use arrow_array::{Array, BooleanArray, FixedSizeListArray, Float32Array};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    path::{Path, PathBuf},
    process::Command,
};

fn head(epoch: u32, sequence: u32, time: i64) -> Vec<u8> {
    let mut bytes = vec![0; 68];
    bytes[..4].copy_from_slice(b"CBR1");
    bytes[4] = 1;
    bytes[5] = 1;
    bytes[6] = 1;
    bytes[8..12].copy_from_slice(&epoch.to_le_bytes());
    bytes[16..20].copy_from_slice(&sequence.to_le_bytes());
    bytes[20..24].copy_from_slice(&28_u32.to_le_bytes());
    bytes[24..32].copy_from_slice(&(time as u64).to_le_bytes());
    bytes[32..40].copy_from_slice(&(time as u64).to_le_bytes());
    bytes[40..44].copy_from_slice(&(sequence as f32 + 1.0).to_le_bytes());
    bytes[64..68].copy_from_slice(&1_f32.to_le_bytes());
    bytes
}
fn write_event(
    writer: &mut mcap::Writer<File>,
    channel: u16,
    kind: &str,
    time: i64,
    epoch: u32,
    sequence: u32,
    payload: &[u8],
) {
    let header=serde_json::to_vec(&json!({"kind":kind,"receive_us":1_000_000+time,"time_us":1_000_000+time,"session_receive_us":time,"session_time_us":time,"epoch":epoch,"space_epoch":0,"sequence":sequence,"keyframe":true,"stream":"video","attributes":{}})).unwrap();
    let mut data = b"CSE1".to_vec();
    data.extend_from_slice(&(header.len() as u32).to_le_bytes());
    data.extend(header);
    data.extend(payload);
    writer
        .write_to_known_channel(
            &mcap::records::MessageHeader {
                channel_id: channel,
                sequence,
                log_time: time as u64 * 1000,
                publish_time: time as u64 * 1000,
            },
            &data,
        )
        .unwrap();
}
fn fixture(root: &Path) -> PathBuf {
    let ffmpeg = std::env::var("FFMPEG").unwrap_or_else(|_| "ffmpeg".into());
    let source = root.join("source.h264");
    let result = Command::new(&ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=16x16:rate=30",
            "-frames:v",
            "3",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-bf",
            "0",
            "-x264-params",
            "aud=1:keyint=1:repeat-headers=1",
            "-f",
            "h264",
        ])
        .arg(&source)
        .status()
        .unwrap();
    assert!(result.success());
    let bytes = fs::read(&source).unwrap();
    let mut starts = Vec::new();
    for i in 0..bytes.len().saturating_sub(5) {
        if bytes[i..].starts_with(&[0, 0, 0, 1]) && bytes[i + 4] & 31 == 9 {
            starts.push(i);
        }
    }
    assert_eq!(starts.len(), 3);
    starts.push(bytes.len());
    let units: Vec<&[u8]> = starts
        .windows(2)
        .map(|pair| &bytes[pair[0]..pair[1]])
        .collect();
    let session = root.join("session.mcap");
    let mut writer = mcap::Writer::new(File::create(&session).unwrap()).unwrap();
    let channel = writer
        .add_channel(0, "ceres/events", "ceres-session-v1", &BTreeMap::new())
        .unwrap();
    for (sequence, time) in [0, 33_333, 100_000].into_iter().enumerate() {
        write_event(
            &mut writer,
            channel,
            "pose",
            time,
            1,
            sequence as u32,
            &head(1, sequence as u32, time),
        );
        write_event(
            &mut writer,
            channel,
            "video",
            time,
            1,
            sequence as u32,
            units[sequence],
        );
    }
    write_event(&mut writer, channel, "epoch", 150_000, 2, 0, &[]);
    write_event(
        &mut writer,
        channel,
        "pose",
        150_000,
        2,
        0,
        &head(2, 0, 150_000),
    );
    write_event(&mut writer, channel, "video", 150_000, 2, 0, units[0]);
    write_event(&mut writer, channel, "metadata", 200_000, 2, 0, b"{}");
    writer.finish().unwrap();
    drop(writer);
    let job = root.join("job.json");
    fs::write(&job,serde_json::to_vec_pretty(&json!({"schema":"ceres-native-export","version":1,"session":"session.mcap","output":"dataset","fps":30,"ffmpeg":ffmpeg,"episodes":[{"start_us":0,"end_us":200_000,"task":"Move the tracked head"}],"video":{"stream":"video","width":16,"height":16}})).unwrap()).unwrap();
    job
}

#[test]
fn exports_real_mcap_video_gaps_and_epoch_boundaries() {
    let temporary = tempfile::tempdir().unwrap();
    let saved = std::env::var_os("CERES_EXPORT_ORACLE_DIR").map(PathBuf::from);
    let root = saved.as_deref().unwrap_or(temporary.path());
    fs::create_dir_all(root).unwrap();
    let job = fixture(root);
    ceres_native_exporter::run(&job).unwrap();
    let output = root.join("dataset");
    let info: Value =
        serde_json::from_reader(File::open(output.join("meta/info.json")).unwrap()).unwrap();
    assert_eq!(info["total_episodes"], 2);
    assert_eq!(info["total_frames"], 7);
    assert!(info["features"].get("action").is_none());
    assert_eq!(info["features"]["observation.state"]["shape"], json!([410]));
    let mut reader = ParquetRecordBatchReaderBuilder::try_new(
        File::open(output.join("data/chunk-000/file-000.parquet")).unwrap(),
    )
    .unwrap()
    .build()
    .unwrap();
    let batch = reader.next().unwrap().unwrap();
    assert_eq!(batch.num_rows(), 5);
    let video = batch
        .column_by_name("observation.video_valid")
        .unwrap()
        .as_any()
        .downcast_ref::<BooleanArray>()
        .unwrap();
    assert_eq!(
        (0..5).map(|i| video.value(i)).collect::<Vec<_>>(),
        vec![true, true, false, true, false]
    );
    let state = batch
        .column_by_name("observation.state")
        .unwrap()
        .as_any()
        .downcast_ref::<FixedSizeListArray>()
        .unwrap();
    let gap = state.value(2);
    let gap = gap.as_any().downcast_ref::<Float32Array>().unwrap();
    assert!(gap.values().iter().all(|&x| x == 0.0));
    let valid = batch
        .column_by_name("observation.valid")
        .unwrap()
        .as_any()
        .downcast_ref::<FixedSizeListArray>()
        .unwrap();
    assert_eq!(valid.value_length(), 51);
    let gap = valid.value(2);
    let gap = gap.as_any().downcast_ref::<BooleanArray>().unwrap();
    assert!((0..gap.len()).all(|i| !gap.value(i)));
    assert!(
        ceres_native_exporter::run(&job)
            .unwrap_err()
            .to_string()
            .contains("output already exists")
    );
}

#[test]
fn cancellation_does_not_publish_a_dataset() {
    let root = tempfile::tempdir().unwrap();
    let job = fixture(root.path());
    let mut document: Value = serde_json::from_reader(File::open(&job).unwrap()).unwrap();
    document["cancel_file"] = json!("cancel");
    fs::write(&job, serde_json::to_vec(&document).unwrap()).unwrap();
    fs::write(root.path().join("cancel"), b"").unwrap();
    assert!(
        ceres_native_exporter::run(&job)
            .unwrap_err()
            .to_string()
            .contains("cancelled")
    );
    assert!(!root.path().join("dataset").exists());
}

#[test]
fn trimmed_range_excludes_earlier_samples_and_selects_video_automatically() {
    let root = tempfile::tempdir().unwrap();
    let job = fixture(root.path());
    let mut document: Value = serde_json::from_reader(File::open(&job).unwrap()).unwrap();
    document["episodes"] =
        json!([{"start_us":34_000,"end_us":140_000,"task":"Inspect the component"}]);
    document["video"].as_object_mut().unwrap().remove("stream");
    fs::write(&job, serde_json::to_vec(&document).unwrap()).unwrap();
    ceres_native_exporter::run(&job).unwrap();
    let path = root.path().join("dataset/data/chunk-000/file-000.parquet");
    let batch = ParquetRecordBatchReaderBuilder::try_new(File::open(path).unwrap())
        .unwrap()
        .build()
        .unwrap()
        .next()
        .unwrap()
        .unwrap();
    let video = batch
        .column_by_name("observation.video_valid")
        .unwrap()
        .as_any()
        .downcast_ref::<BooleanArray>()
        .unwrap();
    assert_eq!(
        (0..batch.num_rows())
            .map(|i| video.value(i))
            .collect::<Vec<_>>(),
        vec![false, false, true, false]
    );
}
