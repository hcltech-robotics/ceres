use arrow_array::{
    ArrayRef, BooleanArray, FixedSizeListArray, Float32Array, Float64Array, Int64Array,
    RecordBatch, StringArray,
};
use arrow_schema::{DataType, Field, Schema};
use parquet::arrow::ArrowWriter;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use parquet::{basic::Compression, file::properties::WriterProperties};
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
};

fn ffmpeg() -> PathBuf {
    std::env::var_os("CERES_FFMPEG")
        .map(PathBuf::from)
        .unwrap_or_else(|| "ffmpeg".into())
}
fn run_ffmpeg(args: &[&str], input: Option<&Path>, output: &Path) {
    let mut command = Command::new(ffmpeg());
    command.args(["-hide_banner", "-loglevel", "error", "-nostdin"]);
    if let Some(input) = input {
        command.arg("-i").arg(input);
    }
    let status = command
        .args(args)
        .arg(output)
        .stdin(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());
}
fn fixed(values: ArrayRef, size: usize) -> ArrayRef {
    Arc::new(
        FixedSizeListArray::try_new(
            Arc::new(Field::new("item", values.data_type().clone(), false)),
            size as i32,
            values,
            None,
        )
        .unwrap(),
    )
}
fn fixture(root: &Path, native: bool) -> (PathBuf, PathBuf) {
    let dataset = root.join("dataset");
    for path in [
        "data/chunk-000",
        "videos/observation.images.passthrough/chunk-000",
        "meta",
    ] {
        fs::create_dir_all(dataset.join(path)).unwrap();
    }
    let video = dataset.join("videos/observation.images.passthrough/chunk-000/file-006.mp4");
    run_ffmpeg(
        &[
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=32x32:rate=30",
            "-frames:v",
            "4",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-bf",
            "2",
        ],
        None,
        &video,
    );
    let info = json!({"codebase_version":"v3.0","fps":30,"features":{"observation.state":{"dtype":"float32","shape":[410],"names":ceres_lerobot_exporter::state_names()},"observation.images.passthrough":{"dtype":"video","shape":[32,32,3]}}});
    fs::write(
        dataset.join("meta/info.json"),
        serde_json::to_vec(&info).unwrap(),
    )
    .unwrap();
    let mut state = vec![0_f32; 4 * 410];
    for frame in 0..4 {
        state[frame * 410] = 1.0;
        state[frame * 410 + 1] = frame as f32 + 1.0;
        state[frame * 410 + 7] = 1.0;
        state[frame * 410 + 8] = 1.0;
        state[frame * 410 + 15] = 1.0;
        state[frame * 410 + 16] = 0.02;
    }
    let mut arrays: Vec<(&str, ArrayRef)> = vec![
        (
            "observation.state",
            fixed(Arc::new(Float32Array::from(state)), 410),
        ),
        (
            "timestamp",
            Arc::new(Float32Array::from(vec![0.0, 1.0 / 30.0, 2.0 / 30.0, 0.1])),
        ),
        ("frame_index", Arc::new(Int64Array::from(vec![0, 1, 2, 3]))),
        ("episode_index", Arc::new(Int64Array::from(vec![6; 4]))),
        (
            "ceres.source_timestamp",
            Arc::new(Float64Array::from(vec![
                1786897432.038984,
                1786897432.077402,
                1786897432.113675,
                1786897432.139005,
            ])),
        ),
        (
            "ceres.source_gap",
            Arc::new(BooleanArray::from(vec![false, true, false, false])),
        ),
    ];
    if native {
        let mut validity = vec![false; 4 * 51];
        for frame in 0..4 {
            validity[frame * 51] = true;
            validity[frame * 51 + 1] = true;
        }
        validity[3 * 51] = false;
        arrays.extend([
            (
                "observation.valid",
                fixed(Arc::new(BooleanArray::from(validity)), 51),
            ),
            (
                "ceres.connection_epoch",
                Arc::new(Int64Array::from(vec![7, 7, 8, 8])) as ArrayRef,
            ),
            (
                "ceres.space_epoch",
                Arc::new(Int64Array::from(vec![4; 4])) as ArrayRef,
            ),
            (
                "ceres.sender_timestamp",
                fixed(
                    Arc::new(Float64Array::from(vec![
                        11.0, 12.0, -1.0, 11.03, 12.03, -1.0, 11.06, 12.06, -1.0, 11.1, 12.1, -1.0,
                    ])),
                    3,
                ),
            ),
            (
                "ceres.sender_target_timestamp",
                fixed(
                    Arc::new(Float64Array::from(vec![
                        11.001, 12.001, -1.0, 11.031, 12.031, -1.0, 11.061, 12.061, -1.0, 11.101,
                        12.101, -1.0,
                    ])),
                    3,
                ),
            ),
            (
                "ceres.sender_sequence",
                fixed(
                    Arc::new(Int64Array::from(vec![
                        41, 42, -1, 43, 44, -1, 45, 46, -1, 47, 48, -1,
                    ])),
                    3,
                ),
            ),
        ]);
    }
    let fields = arrays
        .iter()
        .map(|(name, a)| Field::new(*name, a.data_type().clone(), false))
        .collect::<Vec<_>>();
    assert!(matches!(
        fields[0].data_type(),
        DataType::FixedSizeList(_, 410)
    ));
    let batch = RecordBatch::try_new(
        Arc::new(Schema::new(fields)),
        arrays.into_iter().map(|(_, a)| a).collect(),
    )
    .unwrap();
    let mut writer = ArrowWriter::try_new(
        File::create(dataset.join("data/chunk-000/file-006.parquet")).unwrap(),
        batch.schema(),
        Some(
            WriterProperties::builder()
                .set_compression(Compression::ZSTD(Default::default()))
                .build(),
        ),
    )
    .unwrap();
    writer.write(&batch).unwrap();
    writer.close().unwrap();
    (dataset, video)
}
fn import(root: &Path, dataset: &Path, output: &Path, cancel: Option<&Path>) -> anyhow::Result<()> {
    let job = root.join("import.json");
    fs::write(&job,serde_json::to_vec(&json!({"schema":"ceres-lerobot-replay","version":1,"dataset":dataset,"output":output,"ffmpeg":ffmpeg(),"cancel_file":cancel})).unwrap()).unwrap();
    ceres_native_exporter::replay::run(&job)
}
fn events(path: &Path) -> Vec<(Value, Vec<u8>)> {
    let bytes = fs::read(path).unwrap();
    mcap::MessageStream::new(&bytes)
        .unwrap()
        .map(|message| {
            let data = message.unwrap().data.into_owned();
            assert_eq!(&data[..4], b"CSE1");
            let length = u32::from_le_bytes(data[4..8].try_into().unwrap()) as usize;
            (
                serde_json::from_slice(&data[8..8 + length]).unwrap(),
                data[8 + length..].to_vec(),
            )
        })
        .collect()
}

