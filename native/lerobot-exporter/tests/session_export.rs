use arrow_array::{
    Array, BooleanArray, FixedSizeListArray, Float32Array, Float64Array, Int64Array,
};
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
    let attributes = if kind == "video" {
        json!({"head_sequence":sequence,"head_pose":[sequence as f32 + 1.0,0,0,0,0,0,1],"rtp_clock_hz":90000})
    } else {
        json!({})
    };
    let header = json!({"version":1,"kind":kind,"receive_us":1_000_000+time,"time_us":1_000_000+time,"session_receive_us":time,"session_time_us":time,"epoch":epoch,"space_epoch":0,"sequence":sequence,"rtp_timestamp":sequence*3000,"keyframe":true,"stream":"video","attributes":attributes});
    write_header_event(writer, channel, &header, payload);
}
fn write_header_event(
    writer: &mut mcap::Writer<File>,
    channel: u16,
    header: &Value,
    payload: &[u8],
) {
    let sequence = header["sequence"].as_u64().unwrap() as u32;
    let time = header["session_receive_us"].as_u64().unwrap();
    // A multiline input header must still become one JSONL record.
    let header = serde_json::to_vec_pretty(header).unwrap();
    let mut data = b"CSE1".to_vec();
    data.extend_from_slice(&(header.len() as u32).to_le_bytes());
    data.extend(header);
    data.extend(payload);
    writer
        .write_to_known_channel(
            &mcap::records::MessageHeader {
                channel_id: channel,
                sequence,
                log_time: time * 1000,
                publish_time: time * 1000,
            },
            &data,
        )
        .unwrap();
}
fn fixture(root: &Path) -> PathBuf {
    fixture_with_options(root, None, false)
}
fn fixture_with_asset(root: &Path, asset_bytes: Option<usize>) -> PathBuf {
    fixture_with_options(root, asset_bytes, false)
}
fn hand(epoch: u32, sequence: u32, time: i64, right: bool, tips: bool) -> Vec<u8> {
    let mut bytes = vec![0; 844];
    bytes[..40].copy_from_slice(&head(epoch, sequence, time)[..40]);
    bytes[5] = if right { 3 } else { 2 };
    bytes[20..24].copy_from_slice(&804_u32.to_le_bytes());
    // Preserve independently observed sender clocks and the later predicted pose target.
    bytes[24..32].copy_from_slice(&(time as u64 + if right { 17 } else { 11 }).to_le_bytes());
    bytes[32..40].copy_from_slice(&(time as u64 + 5000).to_le_bytes());
    let mask = (1_u32 << 4) | if tips { 1 << 9 } else { 0 };
    bytes[40..44].copy_from_slice(&mask.to_le_bytes());
    for joint in [4, 9] {
        if mask & (1 << joint) == 0 {
            continue;
        }
        let offset = 44 + joint * 32;
        let position = if joint == 4 {
            [1.0_f32, 0.0, 0.0]
        } else if right {
            [1.0, 0.02, 0.0]
        } else {
            [1.03, 0.04, 0.0]
        };
        for (axis, value) in position.into_iter().enumerate() {
            bytes[offset + axis * 4..offset + axis * 4 + 4].copy_from_slice(&value.to_le_bytes());
        }
        bytes[offset + 24..offset + 28].copy_from_slice(&1.0_f32.to_le_bytes());
        bytes[offset + 28..offset + 32].copy_from_slice(&0.01_f32.to_le_bytes());
    }
    bytes
}
fn fixture_with_options(root: &Path, asset_bytes: Option<usize>, with_hands: bool) -> PathBuf {
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
    let mut options = mcap::WriteOptions::default();
    if asset_bytes.is_some() {
        options = options.compression(None).chunk_size(Some(4 * 1024 * 1024));
    }
    let mut writer = options.create(File::create(&session).unwrap()).unwrap();
    let channel = writer
        .add_channel(0, "ceres/events", "ceres-session-v1", &BTreeMap::new())
        .unwrap();
    if let Some(length) = asset_bytes {
        let mut payload = vec![0x51; length];
        payload[..4].copy_from_slice(b"CQM1");
        write_header_event(
            &mut writer,
            channel,
            &json!({"version":1,"kind":"asset","receive_us":1_000_000,"time_us":1_000_000,"session_receive_us":0,"session_time_us":0,"epoch":99,"space_epoch":0,"sequence":71,"stream":"headset-rig","attributes":{"schema":"ceres-quest-model","version":1,"name":"Quest headset","payload_bytes":length},"extension":{"preserve":"large asset"}}),
            &payload,
        );
    }
    write_header_event(
        &mut writer,
        channel,
        &json!({"version":1,"kind":"calibration","receive_us":1_000_000,"time_us":1_000_000,"session_receive_us":0,"session_time_us":0,"epoch":1,"space_epoch":0,"sequence":42,"rtp_timestamp":0,"stream":"video","attributes":{"fx":600.0,"fy":610.0,"head_from_camera":[0.02,0.01,-0.03,0,0,0,1],"name":"Measured camera"},"extension":{"preserve":true}}),
        b"calibration-payload-is-not-provenance",
    );
    if with_hands {
        write_header_event(
            &mut writer,
            channel,
            &json!({"version":1,"kind":"metadata","receive_us":1_000_000,"time_us":1_000_000,"session_receive_us":0,"session_time_us":0,"epoch":1,"space_epoch":0,"sequence":0,"attributes":{"camera":{"width":16,"height":16,"fps":30,"side":"left","label":"Passthrough left"}}}),
            &[],
        );
    }
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
        if with_hands {
            for right in [false, true] {
                write_event(
                    &mut writer,
                    channel,
                    "pose",
                    time,
                    1,
                    sequence as u32,
                    &hand(1, sequence as u32, time, right, sequence != 1 || right),
                );
            }
        }
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
    if with_hands {
        for right in [false, true] {
            write_event(
                &mut writer,
                channel,
                "pose",
                150_000,
                2,
                0,
                &hand(2, 0, 150_000, right, true),
            );
        }
    }
    write_event(&mut writer, channel, "video", 150_000, 2, 0, units[0]);
    write_event(&mut writer, channel, "metadata", 200_000, 2, 0, b"{}");
    writer.finish().unwrap();
    drop(writer);
    let job = root.join("job.json");
    let mut document = json!({"schema":"ceres-native-export","version":1,"session":"session.mcap","output":"dataset","fps":30,"ffmpeg":ffmpeg,"episodes":[{"start_us":0,"end_us":200_000,"task":"Move the tracked head"}],"video":{"stream":"video","width":16,"height":16}});
    if with_hands {
        document["episodes"] = json!([{"start_us":0,"end_us":150_000,"task":"Pinch the left hand"},{"start_us":150_000,"end_us":200_000,"task":"Pinch both hands"}]);
    } else {
        document["profile"] = json!("ceres-bridge-observation-v1");
    }
    fs::write(&job, serde_json::to_vec_pretty(&document).unwrap()).unwrap();
    job
}

