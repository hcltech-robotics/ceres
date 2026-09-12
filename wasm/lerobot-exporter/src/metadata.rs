use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use arrow_array::builder::{Float64Builder, Int64Builder, ListBuilder, StringBuilder};
use arrow_array::{ArrayRef, Int64Array, RecordBatch, StringArray};
use arrow_schema::{DataType, Field, Schema};
use parquet::file::metadata::KeyValue;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::ceres::{CERES_STATE_DIM, state_names};
use crate::config::{
    DEFAULT_CHUNKS_SIZE, ExportConfig, LEROBOT_CODEBASE_VERSION, LEROBOT_ORACLE_COMMIT,
    LEROBOT_ORACLE_TAG,
};
use crate::error::{ExportError, Result};
use crate::parquet_io::{write_batch, write_batch_with_metadata};
use crate::stats::FeatureStats;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VideoMetadata {
    pub width: u32,
    pub height: u32,
    #[serde(default = "default_channels")]
    pub channels: u32,
    pub fps: f64,
    pub frame_count: u64,
    pub duration_s: f64,
    pub codec: String,
    pub pixel_format: String,
    #[serde(default)]
    pub has_audio: bool,
    #[serde(default)]
    pub is_depth_map: bool,
    #[serde(default = "default_video_backend")]
    pub backend: String,
}

fn default_channels() -> u32 {
    3
}

fn default_video_backend() -> String {
    "webcodecs".to_owned()
}

impl VideoMetadata {
    pub fn from_json(value: &str) -> Result<Self> {
        let metadata: Self = serde_json::from_str(value)?;
        metadata.validate()?;
        Ok(metadata)
    }

