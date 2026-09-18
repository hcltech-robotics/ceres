use crate::{
    ExportJob, STATE_DIM, VALID_DIM, nearest, progress,
    session::{self, Segment, SessionIndex},
    video::{Decoder, Encoder},
};
use anyhow::Result;
use arrow_array::{
    ArrayRef, BooleanArray, FixedSizeListArray, Float32Array, Float64Array, Int64Array,
    RecordBatch, StringArray,
    builder::{Float64Builder, Int64Builder, ListBuilder, StringBuilder},
};
use arrow_schema::{DataType, Field, Schema};
use parquet::{
    arrow::ArrowWriter,
    basic::Compression,
    file::{metadata::KeyValue, properties::WriterProperties},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File},
    path::Path,
    sync::Arc,
};

const ROW_GROUP: usize = 512;
#[derive(Clone, Default)]
struct Moment {
    count: u64,
    mean: f64,
    m2: f64,
    min: f64,
    max: f64,
}
impl Moment {
    fn add(&mut self, value: f64) {
        if self.count == 0 {
            self.min = value;
            self.max = value;
        }
        self.count += 1;
        let delta = value - self.mean;
        self.mean += delta / self.count as f64;
        self.m2 += delta * (value - self.mean);
        self.min = self.min.min(value);
        self.max = self.max.max(value);
    }
    fn merge(&mut self, other: &Self) {
        if other.count == 0 {
            return;
        }
        if self.count == 0 {
            *self = other.clone();
            return;
        }
        let total = self.count + other.count;
        let delta = other.mean - self.mean;
        self.m2 += other.m2 + delta * delta * self.count as f64 * other.count as f64 / total as f64;
        self.mean += delta * other.count as f64 / total as f64;
        self.count = total;
        self.min = self.min.min(other.min);
        self.max = self.max.max(other.max);
    }
}
#[derive(Clone)]
struct FeatureStats {
    dimensions: Vec<Moment>,
    rows: u64,
    image: bool,
}
impl FeatureStats {
    fn new(dimensions: usize, image: bool) -> Self {
        Self {
            dimensions: vec![Moment::default(); dimensions],
            rows: 0,
            image,
        }
    }
    fn add(&mut self, values: impl IntoIterator<Item = f64>) {
        for (stat, value) in self.dimensions.iter_mut().zip(values) {
            stat.add(value);
        }
        self.rows += 1;
    }
    fn add_image(&mut self, rgb: &[u8]) {
        for pixel in rgb.chunks_exact(3) {
            for (stat, &value) in self.dimensions.iter_mut().zip(pixel) {
                stat.add(f64::from(value) / 255.0);
            }
        }
        self.rows += 1;
    }
    fn values(&self, kind: &str) -> Vec<f64> {
        self.dimensions
            .iter()
            .map(|s| match kind {
                "min" => s.min,
                "max" => s.max,
                "mean" => s.mean,
                _ => (s.m2 / s.count.max(1) as f64).max(0.0).sqrt(),
            })
            .collect()
    }
    fn document(&self) -> Value {
        let mut out = serde_json::Map::new();
        for kind in ["min", "max", "mean", "std"] {
            let values = self.values(kind);
            out.insert(
                kind.into(),
                if self.image {
                    json!(values.iter().map(|v| vec![vec![*v]]).collect::<Vec<_>>())
                } else {
                    json!(values)
                },
            );
        }
        out.insert("count".into(), json!([self.rows]));
        Value::Object(out)
    }
}
type Stats = BTreeMap<String, FeatureStats>;
fn stats_new(key: &str) -> Stats {
    let mut result = BTreeMap::new();
    for (key, dim) in [
        ("observation.state", STATE_DIM),
        ("observation.valid", VALID_DIM),
        ("observation.video_valid", 1),
        ("timestamp", 1),
        ("frame_index", 1),
        ("episode_index", 1),
        ("index", 1),
        ("task_index", 1),
        ("ceres.source_timestamp", 3),
        ("ceres.video_timestamp", 1),
        ("ceres.connection_epoch", 1),
        ("ceres.space_epoch", 1),
    ] {
        result.insert(key.into(), FeatureStats::new(dim, false));
    }
    result.insert(key.into(), FeatureStats::new(3, true));
    result
}
fn merge_stats(total: &mut Stats, episode: &Stats) {
    for (key, value) in episode {
        let target = total.get_mut(key).unwrap();
        target.rows += value.rows;
        for (a, b) in target.dimensions.iter_mut().zip(&value.dimensions) {
            a.merge(b);
        }
    }
}
struct Row {
    state: [f32; STATE_DIM],
    valid: [bool; VALID_DIM],
    video_valid: bool,
    timestamp: f32,
    frame: i64,
    episode: i64,
    global: i64,
    task: i64,
    source: [f64; 3],
    video_time: f64,
    epoch: i64,
    space: i64,
}
fn add_stats(stats: &mut Stats, row: &Row, key: &str, rgb: &[u8]) {
    stats
        .get_mut("observation.state")
        .unwrap()
        .add(row.state.iter().map(|&v| f64::from(v)));
    stats
        .get_mut("observation.valid")
        .unwrap()
        .add(row.valid.iter().map(|&v| f64::from(u8::from(v))));
    stats
        .get_mut("ceres.source_timestamp")
        .unwrap()
        .add(row.source);
    for (key, value) in [
        (
            "observation.video_valid",
            f64::from(u8::from(row.video_valid)),
        ),
        ("timestamp", f64::from(row.timestamp)),
        ("frame_index", row.frame as f64),
        ("episode_index", row.episode as f64),
        ("index", row.global as f64),
        ("task_index", row.task as f64),
        ("ceres.video_timestamp", row.video_time),
        ("ceres.connection_epoch", row.epoch as f64),
        ("ceres.space_epoch", row.space as f64),
    ] {
        stats.get_mut(key).unwrap().add([value]);
    }
    stats.get_mut(key).unwrap().add_image(rgb);
}
fn fixed(values: ArrayRef, dim: usize) -> ArrayRef {
    Arc::new(FixedSizeListArray::new(
        Arc::new(Field::new("item", values.data_type().clone(), false)),
        dim as i32,
        values,
        None,
    ))
}
fn rows_batch(rows: &[Row]) -> Result<RecordBatch> {
    let arrays: Vec<(&str, ArrayRef)> = vec![
        (
            "observation.state",
            fixed(
                Arc::new(Float32Array::from(
                    rows.iter().flat_map(|r| r.state).collect::<Vec<_>>(),
                )),
                STATE_DIM,
            ),
        ),
        (
            "observation.valid",
            fixed(
                Arc::new(BooleanArray::from(
                    rows.iter().flat_map(|r| r.valid).collect::<Vec<_>>(),
                )),
                VALID_DIM,
            ),
        ),
        (
            "observation.video_valid",
            Arc::new(BooleanArray::from(
                rows.iter().map(|r| r.video_valid).collect::<Vec<_>>(),
            )),
        ),
        (
            "timestamp",
            Arc::new(Float32Array::from(
                rows.iter().map(|r| r.timestamp).collect::<Vec<_>>(),
            )),
        ),
        (
            "frame_index",
            Arc::new(Int64Array::from(
                rows.iter().map(|r| r.frame).collect::<Vec<_>>(),
            )),
        ),
        (
            "episode_index",
            Arc::new(Int64Array::from(
                rows.iter().map(|r| r.episode).collect::<Vec<_>>(),
            )),
        ),
        (
            "index",
            Arc::new(Int64Array::from(
                rows.iter().map(|r| r.global).collect::<Vec<_>>(),
            )),
        ),
        (
            "task_index",
            Arc::new(Int64Array::from(
                rows.iter().map(|r| r.task).collect::<Vec<_>>(),
            )),
        ),
        (
            "ceres.source_timestamp",
            fixed(
                Arc::new(Float64Array::from(
                    rows.iter().flat_map(|r| r.source).collect::<Vec<_>>(),
                )),
                3,
            ),
        ),
        (
            "ceres.video_timestamp",
            Arc::new(Float64Array::from(
                rows.iter().map(|r| r.video_time).collect::<Vec<_>>(),
            )),
        ),
        (
            "ceres.connection_epoch",
            Arc::new(Int64Array::from(
                rows.iter().map(|r| r.epoch).collect::<Vec<_>>(),
            )),
        ),
        (
            "ceres.space_epoch",
            Arc::new(Int64Array::from(
                rows.iter().map(|r| r.space).collect::<Vec<_>>(),
            )),
        ),
    ];
    let fields = arrays
        .iter()
        .map(|(name, array)| Field::new(*name, array.data_type().clone(), false))
        .collect::<Vec<_>>();
    Ok(RecordBatch::try_new(
        Arc::new(Schema::new(fields)),
        arrays.into_iter().map(|(_, a)| a).collect(),
    )?)
}
fn properties() -> WriterProperties {
    WriterProperties::builder()
        .set_compression(Compression::SNAPPY)
        .set_max_row_group_row_count(Some(ROW_GROUP))
        .build()
}
fn write_batch(path: &Path, batch: RecordBatch) -> Result<()> {
    let mut writer = ArrowWriter::try_new(File::create(path)?, batch.schema(), Some(properties()))?;
    writer.write(&batch)?;
    writer.close()?;
    Ok(())
}
fn path_for(
    root: &Path,
    prefix: &str,
    episode: usize,
    extension: &str,
) -> Result<std::path::PathBuf> {
    let path = root.join(format!(
        "{prefix}/chunk-{:03}/file-{:03}.{extension}",
        episode / 1000,
        episode % 1000
    ));
    fs::create_dir_all(path.parent().unwrap())?;
    Ok(path)
}