#[test]
fn default_ceres_profile_exports_two_shards_and_genuine_pinch_actions() {
    let temporary = tempfile::tempdir().unwrap();
    let saved = std::env::var_os("CERES_EXPORT_CERES_ORACLE_DIR").map(PathBuf::from);
    let root = saved.as_deref().unwrap_or(temporary.path());
    fs::create_dir_all(root).unwrap();
    let job = fixture_with_options(root, None, true);
    ceres_native_exporter::run(&job).unwrap();
    let output = root.join("dataset");
    let read_json =
        |path: &Path| -> Value { serde_json::from_reader(File::open(path).unwrap()).unwrap() };
    let info = read_json(&output.join("meta/info.json"));
    assert_eq!(info["ceres_profile"], "ceres-bridge-lerobot3-v1");
    assert_eq!(
        info["features"]["action"]["names"],
        json!(["left_hand.pinch_distance", "right_hand.pinch_distance"])
    );
    assert_eq!(
        info["features"]["ceres.source_timestamp"]["shape"],
        json!([1])
    );
    assert_eq!(
        info["features"]["ceres.sender_timestamp"]["shape"],
        json!([3])
    );
    assert_eq!(info["total_episodes"], 2);
    assert_eq!(info["total_tasks"], 2);
    for (episode, count, from, start) in [(0, 5, 0, 0.0), (1, 2, 5, 0.15)] {
        let shard = output.join(format!("shards/episode-{episode:06}"));
        let suffix = format!("chunk-000/file-{episode:03}");
        for relative in [
            format!("data/{suffix}.parquet"),
            format!("meta/episodes/{suffix}.parquet"),
            format!("videos/observation.images.passthrough/{suffix}.mp4"),
            "meta/tasks.parquet".into(),
        ] {
            assert_eq!(
                fs::read(output.join(&relative)).unwrap(),
                fs::read(shard.join(relative)).unwrap()
            );
        }
        let batch = ParquetRecordBatchReaderBuilder::try_new(
            File::open(shard.join(format!("data/{suffix}.parquet"))).unwrap(),
        )
        .unwrap()
        .build()
        .unwrap()
        .next()
        .unwrap()
        .unwrap();
        assert_eq!(batch.num_rows(), count);
        let column = |key: &str| batch.column_by_name(key).unwrap();
        let integers = |key: &str| column(key).as_any().downcast_ref::<Int64Array>().unwrap();
        let sources = column("ceres.source_timestamp")
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        let gaps = column("ceres.source_gap")
            .as_any()
            .downcast_ref::<BooleanArray>()
            .unwrap();
        let actions = column("action")
            .as_any()
            .downcast_ref::<FixedSizeListArray>()
            .unwrap();
        let actions_valid = column("action.valid")
            .as_any()
            .downcast_ref::<FixedSizeListArray>()
            .unwrap();
        let sender = column("ceres.sender_timestamp")
            .as_any()
            .downcast_ref::<FixedSizeListArray>()
            .unwrap();
        let targets = column("ceres.sender_target_timestamp")
            .as_any()
            .downcast_ref::<FixedSizeListArray>()
            .unwrap();
        let sequences = column("ceres.sender_sequence")
            .as_any()
            .downcast_ref::<FixedSizeListArray>()
            .unwrap();
        for frame in 0..count {
            let gap = if episode == 0 {
                frame == 2 || frame == 4
            } else {
                frame == 1
            };
            assert_eq!(gaps.value(frame), gap);
            assert_eq!(integers("episode_index").value(frame), episode);
            assert_eq!(integers("task_index").value(frame), episode);
            assert_eq!(integers("index").value(frame), from + frame as i64);
            assert_eq!(
                integers("ceres.source_frame_index").value(frame),
                (start * 30.0_f64).floor() as i64 + frame as i64
            );
            assert!((sources.value(frame) - (start + frame as f64 / 30.0)).abs() < 1e-12);
            let action = actions.value(frame);
            let action = action.as_any().downcast_ref::<Float32Array>().unwrap();
            let valid = actions_valid.value(frame);
            let valid = valid.as_any().downcast_ref::<BooleanArray>().unwrap();
            let partial = episode == 0 && frame == 1;
            assert_eq!(valid.value(0), !gap && !partial);
            assert_eq!(valid.value(1), !gap);
            assert!((action.value(0) - if gap || partial { 0.0 } else { 0.05 }).abs() < 1e-6);
            assert!((action.value(1) - if gap { 0.0 } else { 0.02 }).abs() < 1e-6);
            let observed = sender.value(frame);
            let observed = observed.as_any().downcast_ref::<Float64Array>().unwrap();
            let target = targets.value(frame);
            let target = target.as_any().downcast_ref::<Float64Array>().unwrap();
            let sequence = sequences.value(frame);
            let sequence = sequence.as_any().downcast_ref::<Int64Array>().unwrap();
            if gap {
                assert_eq!(observed.values().as_ref(), &[-1.0; 3]);
                assert_eq!(target.values().as_ref(), &[-1.0; 3]);
                assert_eq!(sequence.values().as_ref(), &[-1; 3]);
            } else {
                assert!((observed.value(1) - observed.value(0) - 0.000011).abs() < 1e-12);
                assert!((observed.value(2) - observed.value(0) - 0.000017).abs() < 1e-12);
                assert!((target.value(1) - observed.value(0) - 0.005).abs() < 1e-12);
                assert_eq!(
                    sequence.value(0),
                    if episode == 1 {
                        0
                    } else if frame == 3 {
                        2
                    } else {
                        frame as i64
                    }
                );
            }
        }
        let metadata = read_json(&shard.join("ceres/episode-metadata.json"));
        assert_eq!(metadata["episodeIndex"], episode);
        assert_eq!(metadata["captureMetadata"]["camera"]["width"]["value"], 16);
        assert_eq!(
            metadata["captureMetadata"]["camera"]["calibration"]["availability"],
            "unknown"
        );
        if episode == 0 {
            assert_eq!(
                metadata["captureMetadata"]["camera"]["selection"]["value"]["side"],
                "left"
            );
            assert_eq!(metadata["bridge"]["capture"]["calibration"]["fx"], 600.0);
        }
        let metrics = read_json(&shard.join("ceres/metrics.json"));
        assert_eq!(metrics["frames"], count);
        assert_eq!(
            metrics["source_frame_gaps"],
            if episode == 0 { 2 } else { 1 }
        );
        assert!(metrics["input_bytes"].as_u64().unwrap() > 0);
        let shard_info = read_json(&shard.join("meta/info.json"));
        assert_eq!(shard_info["total_episodes"], episode + 1);
        assert_eq!(shard_info["total_frames"], from + count as i64);
    }
    assert!(
        fs::read_to_string(output.join("README.md"))
            .unwrap()
            .contains("path: data/**/*.parquet")
    );
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

#[test]
fn export_preserves_source_headers_calibration_and_image_head_associations() {
    let root = tempfile::tempdir().unwrap();
    let job = fixture(root.path());
    let source = fs::read(root.path().join("session.mcap")).unwrap();
    let expected: Vec<Value> = mcap::MessageStream::new(&source)
        .unwrap()
        .map(|message| {
            let message = message.unwrap();
            let length = u32::from_le_bytes(message.data[4..8].try_into().unwrap()) as usize;
            serde_json::from_slice(&message.data[8..8 + length]).unwrap()
        })
        .collect();
    ceres_native_exporter::run(&job).unwrap();
    let metadata = root.path().join("dataset/meta");
    let text = fs::read_to_string(metadata.join("ceres-source-events.jsonl")).unwrap();
    let headers: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(headers, expected);
    let calibration = headers
        .iter()
        .find(|value| value["kind"] == "calibration")
        .unwrap();
    assert_eq!(calibration["attributes"]["fx"], 600.0);
    assert_eq!(calibration["attributes"]["head_from_camera"][0], 0.02);
    assert_eq!(calibration["sequence"], 42);
    assert_eq!(calibration["extension"]["preserve"], true);
    let image = headers
        .iter()
        .find(|value| value["kind"] == "video" && value["sequence"] == 1)
        .unwrap();
    assert_eq!(image["rtp_timestamp"], 3000);
    assert_eq!(image["attributes"]["head_sequence"], 1);
    assert_eq!(
        image["attributes"]["head_pose"],
        json!([2.0, 0, 0, 0, 0, 0, 1])
    );
    assert_eq!(image["time_us"], 1_033_333);
    assert_eq!(image["session_time_us"], 33_333);
    assert!(!text.contains("calibration-payload-is-not-provenance"));
    assert!(headers.iter().all(|value| value.get("payload").is_none()));
    let provenance: Value =
        serde_json::from_reader(File::open(metadata.join("ceres-export.json")).unwrap()).unwrap();
    assert_eq!(
        provenance["source_events"]["path"],
        "meta/ceres-source-events.jsonl"
    );
    assert_eq!(provenance["source_events"]["payloads"], false);
}

#[test]
fn exports_large_uncompressed_asset_and_preserves_only_its_header() {
    let root = tempfile::tempdir().unwrap();
    let size = 56 * 1024 * 1024;
    let job = fixture_with_asset(root.path(), Some(size));
    let source = File::open(root.path().join("session.mcap")).unwrap();
    let map = unsafe { memmap2::Mmap::map(&source).unwrap() };
    let mut large_chunk = false;
    for record in mcap::read::LinearReader::new(&map).unwrap() {
        if let mcap::records::Record::Chunk { header, .. } = record.unwrap() {
            assert!(header.compression.is_empty());
            large_chunk |= header.uncompressed_size > size as u64;
        }
    }
    assert!(
        large_chunk,
        "fixture did not exceed the ordinary 4 MiB chunk target"
    );
    ceres_native_exporter::run(&job).unwrap();
    let output = root.path().join("dataset");
    let info: Value =
        serde_json::from_reader(File::open(output.join("meta/info.json")).unwrap()).unwrap();
    assert_eq!(info["total_frames"], 7);
    assert_eq!(info["total_episodes"], 2);
    let text = fs::read_to_string(output.join("meta/ceres-source-events.jsonl")).unwrap();
    assert!(
        text.len() < 32 * 1024,
        "asset payload was copied into provenance"
    );
    let headers: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let assets: Vec<_> = headers
        .iter()
        .filter(|header| header["kind"] == "asset")
        .collect();
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0]["stream"], "headset-rig");
    assert_eq!(assets[0]["sequence"], 71);
    assert_eq!(assets[0]["epoch"], 99);
    assert_eq!(assets[0]["attributes"]["payload_bytes"], size);
    assert_eq!(assets[0]["extension"]["preserve"], "large asset");
    assert!(assets[0].get("payload").is_none());
}