fn write_batch(path: &Path, batch: &RecordBatch) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut writer =
        ArrowWriter::try_new(File::create(path).unwrap(), batch.schema(), None).unwrap();
    writer.write(batch).unwrap();
    writer.close().unwrap();
}
fn add_task_indices(dataset: &Path, indices: Vec<i64>) {
    let path = dataset.join("data/chunk-000/file-006.parquet");
    let batch = ParquetRecordBatchReaderBuilder::try_new(File::open(&path).unwrap())
        .unwrap()
        .build()
        .unwrap()
        .next()
        .unwrap()
        .unwrap();
    let mut fields = batch
        .schema()
        .fields()
        .iter()
        .map(|field| field.as_ref().clone())
        .collect::<Vec<_>>();
    fields.push(Field::new("task_index", DataType::Int64, false));
    let mut arrays = batch.columns().to_vec();
    arrays.push(Arc::new(Int64Array::from(indices)));
    write_batch(
        &path,
        &RecordBatch::try_new(Arc::new(Schema::new(fields)), arrays).unwrap(),
    );
}
fn task_catalogue(dataset: &Path) {
    let batch = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("task_index", DataType::Int64, false),
            Field::new("__index_level_0__", DataType::Utf8, false),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![42, 7])),
            Arc::new(StringArray::from(vec!["Place cup.", "Seal the box."])),
        ],
    )
    .unwrap();
    write_batch(&dataset.join("meta/tasks.parquet"), &batch);
}
fn episode_catalogue(dataset: &Path, label: &str) {
    use arrow_array::builder::{ListBuilder, StringBuilder};
    let mut tasks = ListBuilder::new(StringBuilder::new());
    tasks.values().append_value(label);
    tasks.append(true);
    let tasks: ArrayRef = Arc::new(tasks.finish());
    let fields = vec![
        Field::new("episode_index", DataType::Int64, false),
        Field::new("tasks", tasks.data_type().clone(), false),
    ];
    let batch = RecordBatch::try_new(
        Arc::new(Schema::new(fields)),
        vec![Arc::new(Int64Array::from(vec![6])), tasks],
    )
    .unwrap();
    write_batch(
        &dataset.join("meta/episodes/chunk-000/file-006.parquet"),
        &batch,
    );
}

