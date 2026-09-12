use arrow_array::{
    BooleanArray, FixedSizeListArray, Float32Array, Int64Array, ListArray, StringArray,
};
use bytes::Bytes;
use ceres_lerobot_exporter::{
    CERES_ACTION_NAMES, CERES_STATE_DIM, CERES_TELEMETRY_DIM, EpisodeExporter, ExportConfig,
    LEROBOT_ORACLE_COMMIT, TaskConfig, VideoMetadata,
};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use serde::Deserialize;

#[derive(Deserialize)]
struct GoldenFixture {
    profile: String,
    oracle_commit: String,
    expected_artifacts: Vec<String>,
    row_count: usize,
    frame_indices: Vec<i64>,
    global_indices: Vec<i64>,
    episode_index: i64,
    task_index: i64,
    timestamps: Vec<f32>,
    first_state_mean: f64,
    action_mean: Vec<f64>,
    action_std: Vec<f64>,
}

fn config() -> ExportConfig {
    ExportConfig {
        fps: 10,
        robot_type: "ceres_xr".to_owned(),
        episode_index: 2,
        global_frame_index: 10,
        task: TaskConfig {
            index: 1,
            text: "place the sample".to_owned(),
        },
        tasks: vec![
            TaskConfig {
                index: 0,
                text: "pick the sample".to_owned(),
            },
            TaskConfig {
                index: 1,
                text: "place the sample".to_owned(),
            },
        ],
        action_names: vec!["left.pinch".to_owned(), "right.pinch".to_owned()],
        row_group_size: 16,
        reduction_batch_rows: 16,
        max_frames: 100,
        data_files_size_in_mb: 100,
        video_files_size_in_mb: 500,
    }
}

fn telemetry(frame: usize) -> Vec<f64> {
    let mut values = vec![0.0; CERES_TELEMETRY_DIM];
    values[0] = 1_000_000.0 + frame as f64 * 100_000.0;
    for (index, value) in values[1..].iter_mut().enumerate() {
        *value = frame as f64 + (index + 1) as f64 / 1_000.0;
    }
    values
}

fn read_single_batch(bytes: &[u8]) -> arrow_array::RecordBatch {
    let mut reader = ParquetRecordBatchReaderBuilder::try_new(Bytes::copy_from_slice(bytes))
        .unwrap()
        .with_batch_size(1_024)
        .build()
        .unwrap();
    let batch = reader.next().unwrap().unwrap();
    assert!(reader.next().is_none());
    batch
}