fn changing_resolution_fixture(root: &Path, include_dimensions: bool) -> PathBuf {
    changing_resolution_fixture_with_key_interval(root, include_dimensions, 1)
}

fn changing_resolution_fixture_with_key_interval(
    root: &Path,
    include_dimensions: bool,
    key_interval: usize,
) -> PathBuf {
    let ffmpeg = std::env::var("FFMPEG").unwrap_or_else(|_| "ffmpeg".into());
    let session = root.join("changing.mcap");
    let mut writer = mcap::Writer::new(File::create(&session).unwrap()).unwrap();
    let channel = writer
        .add_channel(0, "ceres/events", "ceres-session-v1", &BTreeMap::new())
        .unwrap();
    for (part, width) in [16, 32].into_iter().enumerate() {
        let source = root.join(format!("source-{width}.h264"));
        assert!(
            Command::new(&ffmpeg)
                .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i"])
                .arg(format!("testsrc=size={width}x16:rate=30"))
                .args([
                    "-frames:v",
                    "2",
                    "-c:v",
                    "libx264",
                    "-threads",
                    "2",
                    "-pix_fmt",
                    "yuv420p",
                    "-bf",
                    "0",
                    "-x264-params",
                ])
                .arg(format!("aud=1:keyint={key_interval}:min-keyint={key_interval}:scenecut=0:repeat-headers=1"))
                .args(["-f", "h264"])
                .arg(&source)
                .status()
                .unwrap()
                .success()
        );
        let bytes = fs::read(&source).unwrap();
        let mut starts = Vec::new();
        for i in 0..bytes.len().saturating_sub(5) {
            if bytes[i..].starts_with(&[0, 0, 0, 1]) && bytes[i + 4] & 31 == 9 {
                starts.push(i);
            }
        }
        assert_eq!(starts.len(), 2);
        starts.push(bytes.len());
        let start = part as i64 * 66_666;
        let attributes = if include_dimensions {
            json!({"type":"description","camera":{"width":width,"height":16}})
        } else {
            json!({})
        };
        write_header_event(
            &mut writer,
            channel,
            &json!({"kind":"metadata","session_receive_us":start,"session_time_us":start,"receive_us":1_000_000+start,"time_us":1_000_000+start,"epoch":1,"space_epoch":0,"sequence":0,"attributes":attributes}),
            &[],
        );
        for (frame, bounds) in starts.windows(2).enumerate() {
            let time = start + frame as i64 * 33_333;
            write_header_event(
                &mut writer,
                channel,
                &json!({"version":1,"kind":"video","session_receive_us":time,"session_time_us":time,"receive_us":1_000_000+time,"time_us":1_000_000+time,"epoch":1,"space_epoch":0,"sequence":part * 2 + frame,"keyframe":frame % key_interval == 0,"stream":"video","attributes":{}}),
                &bytes[bounds[0]..bounds[1]],
            );
        }
    }
    write_event(&mut writer, channel, "metadata", 133_333, 1, 0, &[]);
    writer.finish().unwrap();
    drop(writer);
    let job = root.join("job.json");
    fs::write(&job, serde_json::to_vec(&json!({"schema":"ceres-native-export","version":1,"session":"changing.mcap","output":"dataset","fps":30,"ffmpeg":ffmpeg,"episodes":[{"start_us":0,"end_us":133_333,"task":"Inspect camera resolution"}],"video":{"stream":"video","width":16,"height":16}})).unwrap()).unwrap();
    job
}