pub fn export(
    job: &ExportJob,
    index: &SessionIndex,
    episodes: &[Segment],
    root: &Path,
    spool: &Path,
) -> Result<()> {
    let mut tasks = Vec::<String>::new();
    let mut total_stats = stats_new(&job.video.key);
    let mut global = 0_i64;
    for (number, segment) in episodes.iter().enumerate() {
        job.check_cancelled()?;
        progress("exporting", number as u64, episodes.len() as u64);
        let epoch = &index.epochs[segment.epoch_index];
        let task = match tasks.iter().position(|task| task == &segment.task) {
            Some(i) => i,
            None => {
                tasks.push(segment.task.clone());
                tasks.len() - 1
            }
        } as i64;
        let frames = ((i128::from(segment.end_us - segment.start_us) * i128::from(job.fps)
            + 999_999)
            / 1_000_000) as i64;
        let mut cursors = [0; 3];
        let pose_bounds: [(usize, usize); 3] = std::array::from_fn(|part| {
            let times = &epoch.poses[part].times;
            (
                times.partition_point(|&t| t < segment.start_us),
                times.partition_point(|&t| t < segment.end_us),
            )
        });
        let video_begin = epoch.video_times.partition_point(|&t| t < segment.start_us);
        let video_end = epoch.video_times.partition_point(|&t| t < segment.end_us);
        let mut video_cursor = 0;
        let mut pose_files = [
            File::open(&epoch.poses[0].path)?,
            File::open(&epoch.poses[1].path)?,
            File::open(&epoch.poses[2].path)?,
        ];
        let mut decoder = if epoch.video_times.is_empty() {
            None
        } else {
            Some(Decoder::new(
                job,
                &epoch.video_path,
                &spool.join(format!("decode-{number}.log")),
            )?)
        };
        let video_path = path_for(root, &format!("videos/{}", job.video.key), number, "mp4")?;
        let mut encoder = Encoder::new(
            job,
            &video_path,
            &spool.join(format!("encode-{number}.log")),
        )?;
        let mut pixels = vec![0; (job.video.width as usize) * (job.video.height as usize) * 3];
        let mut rows = Vec::with_capacity(ROW_GROUP);
        let empty = rows_batch(&[])?;
        let data_path = path_for(root, "data", number, "parquet")?;
        let mut writer =
            ArrowWriter::try_new(File::create(data_path)?, empty.schema(), Some(properties()))?;
        let mut stats = stats_new(&job.video.key);
        let from = global;
        for frame in 0..frames {
            job.check_cancelled()?;
            let slot =
                i128::from(segment.start_us) * i128::from(job.fps) + i128::from(frame) * 1_000_000;
            let mut row = Row {
                state: [0.0; STATE_DIM],
                valid: [false; VALID_DIM],
                video_valid: false,
                timestamp: frame as f32 / job.fps as f32,
                frame,
                episode: number as i64,
                global,
                task,
                source: [-1.0; 3],
                video_time: -1.0,
                epoch: epoch.epoch as i64,
                space: epoch.space_epoch as i64,
            };
            for part in 0..3 {
                if let Some(sample) = nearest(
                    &epoch.poses[part].times[pose_bounds[part].0..pose_bounds[part].1],
                    &mut cursors[part],
                    slot,
                    job.fps,
                ) {
                    let sample = sample + pose_bounds[part].0;
                    row.source[part] = session::read_pose(
                        &mut pose_files[part],
                        epoch.poses[part].offsets[sample],
                        &mut row.state,
                        &mut row.valid,
                    )?;
                }
            }
            pixels.fill(0);
            if let Some(sample) = nearest(
                &epoch.video_times[video_begin..video_end],
                &mut video_cursor,
                slot,
                job.fps,
            ) {
                let sample = sample + video_begin;
                let time = epoch.video_times[sample];
                decoder.as_mut().unwrap().read_frame(sample, &mut pixels)?;
                row.video_valid = true;
                row.video_time = time as f64 / 1_000_000.0;
            }
            encoder.write_frame(&pixels)?;
            add_stats(&mut stats, &row, &job.video.key, &pixels);
            rows.push(row);
            global += 1;
            if rows.len() == ROW_GROUP {
                writer.write(&rows_batch(&rows)?)?;
                rows.clear();
                progress("frames", frame as u64 + 1, frames as u64);
            }
        }
        if !rows.is_empty() {
            writer.write(&rows_batch(&rows)?)?;
        }
        writer.close()?;
        encoder.finish()?;
        episode_metadata(job, root, number, segment, frames, from, &stats)?;
        merge_stats(&mut total_stats, &stats);
    }
    fs::create_dir_all(root.join("meta"))?;
    write_tasks(root, &tasks)?;
    fs::write(
        root.join("meta/info.json"),
        serde_json::to_vec_pretty(&info(job, global, episodes.len(), tasks.len()))?,
    )?;
    let stats: BTreeMap<_, _> = total_stats
        .iter()
        .map(|(key, value)| (key, value.document()))
        .collect();
    fs::write(
        root.join("meta/stats.json"),
        serde_json::to_vec_pretty(&stats)?,
    )?;
    fs::write(
        root.join("meta/ceres-export.json"),
        serde_json::to_vec_pretty(
            &json!({"schema":"ceres-native-export-provenance","version":1,"exporter_version":env!("CARGO_PKG_VERSION"),"lerobot_oracle":"0.6.1","session":job.session,"job":job,"source_events":{"path":"meta/ceres-source-events.jsonl","format":"jsonl","coverage":"all recorded Ceres event headers","payloads":false},"resampling":"nearest unused within half a slot, earlier sample on ties","pose_time":"receiver-mapped observed time, arrival time when clock mapping is unavailable","video_time":"receiver-anchored RTP presentation time","invalid_observation":"zero with validity false","invalid_video":"black with video_valid false"}),
        )?,
    )?;
    Ok(())
}