#[test]
fn helper_advertises_task_replay_contract() {
    let output = Command::new(env!("CARGO_BIN_EXE_ceres-native-exporter"))
        .arg("--capabilities")
        .output()
        .unwrap();
    assert!(output.status.success());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["replay_task_schema"], "ceres-replay-task");
    assert_eq!(value["replay_task_version"], 1);
}

#[test]
fn task_and_repetition_intervals_follow_retained_slots_and_preserve_text() {
    let root = tempfile::tempdir().unwrap();
    let (dataset, _) = fixture(root.path(), false);
    add_task_indices(&dataset, vec![42, 42, 7, 7]);
    task_catalogue(&dataset);
    let spec = json!({"schema":"ceres-task-specification","version":1,"runTitle":"Task collection","runDescription":"Exact run description.\nSecond line.","cycleCount":5,"tasks":[{"id":"seal","type":"open","label":"Seal the box.","instructions":"Close the flaps.\nApply tape.","repeatCount":1,"resetTimeS":3,"datasetTaskIndex":7},{"id":"cup","type":"open","label":"Place cup.","instructions":"Spec instructions retained unchanged.","repeatCount":4,"resetTimeS":8,"datasetTaskIndex":42}]});
    let segments = json!([
        {"id":"segment-a","taskId":"cup","taskLabel":" Place cup. ","taskDescription":"Exact first instructions.\nKeep this line.","repetition":2,"take":3,"recorderSlotCount":1,"outcome":"completed","startSourceTimestampUs":1000000,"endSourceTimestampUs":1100000,"startedAt":"2026-09-19T10:00:00Z","endedAt":"2026-09-19T10:00:01Z"},
        {"id":"segment-b","taskId":"cup","taskLabel":"Place cup.","taskDescription":"Repeat the placement.","repetition":4,"take":8,"recorderSlotCount":1,"outcome":"completed","startSourceTimestampUs":900000000,"endSourceTimestampUs":910000000},
        {"id":"segment-c","taskId":"seal","taskLabel":"Seal the box.","taskDescription":"Close the flaps.\nApply tape.","repetition":1,"take":1,"recorderSlotCount":2,"outcome":"completed","startSourceTimestampUs":920000000,"endSourceTimestampUs":930000000}
    ]);
    let metadata = json!({"schema":"ceres-episode-export-metadata","version":3,"episodeId":"recorded-episode","episodeIndex":6,"cycle":3,"segments":segments,"taskSpecVersion":1,"taskSpecHash":"preserved-hash","taskSpecificationPath":"ceres/task-specifications/example.json"});
    fs::create_dir_all(dataset.join("ceres/task-specifications")).unwrap();
    fs::write(
        dataset.join("ceres/task-specifications/example.json"),
        serde_json::to_vec(&spec).unwrap(),
    )
    .unwrap();
    fs::write(
        dataset.join("ceres/episode-metadata.json"),
        serde_json::to_vec(&metadata).unwrap(),
    )
    .unwrap();
    let output = root.path().join("replay.mcap");
    import(root.path(), &dataset, &output, None).unwrap();
    let intervals = events(&output)
        .into_iter()
        .filter(|(h, _)| h["kind"] == "episode")
        .map(|(h, _)| h["attributes"].clone())
        .collect::<Vec<_>>();
    assert_eq!(intervals.len(), 3);
    for (index, (start, end)) in [(0, 33333), (33333, 66667), (66667, 133333)]
        .into_iter()
        .enumerate()
    {
        let interval = &intervals[index];
        assert_eq!(interval["schema"], "ceres-replay-task");
        assert_eq!(interval["version"], 1);
        assert_eq!(interval["action"], "stop");
        assert_eq!(interval["start_us"], start);
        assert_eq!(interval["end_us"], end);
        assert_eq!(interval["source_segment"], segments[index]);
        assert_eq!(interval["task_specification"], spec);
        assert_eq!(interval["episode_id"], "recorded-episode");
        assert_eq!(interval["cycle"], 3);
        assert_eq!(
            interval["source_start_us"],
            segments[index]["startSourceTimestampUs"]
        );
        assert_eq!(
            interval["source_end_us"],
            segments[index]["endSourceTimestampUs"]
        );
    }
    assert_eq!(intervals[0]["title"], " Place cup. ");
    assert_eq!(
        intervals[0]["description"],
        "Exact first instructions.\nKeep this line."
    );
    assert_eq!(intervals[0]["task_index"], 42);
    assert_eq!(intervals[0]["specification_task_index"], 1);
    assert_eq!(intervals[0]["repetition"], 2);
    assert_eq!(intervals[1]["repetition"], 4);
    assert_eq!(intervals[1]["take"], 8);
    assert_eq!(intervals[2]["task_index"], 7);
    assert_eq!(intervals[2]["specification_task_index"], 0);
}