#[test]
fn golden_fixture_matches_parquet_and_metadata_semantics() {
    let fixture: GoldenFixture =
        serde_json::from_str(include_str!("../fixtures/golden_semantics.json")).unwrap();
    assert_eq!(fixture.profile, "LeRobotDataset v3.0");
    assert_eq!(fixture.oracle_commit, LEROBOT_ORACLE_COMMIT);

    let mut exporter = EpisodeExporter::new(config()).unwrap();
    for frame in 0..fixture.row_count {
        exporter
            .push_ceres_frame(
                100 + frame as u64,
                &telemetry(frame),
                &[0.25 + frame as f32, 0.75 + frame as f32],
            )
            .unwrap();
    }
    exporter
        .attach_video(
            "observation.images.monitor",
            VideoMetadata {
                width: 640,
                height: 480,
                channels: 3,
                fps: 10.0,
                frame_count: 3,
                duration_s: 0.3,
                codec: "avc1".to_owned(),
                pixel_format: "yuv420p".to_owned(),
                has_audio: false,
                is_depth_map: false,
                backend: "webcodecs".to_owned(),
            },
            vec![0, 0, 0, 24, b'f', b't', b'y', b'p'],
        )
        .unwrap();
    let bundle = exporter.finish().unwrap();

    let actual_paths = (0..bundle.artifact_count())
        .map(|index| bundle.artifact_path(index).unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(actual_paths, fixture.expected_artifacts);

    let data = bundle.find("data/chunk-000/file-002.parquet").unwrap();
    assert_eq!(&data[..4], b"PAR1");
    assert_eq!(&data[data.len() - 4..], b"PAR1");
    let batch = read_single_batch(data);
    assert_eq!(batch.num_rows(), fixture.row_count);
    assert_eq!(batch.num_columns(), 10);

    let frame_indices = batch
        .column_by_name("frame_index")
        .unwrap()
        .as_any()
        .downcast_ref::<Int64Array>()
        .unwrap();
    assert_eq!(frame_indices.values(), fixture.frame_indices.as_slice());
    let global_indices = batch
        .column_by_name("index")
        .unwrap()
        .as_any()
        .downcast_ref::<Int64Array>()
        .unwrap();
    assert_eq!(global_indices.values(), fixture.global_indices.as_slice());
    let episode_indices = batch
        .column_by_name("episode_index")
        .unwrap()
        .as_any()
        .downcast_ref::<Int64Array>()
        .unwrap();
    assert!(
        episode_indices
            .values()
            .iter()
            .all(|value| *value == fixture.episode_index)
    );
    let task_indices = batch
        .column_by_name("task_index")
        .unwrap()
        .as_any()
        .downcast_ref::<Int64Array>()
        .unwrap();
    assert!(
        task_indices
            .values()
            .iter()
            .all(|value| *value == fixture.task_index)
    );
    let timestamps = batch
        .column_by_name("timestamp")
        .unwrap()
        .as_any()
        .downcast_ref::<Float32Array>()
        .unwrap();
    assert_eq!(timestamps.values(), fixture.timestamps.as_slice());
    let source_gaps = batch
        .column_by_name("ceres.source_gap")
        .unwrap()
        .as_any()
        .downcast_ref::<BooleanArray>()
        .unwrap();
    assert!((0..source_gaps.len()).all(|index| !source_gaps.value(index)));

    let states = batch
        .column_by_name("observation.state")
        .unwrap()
        .as_any()
        .downcast_ref::<FixedSizeListArray>()
        .unwrap();
    assert_eq!(states.value_length(), CERES_STATE_DIM as i32);
    let first_state = states
        .value(0)
        .as_any()
        .downcast_ref::<Float32Array>()
        .unwrap()
        .value(0);
    assert!((first_state - 0.001).abs() < 1e-7);

    let info: serde_json::Value =
        serde_json::from_slice(bundle.find("meta/info.json").unwrap()).unwrap();
    assert_eq!(info["codebase_version"], "v3.0");
    assert_eq!(info["total_episodes"], 3);
    assert_eq!(info["total_frames"], 13);
    assert_eq!(
        info["features"]["observation.state"]["shape"][0],
        CERES_STATE_DIM
    );
    assert_eq!(
        info["features"]["observation.images.monitor"]["info"]["video.codec"],
        "avc1"
    );
    assert_eq!(info["features"]["ceres.source_gap"]["dtype"], "bool");

    let stats: serde_json::Value =
        serde_json::from_slice(bundle.find("meta/stats.json").unwrap()).unwrap();
    let first_state_mean = stats["observation.state"]["mean"][0].as_f64().unwrap();
    assert!((first_state_mean - fixture.first_state_mean).abs() < 1e-6);
    for dimension in 0..2 {
        let mean = stats["action"]["mean"][dimension].as_f64().unwrap();
        let std = stats["action"]["std"][dimension].as_f64().unwrap();
        assert!((mean - fixture.action_mean[dimension]).abs() < 1e-6);
        assert!((std - fixture.action_std[dimension]).abs() < 1e-6);
    }
    assert_eq!(stats["ceres.source_gap"]["mean"][0], 0.0);

    let task_bytes = bundle.find("meta/tasks.parquet").unwrap();
    let task_reader =
        ParquetRecordBatchReaderBuilder::try_new(Bytes::copy_from_slice(task_bytes)).unwrap();
    assert!(
        task_reader
            .metadata()
            .file_metadata()
            .key_value_metadata()
            .unwrap()
            .iter()
            .any(|entry| entry.key == "pandas")
    );
    let tasks = read_single_batch(task_bytes);
    assert_eq!(tasks.num_rows(), 2);
    let episodes = read_single_batch(
        bundle
            .find("meta/episodes/chunk-000/file-002.parquet")
            .unwrap(),
    );
    assert_eq!(episodes.num_rows(), 1);
    assert!(episodes.column_by_name("dataset_from_index").is_some());
    assert!(
        episodes
            .column_by_name("videos/observation.images.monitor/to_timestamp")
            .is_some()
    );
}

#[test]
fn one_episode_can_assign_different_tasks_to_its_frames() {
    let mut exporter = EpisodeExporter::new(config()).unwrap();
    exporter
        .push_ceres_frame_for_task(100, &telemetry(0), &[0.25, 0.75], 0)
        .unwrap();
    exporter
        .push_ceres_frame_for_task(101, &telemetry(1), &[1.25, 1.75], 1)
        .unwrap();
    let bundle = exporter.finish().unwrap();
    let batch = read_single_batch(bundle.find("data/chunk-000/file-002.parquet").unwrap());
    let task_indices = batch
        .column_by_name("task_index")
        .unwrap()
        .as_any()
        .downcast_ref::<Int64Array>()
        .unwrap();
    assert_eq!(task_indices.values(), &[0, 1]);

    let episodes = read_single_batch(
        bundle
            .find("meta/episodes/chunk-000/file-002.parquet")
            .unwrap(),
    );
    let episode_tasks = episodes
        .column_by_name("tasks")
        .unwrap()
        .as_any()
        .downcast_ref::<ListArray>()
        .unwrap();
    let episode_task_list = episode_tasks.value(0);
    let episode_task_values = episode_task_list
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap()
        .iter()
        .map(|value| value.unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(episode_task_values, ["pick the sample", "place the sample"]);
}

#[test]
fn bounded_reduction_queue_requires_an_explicit_drain() {
    let mut exporter = EpisodeExporter::new(config()).unwrap();
    for frame in 0..16 {
        exporter
            .push_ceres_frame(frame, &telemetry(frame as usize), &[0.0, 0.0])
            .unwrap();
    }
    assert!(exporter.reduction_ready());
    let error = exporter
        .push_ceres_frame(16, &telemetry(16), &[0.0, 0.0])
        .unwrap_err();
    assert!(error.to_string().contains("reduction queue is full"));
    exporter.reduce_pending_cpu().unwrap();
    exporter
        .push_ceres_frame(16, &telemetry(16), &[0.0, 0.0])
        .unwrap();
}

#[test]
fn explicit_gap_rows_preserve_the_timeline_without_inferred_segment_gaps() {
    let mut sensor_config = config();
    sensor_config.action_names = CERES_ACTION_NAMES
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    let mut exporter = EpisodeExporter::new(sensor_config).unwrap();
    exporter
        .push_ceres_sensor_frame_json(
            r#"{
                "timestampMs": 1000,
                "frameIndex": 100,
                "gap": false,
                "head": null,
                "leftHand": {"tracked":false,"pinch":0,"joints":{}},
                "rightHand": {"tracked":false,"pinch":0,"joints":{}}
            }"#,
        )
        .unwrap();
    exporter
        .push_ceres_sensor_frame_json(
            r#"{
                "timestampMs": 1100,
                "frameIndex": 900,
                "gap": true,
                "head": {"position":{"x":1,"y":2,"z":3},"rotation":{"x":0,"y":0,"z":0,"w":1}},
                "leftHand": {"tracked":true,"pinch":0.8,"joints":{}},
                "rightHand": {"tracked":true,"pinch":0.9,"joints":{}}
            }"#,
        )
        .unwrap();
    exporter
        .push_ceres_sensor_frame_json(
            r#"{
                "timestampMs": 1200,
                "frameIndex": 901,
                "gap": false,
                "head": null,
                "leftHand": {"tracked":false,"pinch":0,"joints":{}},
                "rightHand": {"tracked":false,"pinch":0,"joints":{}}
            }"#,
        )
        .unwrap();

    assert_eq!(exporter.metrics().source_frame_gaps, 1);
    let bundle = exporter.finish().unwrap();
    let batch = read_single_batch(bundle.find("data/chunk-000/file-002.parquet").unwrap());

    let source_frames = batch
        .column_by_name("ceres.source_frame_index")
        .unwrap()
        .as_any()
        .downcast_ref::<Int64Array>()
        .unwrap();
    assert_eq!(source_frames.values(), &[100, 900, 901]);
    let source_gaps = batch
        .column_by_name("ceres.source_gap")
        .unwrap()
        .as_any()
        .downcast_ref::<BooleanArray>()
        .unwrap();
    assert_eq!(
        (0..source_gaps.len())
            .map(|index| source_gaps.value(index))
            .collect::<Vec<_>>(),
        [false, true, false]
    );
    let states = batch
        .column_by_name("observation.state")
        .unwrap()
        .as_any()
        .downcast_ref::<FixedSizeListArray>()
        .unwrap();
    let gap_state_value = states.value(1);
    let gap_state = gap_state_value
        .as_any()
        .downcast_ref::<Float32Array>()
        .unwrap();
    assert!(gap_state.values().iter().all(|value| *value == 0.0));
    let actions = batch
        .column_by_name("action")
        .unwrap()
        .as_any()
        .downcast_ref::<FixedSizeListArray>()
        .unwrap();
    let gap_action_value = actions.value(1);
    let gap_action = gap_action_value
        .as_any()
        .downcast_ref::<Float32Array>()
        .unwrap();
    assert_eq!(gap_action.values(), &[0.0, 0.0]);

    let metrics: serde_json::Value =
        serde_json::from_slice(bundle.find("ceres/metrics.json").unwrap()).unwrap();
    assert_eq!(metrics["source_frame_gaps"], 1);
    let stats: serde_json::Value =
        serde_json::from_slice(bundle.find("meta/stats.json").unwrap()).unwrap();
    assert!((stats["ceres.source_gap"]["mean"][0].as_f64().unwrap() - 1.0 / 3.0).abs() < 1e-12);
}

#[test]
fn legacy_rows_still_infer_omitted_source_frames() {
    let mut exporter = EpisodeExporter::new(config()).unwrap();
    exporter
        .push_ceres_frame(100, &telemetry(0), &[0.0, 0.0])
        .unwrap();
    exporter
        .push_ceres_frame(103, &telemetry(1), &[0.0, 0.0])
        .unwrap();
    assert_eq!(exporter.metrics().source_frame_gaps, 2);
}