fn info(job: &ExportJob, frames: i64, episodes: usize, tasks: usize) -> Value {
    let mut features = serde_json::Map::new();
    features.insert("observation.state".into(),json!({"dtype":"float32","shape":[STATE_DIM],"names":ceres_lerobot_exporter::state_names()}));
    let mut names = vec!["head".to_owned()];
    for hand in ["left_hand", "right_hand"] {
        names.extend(
            ceres_lerobot_exporter::XR_HAND_JOINTS
                .iter()
                .map(|joint| format!("{hand}.{joint}")),
        );
    }
    features.insert(
        "observation.valid".into(),
        json!({"dtype":"bool","shape":[VALID_DIM],"names":names}),
    );
    features.insert(
        "ceres.source_timestamp".into(),
        json!({"dtype":"float64","shape":[3],"names":["head","left_hand","right_hand"]}),
    );
    for (name, dtype) in [
        ("observation.video_valid", "bool"),
        ("timestamp", "float32"),
        ("frame_index", "int64"),
        ("episode_index", "int64"),
        ("index", "int64"),
        ("task_index", "int64"),
        ("ceres.video_timestamp", "float64"),
        ("ceres.connection_epoch", "int64"),
        ("ceres.space_epoch", "int64"),
    ] {
        features.insert(name.into(), json!({"dtype":dtype,"shape":[1],"names":null}));
    }
    features.insert(job.video.key.clone(),json!({"dtype":"video","shape":[job.video.height,job.video.width,3],"names":["height","width","channels"],"info":{"video.height":job.video.height,"video.width":job.video.width,"video.codec":"h264","video.pix_fmt":"yuv420p","video.is_depth_map":false,"video.fps":job.fps,"video.channels":3,"has_audio":false}}));
    json!({"codebase_version":"v3.0","robot_type":"ceres_observation","fps":job.fps,"features":features,"total_episodes":episodes,"total_frames":frames,"total_tasks":tasks,"chunks_size":1000,"data_files_size_in_mb":100,"video_files_size_in_mb":200,"data_path":"data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet","video_path":"videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4","splits":{"train":format!("0:{episodes}")}})
}
fn list_f64(values: &[f64], image: bool) -> ArrayRef {
    if image {
        let mut builder =
            ListBuilder::new(ListBuilder::new(ListBuilder::new(Float64Builder::new())));
        for &value in values {
            builder.values().values().values().append_value(value);
            builder.values().values().append(true);
            builder.values().append(true);
        }
        builder.append(true);
        Arc::new(builder.finish())
    } else {
        let mut builder = ListBuilder::new(Float64Builder::new());
        builder.values().append_slice(values);
        builder.append(true);
        Arc::new(builder.finish())
    }
}
fn episode_metadata(
    job: &ExportJob,
    root: &Path,
    number: usize,
    segment: &Segment,
    frames: i64,
    from: i64,
    stats: &Stats,
) -> Result<()> {
    let mut arrays: Vec<(String, ArrayRef)> = Vec::new();
    for (name, value) in [
        ("episode_index", number as i64),
        ("length", frames),
        ("dataset_from_index", from),
        ("dataset_to_index", from + frames),
        ("data/chunk_index", (number / 1000) as i64),
        ("data/file_index", (number % 1000) as i64),
        ("meta/episodes/chunk_index", (number / 1000) as i64),
        ("meta/episodes/file_index", (number % 1000) as i64),
    ] {
        arrays.push((name.into(), Arc::new(Int64Array::from(vec![value]))));
    }
    let mut tasks = ListBuilder::new(StringBuilder::new());
    tasks.values().append_value(&segment.task);
    tasks.append(true);
    arrays.push(("tasks".into(), Arc::new(tasks.finish())));
    for (suffix, value) in [
        ("chunk_index", (number / 1000) as i64),
        ("file_index", (number % 1000) as i64),
    ] {
        arrays.push((
            format!("videos/{}/{suffix}", job.video.key),
            Arc::new(Int64Array::from(vec![value])),
        ));
    }
    for (suffix, value) in [
        ("from_timestamp", 0.0),
        ("to_timestamp", frames as f64 / job.fps as f64),
    ] {
        arrays.push((
            format!("videos/{}/{suffix}", job.video.key),
            Arc::new(Float64Array::from(vec![value])),
        ));
    }
    for (feature, stat) in stats {
        for kind in ["min", "max", "mean", "std"] {
            arrays.push((
                format!("stats/{feature}/{kind}"),
                list_f64(&stat.values(kind), stat.image),
            ));
        }
        let mut count = ListBuilder::new(Int64Builder::new());
        count.values().append_value(stat.rows as i64);
        count.append(true);
        arrays.push((format!("stats/{feature}/count"), Arc::new(count.finish())));
    }
    let fields = arrays
        .iter()
        .map(|(name, array)| Field::new(name, array.data_type().clone(), false))
        .collect::<Vec<_>>();
    write_batch(
        &path_for(root, "meta/episodes", number, "parquet")?,
        RecordBatch::try_new(
            Arc::new(Schema::new(fields)),
            arrays.into_iter().map(|(_, a)| a).collect(),
        )?,
    )
}
fn write_tasks(root: &Path, tasks: &[String]) -> Result<()> {
    // LeRobot reads this table through pandas and uses task text as its index.
    let pandas=json!({"index_columns":["__index_level_0__"],"column_indexes":[{"name":null,"field_name":null,"pandas_type":"unicode","numpy_type":"object","metadata":{"encoding":"UTF-8"}}],"columns":[{"name":"task_index","field_name":"task_index","pandas_type":"int64","numpy_type":"int64","metadata":null},{"name":null,"field_name":"__index_level_0__","pandas_type":"unicode","numpy_type":"object","metadata":null}],"creator":{"library":"ceres-native-exporter","version":env!("CARGO_PKG_VERSION")},"pandas_version":"2.2.0"}).to_string();
    let schema = Arc::new(Schema::new_with_metadata(
        vec![
            Field::new("task_index", DataType::Int64, false),
            Field::new("__index_level_0__", DataType::Utf8, false),
        ],
        HashMap::from([("pandas".into(), pandas.clone())]),
    ));
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(Int64Array::from(
                (0..tasks.len() as i64).collect::<Vec<_>>(),
            )),
            Arc::new(StringArray::from(tasks.to_vec())),
        ],
    )?;
    let props = WriterProperties::builder()
        .set_compression(Compression::SNAPPY)
        .set_key_value_metadata(Some(vec![KeyValue::new("pandas".into(), Some(pandas))]))
        .build();
    let mut writer = ArrowWriter::try_new(
        File::create(root.join("meta/tasks.parquet"))?,
        schema,
        Some(props),
    )?;
    writer.write(&batch)?;
    writer.close()?;
    Ok(())
}