#[test]
fn encoded_frames_reject_mixed_or_mismatched_selected_resolutions() {
    let root = tempfile::tempdir().unwrap();
    let job = changing_resolution_fixture(root.path(), true);
    let error = ceres_native_exporter::run(&job).unwrap_err().to_string();
    assert!(error.contains("source camera dimensions 32x16"), "{error}");
    assert!(error.contains("select ranges at a single source resolution"));
    assert!(!root.path().join("dataset").exists());
    let mut document: Value = serde_json::from_reader(File::open(&job).unwrap()).unwrap();
    document["episodes"] =
        json!([{"start_us":0,"end_us":60_000,"task":"Inspect the first resolution"}]);
    document["video"]["width"] = json!(32);
    fs::write(&job, serde_json::to_vec(&document).unwrap()).unwrap();
    let error = ceres_native_exporter::run(&job).unwrap_err().to_string();
    assert!(error.contains("selected source image is 16x16"), "{error}");
    assert!(!root.path().join("dataset").exists());
}

#[test]
fn each_source_resolution_exports_separately_with_variable_size_preroll() {
    let root = tempfile::tempdir().unwrap();
    let job = changing_resolution_fixture(root.path(), true);
    let mut document: Value = serde_json::from_reader(File::open(&job).unwrap()).unwrap();
    for (start, end, width) in [(0, 60_000, 16), (66_666, 133_333, 32)] {
        document["episodes"] =
            json!([{"start_us":start,"end_us":end,"task":"Inspect one source resolution"}]);
        document["video"]["width"] = json!(width);
        document["output"] = json!(format!("dataset-{width}"));
        fs::write(&job, serde_json::to_vec(&document).unwrap()).unwrap();
        ceres_native_exporter::run(&job).unwrap();
        let output = root.path().join(format!("dataset-{width}"));
        let info: Value =
            serde_json::from_reader(File::open(output.join("meta/info.json")).unwrap()).unwrap();
        assert_eq!(
            info["features"]["observation.images.passthrough"]["shape"],
            json!([16, width, 3])
        );
        let ffprobe = PathBuf::from(document["ffmpeg"].as_str().unwrap())
            .with_file_name(format!("ffprobe{}", std::env::consts::EXE_SUFFIX));
        let probe = Command::new(ffprobe)
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "json",
            ])
            .arg(output.join("videos/observation.images.passthrough/chunk-000/file-000.mp4"))
            .output()
            .unwrap();
        assert!(probe.status.success());
        let media: Value = serde_json::from_slice(&probe.stdout).unwrap();
        assert_eq!(media["streams"][0]["width"], width);
        assert_eq!(media["streams"][0]["height"], 16);
    }
}