#[test]
fn catalogue_task_changes_and_episode_labels_are_imported_without_segments() {
    let root = tempfile::tempdir().unwrap();
    let (dataset, _) = fixture(root.path(), false);
    add_task_indices(&dataset, vec![42, 42, 7, 7]);
    task_catalogue(&dataset);
    episode_catalogue(&dataset, "Episode fallback label");
    let output = root.path().join("catalogue.mcap");
    import(root.path(), &dataset, &output, None).unwrap();
    let intervals = events(&output)
        .into_iter()
        .filter(|(h, _)| h["kind"] == "episode")
        .map(|(h, _)| h["attributes"].clone())
        .collect::<Vec<_>>();
    assert_eq!(intervals.len(), 2);
    assert_eq!(intervals[0]["name"], "Place cup.");
    assert_eq!(intervals[0]["start_us"], 0);
    assert_eq!(intervals[0]["end_us"], 66667);
    assert_eq!(intervals[1]["name"], "Seal the box.");
    assert_eq!(intervals[1]["start_us"], 66667);
    assert_eq!(intervals[1]["end_us"], 133333);
    assert!(intervals[0].get("repetition").is_none());
    let root = tempfile::tempdir().unwrap();
    let (dataset, _) = fixture(root.path(), false);
    episode_catalogue(&dataset, "Episode fallback label");
    let output = root.path().join("episode.mcap");
    import(root.path(), &dataset, &output, None).unwrap();
    assert!(events(&output).iter().any(
        |(h, _)| h["kind"] == "episode" && h["attributes"]["name"] == "Episode fallback label"
    ));
}

#[test]
fn source_ranges_recover_repetitions_when_slot_counts_are_absent() {
    let root = tempfile::tempdir().unwrap();
    let (dataset, _) = fixture(root.path(), false);
    fs::create_dir_all(dataset.join("ceres")).unwrap();
    let metadata = json!({"episodeIndex":6,"segments":[{"id":"first","taskLabel":"Task","repetition":3,"startSourceTimestampUs":1786897432038984_i64,"endSourceTimestampUs":1786897432077402_i64},{"id":"second","taskLabel":"Task","repetition":9,"startSourceTimestampUs":1786897432113675_i64,"endSourceTimestampUs":1786897432139005_i64}]});
    fs::write(
        dataset.join("ceres/episode-metadata.json"),
        serde_json::to_vec(&metadata).unwrap(),
    )
    .unwrap();
    let output = root.path().join("source-ranges.mcap");
    import(root.path(), &dataset, &output, None).unwrap();
    let intervals = events(&output)
        .into_iter()
        .filter(|(h, _)| h["kind"] == "episode")
        .map(|(h, _)| h["attributes"].clone())
        .collect::<Vec<_>>();
    assert_eq!(intervals.len(), 2);
    assert_eq!(intervals[0]["repetition"], 3);
    assert_eq!(intervals[0]["end_us"], 66667);
    assert_eq!(intervals[1]["repetition"], 9);
    assert_eq!(intervals[1]["start_us"], 66667);
}

