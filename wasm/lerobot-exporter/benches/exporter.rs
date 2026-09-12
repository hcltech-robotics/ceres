use ceres_lerobot_exporter::{
    CERES_ACTION_NAMES, CERES_TELEMETRY_DIM, EpisodeExporter, ExportConfig, TaskConfig,
};
use criterion::{BatchSize, Criterion, black_box, criterion_group, criterion_main};

fn config(reduction_batch_rows: usize) -> ExportConfig {
    ExportConfig {
        fps: 30,
        robot_type: "ceres_xr".to_owned(),
        episode_index: 0,
        global_frame_index: 0,
        task: TaskConfig {
            index: 0,
            text: "benchmark".to_owned(),
        },
        tasks: Vec::new(),
        action_names: CERES_ACTION_NAMES
            .iter()
            .map(|name| (*name).to_owned())
            .collect(),
        row_group_size: 256,
        reduction_batch_rows,
        max_frames: 10_000,
        data_files_size_in_mb: 100,
        video_files_size_in_mb: 500,
    }
}

fn telemetry(frame: u64) -> Vec<f64> {
    let mut values = vec![0.0; CERES_TELEMETRY_DIM];
    values[0] = 1_000_000.0 + frame as f64 * (1_000_000.0 / 30.0);
    values[1] = 1.0;
    for (index, value) in values[2..].iter_mut().enumerate() {
        *value = index as f64 * 0.001;
    }
    values
}

fn exporter_with_frames(rows: usize) -> EpisodeExporter {
    let mut exporter = EpisodeExporter::new(config(rows.max(16))).unwrap();
    for frame in 0..rows as u64 {
        exporter
            .push_ceres_frame(frame, &telemetry(frame), &[0.25, 0.75])
            .unwrap();
    }
    exporter
}

fn sensor_json() -> String {
    serde_json::json!({
        "timestampMs": 1_000.0,
        "frameIndex": 0,
        "head": null,
        "leftHand": {"tracked": false, "joints": {}, "pinch": 0.25},
        "rightHand": {"tracked": false, "joints": {}, "pinch": 0.75},
        "sceneStatus": {"planes": false, "meshes": false, "anchors": false},
    })
    .to_string()
}

fn benchmarks(c: &mut Criterion) {
    let sample = telemetry(0);
    c.bench_function("row_construction_410_state_values", |bench| {
        bench.iter_batched(
            || EpisodeExporter::new(config(16)).unwrap(),
            |mut exporter| {
                exporter
                    .push_ceres_frame(0, black_box(&sample), black_box(&[0.25, 0.75]))
                    .unwrap();
            },
            BatchSize::SmallInput,
        )
    });

    let serialised = sensor_json();
    c.bench_function("sensor_json_row_construction_410_state_values", |bench| {
        bench.iter_batched(
            || EpisodeExporter::new(config(16)).unwrap(),
            |mut exporter| {
                exporter
                    .push_ceres_sensor_frame_json(black_box(&serialised))
                    .unwrap();
            },
            BatchSize::SmallInput,
        )
    });

    c.bench_function("statistics_welford_256x412", |bench| {
        bench.iter_batched(
            || exporter_with_frames(256),
            |mut exporter| exporter.reduce_pending_cpu().unwrap(),
            BatchSize::LargeInput,
        )
    });

    c.bench_function("parquet_episode_256_rows", |bench| {
        bench.iter_batched(
            || exporter_with_frames(256),
            |exporter| {
                let bundle = exporter.finish().unwrap();
                black_box(bundle.artifact_count());
            },
            BatchSize::LargeInput,
        )
    });
}

criterion_group!(benches, benchmarks);
criterion_main!(benches);