#[test]
fn decoded_dimensions_reject_rescaling_without_camera_metadata() {
    let root = tempfile::tempdir().unwrap();
    let job = fixture(root.path());
    let mut document: Value = serde_json::from_reader(File::open(&job).unwrap()).unwrap();
    document["video"]["width"] = json!(32);
    fs::write(&job, serde_json::to_vec(&document).unwrap()).unwrap();
    let error = ceres_native_exporter::run(&job).unwrap_err().to_string();
    assert!(error.contains("selected source image is 16x16"), "{error}");
    assert!(!root.path().join("dataset").exists());
}

#[test]
fn encoded_resolution_changes_are_rejected_even_without_metadata() {
    let root = tempfile::tempdir().unwrap();
    let job = changing_resolution_fixture(root.path(), false);
    let error = ceres_native_exporter::run(&job).unwrap_err().to_string();
    assert!(error.contains("source camera dimensions 32x16"), "{error}");
    assert!(!root.path().join("dataset").exists());
}

fn rewrite_recording(path: &Path, mut rewrite: impl FnMut(&mut Value) -> bool) {
    let bytes = fs::read(path).unwrap();
    let mut writer = mcap::Writer::new(File::create(path).unwrap()).unwrap();
    let channel = writer
        .add_channel(0, "ceres/events", "ceres-session-v1", &BTreeMap::new())
        .unwrap();
    for message in mcap::MessageStream::new(&bytes).unwrap() {
        let message = message.unwrap();
        let length = u32::from_le_bytes(message.data[4..8].try_into().unwrap()) as usize;
        let mut header: Value = serde_json::from_slice(&message.data[8..8 + length]).unwrap();
        if rewrite(&mut header) {
            write_header_event(&mut writer, channel, &header, &message.data[8 + length..]);
        }
    }
    writer.finish().unwrap();
}