#[test]
fn inconsistent_task_ranges_and_external_specs_do_not_publish_replay() {
    let root = tempfile::tempdir().unwrap();
    let (dataset, _) = fixture(root.path(), false);
    fs::create_dir_all(dataset.join("ceres")).unwrap();
    let metadata_path = dataset.join("ceres/episode-metadata.json");
    let output = root.path().join("invalid.mcap");
    fs::write(
        &metadata_path,
        serde_json::to_vec(
            &json!({"episodeIndex":6,"segments":[{"taskLabel":"Task","recorderSlotCount":5}]}),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(
        import(root.path(), &dataset, &output, None)
            .unwrap_err()
            .to_string()
            .contains("frame counts")
    );
    assert!(!output.exists());
    fs::write(
        &metadata_path,
        serde_json::to_vec(&json!({"episodeIndex":6,"taskSpecificationPath":"../outside.json"}))
            .unwrap(),
    )
    .unwrap();
    assert!(
        import(root.path(), &dataset, &output, None)
            .unwrap_err()
            .to_string()
            .contains("specification path")
    );
    assert!(!output.exists());
}

#[test]
fn browser_shard_preserves_source_times_gaps_and_decoded_video() {
    let root = tempfile::tempdir().unwrap();
    let (dataset, video) = fixture(root.path(), false);
    let output = root.path().join("replay.mcap");
    import(root.path(), &dataset, &output, None).unwrap();
    let events = events(&output);
    let poses = events
        .iter()
        .filter(|(h, _)| h["kind"] == "pose")
        .collect::<Vec<_>>();
    assert_eq!(poses.len(), 12);
    assert_eq!(poses[0].0["pose_kind"], 1);
    assert_eq!(poses[0].0["epoch"], 1);
    assert_eq!(
        u64::from_le_bytes(poses[0].1[24..32].try_into().unwrap()),
        1_786_897_432_038_984
    );
    assert_eq!(poses[1].1[40..44], 1_u32.to_le_bytes());
    for event in &poses[3..6] {
        assert_eq!(event.1[6], 0);
        assert!(event.1[40..].iter().all(|v| *v == 0));
    }
    let videos = events
        .iter()
        .filter(|(h, _)| h["kind"] == "video")
        .collect::<Vec<_>>();
    assert_eq!(videos.len(), 4);
    assert_eq!(videos[0].0["keyframe"], true);
    assert_eq!(
        videos
            .iter()
            .map(|v| v.0["session_time_us"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![0, 33333, 66667, 100000]
    );
    assert_eq!(events.last().unwrap().0["session_time_us"], 133333);
    let h264 = root.path().join("replay.h264");
    fs::write(
        &h264,
        videos
            .iter()
            .flat_map(|v| v.1.iter().copied())
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let source_rgb = root.path().join("source.rgb");
    let replay_rgb = root.path().join("replay.rgb");
    run_ffmpeg(
        &["-f", "rawvideo", "-pix_fmt", "rgb24"],
        Some(&video),
        &source_rgb,
    );
    run_ffmpeg(
        &["-f", "rawvideo", "-pix_fmt", "rgb24"],
        Some(&h264),
        &replay_rgb,
    );
    assert_eq!(fs::read(source_rgb).unwrap(), fs::read(replay_rgb).unwrap());
}

#[test]
fn native_shard_preserves_sender_identities_and_validity() {
    let root = tempfile::tempdir().unwrap();
    let (dataset, _) = fixture(root.path(), true);
    let output = root.path().join("replay.mcap");
    import(root.path(), &dataset, &output, None).unwrap();
    let events = events(&output);
    let poses = events
        .iter()
        .filter(|(h, _)| h["kind"] == "pose")
        .collect::<Vec<_>>();
    assert_eq!(poses[0].0["epoch"], 7);
    assert_eq!(poses[0].0["space_epoch"], 4);
    assert_eq!(poses[0].0["sequence"], 41);
    assert_eq!(
        u64::from_le_bytes(poses[0].1[24..32].try_into().unwrap()),
        11_000_000
    );
    assert_eq!(
        u64::from_le_bytes(poses[0].1[32..40].try_into().unwrap()),
        11_001_000
    );
    assert_eq!(poses[1].0["sequence"], 42);
    assert_eq!(poses[1].1[40..44], 1_u32.to_le_bytes());
    assert_eq!(poses[2].1[6], 0);
    assert_eq!(poses[6].0["epoch"], 8);
    let videos = events
        .iter()
        .filter(|(h, _)| h["kind"] == "video")
        .collect::<Vec<_>>();
    assert_eq!(videos[2].0["keyframe"], true);
    assert_eq!(videos[0].0["attributes"]["head_sequence"], 41);
    assert!(videos[3].0["attributes"].get("head_pose").is_none());
    let clock = events.iter().find(|(h, _)| h["kind"] == "clock").unwrap();
    assert_eq!(
        clock.0["receive_us"].as_i64().unwrap()
            - clock.0["attributes"]["offset_us"].as_i64().unwrap(),
        11_000_000
    );
}

#[test]
fn episode_continues_across_parquet_and_video_files() {
    let root = tempfile::tempdir().unwrap();
    let (dataset, video) = fixture(root.path(), false);
    let parquet = dataset.join("data/chunk-000/file-006.parquet");
    let batch = ParquetRecordBatchReaderBuilder::try_new(File::open(&parquet).unwrap())
        .unwrap()
        .build()
        .unwrap()
        .next()
        .unwrap()
        .unwrap();
    for (file, offset) in [("file-006.parquet", 0), ("file-007.parquet", 2)] {
        let rows = batch.slice(offset, 2);
        let mut writer = ArrowWriter::try_new(
            File::create(parquet.with_file_name(file)).unwrap(),
            rows.schema(),
            None,
        )
        .unwrap();
        writer.write(&rows).unwrap();
        writer.close().unwrap();
    }
    let original = root.path().join("original.mp4");
    fs::rename(&video, &original).unwrap();
    for (file, filter) in [
        ("file-006.mp4", "select=lt(n\\,2),setpts=PTS-STARTPTS"),
        ("file-007.mp4", "select=gte(n\\,2),setpts=PTS-STARTPTS"),
    ] {
        run_ffmpeg(
            &[
                "-vf",
                filter,
                "-c:v",
                "libx264",
                "-qp",
                "0",
                "-fps_mode",
                "passthrough",
            ],
            Some(&original),
            &video.with_file_name(file),
        );
    }
    let output = root.path().join("replay.mcap");
    import(root.path(), &dataset, &output, None).unwrap();
    let events = events(&output);
    let videos = events
        .iter()
        .filter(|(h, _)| h["kind"] == "video")
        .collect::<Vec<_>>();
    assert_eq!(
        videos
            .iter()
            .map(|v| v.0["session_time_us"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![0, 33333, 66667, 100000]
    );
    assert_eq!(
        events
            .iter()
            .filter(|(h, _)| h["kind"] == "episode")
            .count(),
        1
    );
    assert_eq!(events.last().unwrap().0["session_time_us"], 133333);
}

#[test]
fn cancelled_or_incomplete_import_does_not_publish_a_session() {
    let root = tempfile::tempdir().unwrap();
    let (dataset, video) = fixture(root.path(), false);
    let output = root.path().join("replay.mcap");
    let cancel = root.path().join("cancel");
    fs::write(&cancel, b"cancel").unwrap();
    assert!(
        import(root.path(), &dataset, &output, Some(&cancel))
            .unwrap_err()
            .to_string()
            .contains("cancelled")
    );
    assert!(!output.exists());
    fs::remove_file(video).unwrap();
    assert!(
        import(root.path(), &dataset, &output, None)
            .unwrap_err()
            .to_string()
            .contains("missing")
    );
    assert!(!output.exists());
    assert!(!fs::read_dir(root.path()).unwrap().any(|p| {
        p.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".ceres-replay-")
    }));
}