    pub(crate) fn validate(&self) -> Result<()> {
        if self.width == 0 || self.height == 0 || self.channels == 0 {
            return Err(ExportError::InvalidVideo(
                "video dimensions and channels must be greater than zero".to_owned(),
            ));
        }
        if !self.fps.is_finite() || self.fps <= 0.0 {
            return Err(ExportError::InvalidVideo(
                "video fps must be finite and greater than zero".to_owned(),
            ));
        }
        if !self.duration_s.is_finite() || self.duration_s <= 0.0 {
            return Err(ExportError::InvalidVideo(
                "video duration must be finite and greater than zero".to_owned(),
            ));
        }
        if self.codec.trim().is_empty()
            || self.pixel_format.trim().is_empty()
            || self.backend.trim().is_empty()
        {
            return Err(ExportError::InvalidVideo(
                "video codec, pixel format and backend must not be empty".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct VideoAttachment {
    pub key: String,
    pub metadata: VideoMetadata,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FeatureStatsDocument {
    pub min: Vec<f64>,
    pub max: Vec<f64>,
    pub mean: Vec<f64>,
    pub std: Vec<f64>,
    pub count: Vec<u64>,
}

impl FeatureStatsDocument {
    pub fn from_stats(stats: &FeatureStats) -> Self {
        let dimensions = stats.dimensions();
        Self {
            min: dimensions.iter().map(|stats| stats.min).collect(),
            max: dimensions.iter().map(|stats| stats.max).collect(),
            mean: dimensions.iter().map(|stats| stats.mean).collect(),
            std: dimensions.iter().map(|stats| stats.std()).collect(),
            count: vec![stats.count()],
        }
    }
}

pub type StatsDocument = BTreeMap<String, FeatureStatsDocument>;

fn vector_feature(dtype: &str, names: Vec<String>) -> Value {
    json!({
        "dtype": dtype,
        "shape": [names.len()],
        "names": names,
    })
}

fn scalar_feature(dtype: &str) -> Value {
    json!({"dtype": dtype, "shape": [1], "names": null})
}

pub fn info_json(
    config: &ExportConfig,
    frame_count: u64,
    videos: &BTreeMap<String, VideoAttachment>,
) -> Result<Vec<u8>> {
    let mut features = serde_json::Map::new();
    features.insert(
        "observation.state".to_owned(),
        vector_feature("float32", state_names()),
    );
    features.insert(
        "action".to_owned(),
        vector_feature("float32", config.action_names.clone()),
    );
    features.insert("timestamp".to_owned(), scalar_feature("float32"));
    features.insert("frame_index".to_owned(), scalar_feature("int64"));
    features.insert("episode_index".to_owned(), scalar_feature("int64"));
    features.insert("index".to_owned(), scalar_feature("int64"));
    features.insert("task_index".to_owned(), scalar_feature("int64"));
    features.insert(
        "ceres.source_frame_index".to_owned(),
        scalar_feature("int64"),
    );
    features.insert("ceres.source_gap".to_owned(), scalar_feature("bool"));
    features.insert(
        "ceres.source_timestamp".to_owned(),
        scalar_feature("float64"),
    );
    for (key, video) in videos {
        let metadata = &video.metadata;
        features.insert(
            key.clone(),
            json!({
                "dtype": "video",
                "shape": [metadata.height, metadata.width, metadata.channels],
                "names": ["height", "width", "channels"],
                "info": {
                    "video.height": metadata.height,
                    "video.width": metadata.width,
                    "video.codec": metadata.codec,
                    "video.pix_fmt": metadata.pixel_format,
                    "video.is_depth_map": metadata.is_depth_map,
                    "video.fps": metadata.fps,
                    "video.channels": metadata.channels,
                    "has_audio": metadata.has_audio,
                    "video.duration_s": metadata.duration_s,
                    "video.frame_count": metadata.frame_count,
                    "video.video_backend": metadata.backend,
                    "video.extra_options": {},
                }
            }),
        );
    }

    let total_episodes = config.episode_index + 1;
    let document = json!({
        "codebase_version": LEROBOT_CODEBASE_VERSION,
        "fps": config.fps,
        "features": features,
        "total_episodes": total_episodes,
        "total_frames": config.global_frame_index + frame_count,
        "total_tasks": config.tasks.len(),
        "chunks_size": DEFAULT_CHUNKS_SIZE,
        "data_files_size_in_mb": config.data_files_size_in_mb,
        "video_files_size_in_mb": config.video_files_size_in_mb,
        "data_path": "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet",
        "video_path": "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4",
        "robot_type": config.robot_type,
        "splits": {"train": format!("0:{total_episodes}")},
    });
    Ok(serde_json::to_vec_pretty(&document)?)
}

pub fn stats_json(stats: &StatsDocument) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec_pretty(stats)?)
}

fn pandas_metadata() -> String {
    json!({
        "index_columns": ["__index_level_0__"],
        "column_indexes": [{
            "name": null,
            "field_name": null,
            "pandas_type": "unicode",
            "numpy_type": "object",
            "metadata": {"encoding": "UTF-8"}
        }],
        "columns": [
            {
                "name": "task_index",
                "field_name": "task_index",
                "pandas_type": "int64",
                "numpy_type": "int64",
                "metadata": null
            },
            {
                "name": null,
                "field_name": "__index_level_0__",
                "pandas_type": "unicode",
                "numpy_type": "object",
                "metadata": null
            }
        ],
        "creator": {"library": "ceres-lerobot-exporter", "version": env!("CARGO_PKG_VERSION")},
        "pandas_version": "2.2.0"
    })
    .to_string()
}

pub fn tasks_parquet(config: &ExportConfig) -> Result<Vec<u8>> {
    let pandas = pandas_metadata();
    let mut metadata = HashMap::new();
    metadata.insert("pandas".to_owned(), pandas.clone());
    let schema = Arc::new(Schema::new_with_metadata(
        vec![
            Field::new("task_index", DataType::Int64, false),
            Field::new("__index_level_0__", DataType::Utf8, false),
        ],
        metadata,
    ));
    let task_indices = config
        .tasks
        .iter()
        .map(|task| task.index as i64)
        .collect::<Vec<_>>();
    let task_text = config
        .tasks
        .iter()
        .map(|task| task.text.as_str())
        .collect::<Vec<_>>();
    let batch = RecordBatch::try_new(
        schema,
        vec![
            Arc::new(Int64Array::from(task_indices)),
            Arc::new(StringArray::from(task_text)),
        ],
    )?;
    write_batch_with_metadata(
        &batch,
        Some(vec![KeyValue {
            key: "pandas".to_owned(),
            value: Some(pandas),
        }]),
    )
}

fn list_strings(values: &[String]) -> ArrayRef {
    let mut builder = ListBuilder::new(StringBuilder::new());
    for value in values {
        builder.values().append_value(value);
    }
    builder.append(true);
    Arc::new(builder.finish())
}

fn list_f64(values: &[f64]) -> ArrayRef {
    let mut builder = ListBuilder::new(Float64Builder::new());
    builder.values().append_slice(values);
    builder.append(true);
    Arc::new(builder.finish())
}

fn list_i64(values: &[i64]) -> ArrayRef {
    let mut builder = ListBuilder::new(Int64Builder::new());
    builder.values().append_slice(values);
    builder.append(true);
    Arc::new(builder.finish())
}

pub fn episode_parquet(
    config: &ExportConfig,
    frame_count: u64,
    stats: &StatsDocument,
    videos: &BTreeMap<String, VideoAttachment>,
    episode_tasks: &[String],
) -> Result<Vec<u8>> {
    let mut fields = vec![
        Field::new("episode_index", DataType::Int64, false),
        Field::new(
            "tasks",
            DataType::List(Arc::new(Field::new("item", DataType::Utf8, true))),
            false,
        ),
        Field::new("length", DataType::Int64, false),
        Field::new("dataset_from_index", DataType::Int64, false),
        Field::new("dataset_to_index", DataType::Int64, false),
        Field::new("data/chunk_index", DataType::Int64, false),
        Field::new("data/file_index", DataType::Int64, false),
    ];
    let mut arrays: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(vec![config.episode_index as i64])),
        list_strings(episode_tasks),
        Arc::new(Int64Array::from(vec![frame_count as i64])),
        Arc::new(Int64Array::from(vec![config.global_frame_index as i64])),
        Arc::new(Int64Array::from(vec![
            (config.global_frame_index + frame_count) as i64,
        ])),
        Arc::new(Int64Array::from(vec![config.chunk_index() as i64])),
        Arc::new(Int64Array::from(vec![config.file_index() as i64])),
    ];

    for (key, video) in videos {
        for (suffix, data_type, value) in [
            ("chunk_index", DataType::Int64, config.chunk_index() as f64),
            ("file_index", DataType::Int64, config.file_index() as f64),
            ("from_timestamp", DataType::Float64, 0.0),
            ("to_timestamp", DataType::Float64, video.metadata.duration_s),
        ] {
            fields.push(Field::new(
                format!("videos/{key}/{suffix}"),
                data_type.clone(),
                false,
            ));
            if data_type == DataType::Int64 {
                arrays.push(Arc::new(Int64Array::from(vec![value as i64])));
            } else {
                arrays.push(Arc::new(arrow_array::Float64Array::from(vec![value])));
            }
        }
    }

    for (feature, values) in stats {
        for (name, data) in [
            ("min", list_f64(&values.min)),
            ("max", list_f64(&values.max)),
            ("mean", list_f64(&values.mean)),
            ("std", list_f64(&values.std)),
        ] {
            fields.push(Field::new(
                format!("stats/{feature}/{name}"),
                data.data_type().clone(),
                false,
            ));
            arrays.push(data);
        }
        let count = values
            .count
            .iter()
            .map(|value| *value as i64)
            .collect::<Vec<_>>();
        let data = list_i64(&count);
        fields.push(Field::new(
            format!("stats/{feature}/count"),
            data.data_type().clone(),
            false,
        ));
        arrays.push(data);
    }

    let batch = RecordBatch::try_new(Arc::new(Schema::new(fields)), arrays)?;
    write_batch(&batch)
}

pub fn compatibility_profile_json() -> String {
    json!({
        "format": LEROBOT_CODEBASE_VERSION,
        "oracle_tag": LEROBOT_ORACLE_TAG,
        "oracle_commit": LEROBOT_ORACLE_COMMIT,
        "storage": "episode-sized immutable v3 shards",
        "state_dimension": CERES_STATE_DIM,
        "required_columns": [
            "observation.state",
            "action",
            "timestamp",
            "frame_index",
            "episode_index",
            "index",
            "task_index"
        ]
    })
    .to_string()
}

pub fn validate_video_key(key: &str) -> Result<()> {
    if !key.starts_with("observation.images.")
        || key.len() <= "observation.images.".len()
        || !key.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
    {
        return Err(ExportError::InvalidVideo(
            "video key must use observation.images.<name> with ASCII letters, digits, dots, dashes or underscores"
                .to_owned(),
        ));
    }
    Ok(())
}