fn read_json(path: &Path) -> Value {
    serde_json::from_reader(File::open(path).unwrap()).unwrap()
}

#[test]
fn source_dimensions_override_stale_capture_metadata_and_preserve_provenance() {
    let root = tempfile::tempdir().unwrap();
    let job = fixture_with_options(root.path(), None, true);
    rewrite_recording(&root.path().join("session.mcap"), |header| {
        if header["kind"] == "metadata" && header["attributes"].get("camera").is_some() {
            header["attributes"]["camera"]["width"] = json!(640);
            header["attributes"]["camera"]["height"] = json!(480);
        }
        true
    });
    let mut document = read_json(&job);
    document["video"]["width"] = json!(640);
    document["video"]["height"] = json!(480);
    document["video"]["source_dimensions"] = json!(true);
    fs::write(&job, serde_json::to_vec(&document).unwrap()).unwrap();
    ceres_native_exporter::run(&job).unwrap();
    let output = root.path().join("dataset");
    let info = read_json(&output.join("meta/info.json"));
    assert_eq!(
        info["features"]["observation.images.passthrough"]["shape"],
        json!([16, 16, 3])
    );
    let provenance = read_json(&output.join("meta/ceres-export.json"));
    assert_eq!(provenance["job"]["video"]["width"], 16);
    assert_eq!(provenance["job"]["video"]["height"], 16);
    assert_eq!(provenance["job"]["video"]["source_dimensions"], true);
    let headers = fs::read_to_string(output.join("meta/ceres-source-events.jsonl")).unwrap();
    let original: Value = headers
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find(|header| header["kind"] == "metadata" && header["attributes"].get("camera").is_some())
        .unwrap();
    assert_eq!(original["attributes"]["camera"]["width"], 640);
    assert_eq!(original["attributes"]["camera"]["height"], 480);
    // An explicit correct size is also valid despite the stale capture metadata.
    document["output"] = json!("explicit-dataset");
    document["video"]["source_dimensions"] = json!(false);
    document["video"]["width"] = json!(16);
    document["video"]["height"] = json!(16);
    fs::write(&job, serde_json::to_vec(&document).unwrap()).unwrap();
    ceres_native_exporter::run(&job).unwrap();
}

