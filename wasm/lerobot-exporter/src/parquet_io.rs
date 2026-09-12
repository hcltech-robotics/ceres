use std::sync::Arc;

use arrow_array::{
    ArrayRef, BooleanArray, FixedSizeListArray, Float32Array, Float64Array, Int64Array, RecordBatch,
};
use arrow_schema::{DataType, Field, Schema, SchemaRef};
use parquet::arrow::ArrowWriter;
use parquet::basic::Compression;
use parquet::file::metadata::KeyValue;
use parquet::file::properties::WriterProperties;

use crate::error::Result;

#[derive(Debug)]
struct RowBuffer {
    state: Vec<f32>,
    action: Vec<f32>,
    timestamp: Vec<f32>,
    frame_index: Vec<i64>,
    episode_index: Vec<i64>,
    index: Vec<i64>,
    task_index: Vec<i64>,
    source_frame_index: Vec<i64>,
    source_timestamp: Vec<f64>,
    source_gap: Vec<bool>,
}

impl RowBuffer {
    fn with_capacity(rows: usize, state_dim: usize, action_dim: usize) -> Self {
        Self {
            state: Vec::with_capacity(rows * state_dim),
            action: Vec::with_capacity(rows * action_dim),
            timestamp: Vec::with_capacity(rows),
            frame_index: Vec::with_capacity(rows),
            episode_index: Vec::with_capacity(rows),
            index: Vec::with_capacity(rows),
            task_index: Vec::with_capacity(rows),
            source_frame_index: Vec::with_capacity(rows),
            source_timestamp: Vec::with_capacity(rows),
            source_gap: Vec::with_capacity(rows),
        }
    }

    fn len(&self) -> usize {
        self.timestamp.len()
    }

    fn clear(&mut self) {
        self.state.clear();
        self.action.clear();
        self.timestamp.clear();
        self.frame_index.clear();
        self.episode_index.clear();
        self.index.clear();
        self.task_index.clear();
        self.source_frame_index.clear();
        self.source_timestamp.clear();
        self.source_gap.clear();
    }
}

#[derive(Debug, Clone, Copy)]
pub struct RowIndices {
    pub frame: i64,
    pub episode: i64,
    pub global: i64,
    pub task: i64,
    pub source_frame: i64,
}

pub struct DataShardWriter {
    schema: SchemaRef,
    writer: ArrowWriter<Vec<u8>>,
    rows: RowBuffer,
    state_dim: usize,
    action_dim: usize,
    row_group_size: usize,
    rows_written: u64,
    row_groups_written: u64,
}

impl DataShardWriter {
    pub fn new(state_dim: usize, action_dim: usize, row_group_size: usize) -> Result<Self> {
        let schema = Arc::new(Schema::new(vec![
            Field::new(
                "observation.state",
                DataType::FixedSizeList(
                    Arc::new(Field::new("item", DataType::Float32, false)),
                    state_dim as i32,
                ),
                false,
            ),
            Field::new(
                "action",
                DataType::FixedSizeList(
                    Arc::new(Field::new("item", DataType::Float32, false)),
                    action_dim as i32,
                ),
                false,
            ),
            Field::new("timestamp", DataType::Float32, false),
            Field::new("frame_index", DataType::Int64, false),
            Field::new("episode_index", DataType::Int64, false),
            Field::new("index", DataType::Int64, false),
            Field::new("task_index", DataType::Int64, false),
            Field::new("ceres.source_frame_index", DataType::Int64, false),
            Field::new("ceres.source_timestamp", DataType::Float64, false),
            Field::new("ceres.source_gap", DataType::Boolean, false),
        ]));
        let properties = WriterProperties::builder()
            .set_compression(Compression::SNAPPY)
            .set_max_row_group_row_count(Some(row_group_size))
            .build();
        let writer = ArrowWriter::try_new(Vec::new(), schema.clone(), Some(properties))?;
        Ok(Self {
            schema,
            writer,
            rows: RowBuffer::with_capacity(row_group_size, state_dim, action_dim),
            state_dim,
            action_dim,
            row_group_size,
            rows_written: 0,
            row_groups_written: 0,
        })
    }

    pub fn push(
        &mut self,
        state: &[f32],
        action: &[f32],
        timestamp: f32,
        indices: RowIndices,
        source_timestamp: f64,
        source_gap: bool,
    ) -> Result<()> {
        debug_assert_eq!(state.len(), self.state_dim);
        debug_assert_eq!(action.len(), self.action_dim);
        self.rows.state.extend_from_slice(state);
        self.rows.action.extend_from_slice(action);
        self.rows.timestamp.push(timestamp);
        self.rows.frame_index.push(indices.frame);
        self.rows.episode_index.push(indices.episode);
        self.rows.index.push(indices.global);
        self.rows.task_index.push(indices.task);
        self.rows.source_frame_index.push(indices.source_frame);
        self.rows.source_timestamp.push(source_timestamp);
        self.rows.source_gap.push(source_gap);
        if self.rows.len() >= self.row_group_size {
            self.flush()?;
        }
        Ok(())
    }

    fn fixed_f32(values: &[f32], dimensions: usize) -> ArrayRef {
        Arc::new(FixedSizeListArray::new(
            Arc::new(Field::new("item", DataType::Float32, false)),
            dimensions as i32,
            Arc::new(Float32Array::from(values.to_vec())),
            None,
        ))
    }

    pub fn flush(&mut self) -> Result<()> {
        let row_count = self.rows.len();
        if row_count == 0 {
            return Ok(());
        }
        let columns: Vec<ArrayRef> = vec![
            Self::fixed_f32(&self.rows.state, self.state_dim),
            Self::fixed_f32(&self.rows.action, self.action_dim),
            Arc::new(Float32Array::from(self.rows.timestamp.clone())),
            Arc::new(Int64Array::from(self.rows.frame_index.clone())),
            Arc::new(Int64Array::from(self.rows.episode_index.clone())),
            Arc::new(Int64Array::from(self.rows.index.clone())),
            Arc::new(Int64Array::from(self.rows.task_index.clone())),
            Arc::new(Int64Array::from(self.rows.source_frame_index.clone())),
            Arc::new(Float64Array::from(self.rows.source_timestamp.clone())),
            Arc::new(BooleanArray::from(self.rows.source_gap.clone())),
        ];
        let batch = RecordBatch::try_new(self.schema.clone(), columns)?;
        self.writer.write(&batch)?;
        self.rows_written += row_count as u64;
        self.row_groups_written += 1;
        self.rows.clear();
        Ok(())
    }

    pub fn finish(mut self) -> Result<(Vec<u8>, u64, u64)> {
        self.flush()?;
        let bytes = self.writer.into_inner()?;
        Ok((bytes, self.rows_written, self.row_groups_written))
    }
}

pub fn write_batch(batch: &RecordBatch) -> Result<Vec<u8>> {
    write_batch_with_metadata(batch, None)
}

pub fn write_batch_with_metadata(
    batch: &RecordBatch,
    metadata: Option<Vec<KeyValue>>,
) -> Result<Vec<u8>> {
    let properties = WriterProperties::builder()
        .set_compression(Compression::SNAPPY)
        .set_key_value_metadata(metadata)
        .build();
    let mut writer = ArrowWriter::try_new(Vec::new(), batch.schema(), Some(properties))?;
    writer.write(batch)?;
    Ok(writer.into_inner()?)
}