#[test]
fn source_dimensions_use_selected_configuration_and_ignore_other_size_preroll() {
    let root = tempfile::tempdir().unwrap();
    let job = changing_resolution_fixture_with_key_interval(root.path(), false, 30);
    let mut document = read_json(&job);
    document["video"]["source_dimensions"] = json!(true);
    document["episodes"] =
        json!([{"start_us":90_000,"end_us":133_333,"task":"Inspect the second size"}]);
    fs::write(&job, serde_json::to_vec(&document).unwrap()).unwrap();
    ceres_native_exporter::run(&job).unwrap();
    let info = read_json(&root.path().join("dataset/meta/info.json"));
    assert_eq!(
        info["features"]["observation.images.passthrough"]["shape"],
        json!([16, 32, 3])
    );
}

#[test]
fn source_dimensions_reject_mixed_sizes_within_ranges_and_across_epochs() {
    for split_epochs in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let job = changing_resolution_fixture(root.path(), false);
        if split_epochs {
            rewrite_recording(&root.path().join("changing.mcap"), |header| {
                if header["session_time_us"].as_i64().unwrap() >= 66_666 {
                    header["epoch"] = json!(2);
                }
                true
            });
        }
        let mut document = read_json(&job);
        document["video"]["source_dimensions"] = json!(true);
        fs::write(&job, serde_json::to_vec(&document).unwrap()).unwrap();
        let error = ceres_native_exporter::run(&job).unwrap_err().to_string();
        assert!(error.contains("source camera dimensions 32x16"), "{error}");
        assert!(
            error.contains("select ranges at a single source resolution"),
            "{error}"
        );
        assert!(!root.path().join("dataset").exists());
    }
}

#[test]
fn source_dimensions_ignore_unselected_stream_and_capture_dimensions() {
    let root = tempfile::tempdir().unwrap();
    let job = changing_resolution_fixture(root.path(), true);
    rewrite_recording(&root.path().join("changing.mcap"), |header| {
        if header["kind"] == "video" && header["session_time_us"].as_i64().unwrap() >= 66_666 {
            header["stream"] = json!("other-camera");
        }
        true
    });
    let mut document = read_json(&job);
    document["video"]["source_dimensions"] = json!(true);
    fs::write(&job, serde_json::to_vec(&document).unwrap()).unwrap();
    ceres_native_exporter::run(&job).unwrap();
    let info = read_json(&root.path().join("dataset/meta/info.json"));
    assert_eq!(
        info["features"]["observation.images.passthrough"]["shape"],
        json!([16, 16, 3])
    );
}

#[test]
fn source_dimensions_retain_black_frame_fallback_without_camera_images() {
    let root = tempfile::tempdir().unwrap();
    let job = fixture_with_options(root.path(), None, true);
    rewrite_recording(&root.path().join("session.mcap"), |header| {
        header["kind"] != "video"
    });
    let mut document = read_json(&job);
    document["video"]["source_dimensions"] = json!(true);
    document["video"]["width"] = json!(32);
    fs::write(&job, serde_json::to_vec(&document).unwrap()).unwrap();
    ceres_native_exporter::run(&job).unwrap();
    let info = read_json(&root.path().join("dataset/meta/info.json"));
    assert_eq!(
        info["features"]["observation.images.passthrough"]["shape"],
        json!([16, 32, 3])
    );
    let batch = ParquetRecordBatchReaderBuilder::try_new(
        File::open(root.path().join("dataset/data/chunk-000/file-000.parquet")).unwrap(),
    )
    .unwrap()
    .build()
    .unwrap()
    .next()
    .unwrap()
    .unwrap();
    let valid = batch
        .column_by_name("observation.video_valid")
        .unwrap()
        .as_any()
        .downcast_ref::<BooleanArray>()
        .unwrap();
    assert!(valid.iter().all(|value| value == Some(false)));
}
