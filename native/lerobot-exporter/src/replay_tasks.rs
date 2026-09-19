use super::{
    PoseIdentity, column, identifier, micros, number, optional_number, parquet_files, read_json,
};
use anyhow::{Context, Result, ensure};
use arrow_array::{Array, LargeListArray, LargeStringArray, ListArray, RecordBatch, StringArray};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    path::{Component, Path},
};

fn text(array: &dyn Array, row: usize) -> Result<String> {
    ensure!(!array.is_null(row), "Missing task text");
    if let Some(array) = array.as_any().downcast_ref::<StringArray>() {
        Ok(array.value(row).to_owned())
    } else if let Some(array) = array.as_any().downcast_ref::<LargeStringArray>() {
        Ok(array.value(row).to_owned())
    } else {
        anyhow::bail!("Task catalogue text must be a string")
    }
}
fn texts(array: &dyn Array, row: usize) -> Result<Vec<String>> {
    ensure!(!array.is_null(row), "Missing episode task list");
    let items = if let Some(array) = array.as_any().downcast_ref::<ListArray>() {
        array.value(row)
    } else if let Some(array) = array.as_any().downcast_ref::<LargeListArray>() {
        array.value(row)
    } else {
        anyhow::bail!("Episode tasks must be a list")
    };
    (0..items.len())
        .map(|index| text(items.as_ref(), index))
        .collect()
}
fn relative_json(root: &Path, value: &str) -> Result<Value> {
    let relative = Path::new(value);
    ensure!(
        !value.is_empty()
            && relative
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
        "Invalid task specification path"
    );
    let root = fs::canonicalize(root)?;
    let path =
        fs::canonicalize(root.join(relative)).context("Task specification file is missing")?;
    ensure!(
        path.starts_with(&root),
        "Task specification is outside the dataset"
    );
    read_json(&path)
}
fn supplied_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}
fn copy_field(target: &mut Value, key: &str, source: &Value, original: &str) {
    if let Some(value) = source.get(original) {
        target[key] = value.clone();
    }
}

pub(super) struct TaskInterval {
    pub start_us: i64,
    pub identity: PoseIdentity,
    pub attributes: Value,
}
#[derive(PartialEq, Eq)]
struct TaskKey {
    episode: u32,
    segment: Option<usize>,
    task: Option<u32>,
}
struct ActiveTask {
    key: TaskKey,
    interval: TaskInterval,
}

pub(super) struct TaskTimeline {
    metadata: Value,
    specification: Value,
    catalogue: BTreeMap<u32, String>,
    episode_tasks: BTreeMap<u32, Vec<String>>,
    segments: Vec<Value>,
    segment_ends: Option<Vec<u64>>,
    current_episode: Option<u32>,
    episode_rows: u64,
    active: Option<ActiveTask>,
    intervals: Vec<TaskInterval>,
}

impl TaskTimeline {
    pub fn load(dataset: &Path, metadata: &Value) -> Result<Self> {
        let specification = if let Some(path) = supplied_string(metadata, "taskSpecificationPath") {
            let specification = relative_json(dataset, path)?;
            ensure!(
                specification["schema"] == "ceres-task-specification"
                    && specification["version"] == 1
                    && specification["tasks"].is_array(),
                "Unsupported dataset task specification"
            );
            specification
        } else {
            Value::Null
        };
        let mut catalogue = BTreeMap::new();
        let tasks_path = dataset.join("meta/tasks.parquet");
        if tasks_path.is_file() {
            for batch in ParquetRecordBatchReaderBuilder::try_new(File::open(tasks_path)?)?
                .with_batch_size(256)
                .build()?
            {
                let batch = batch?;
                let labels = batch
                    .column_by_name("__index_level_0__")
                    .or_else(|| batch.column_by_name("task"))
                    .context("Task catalogue is missing task labels")?;
                for row in 0..batch.num_rows() {
                    let id = identifier(number(column(&batch, "task_index")?, row)?)?;
                    let label = text(labels.as_ref(), row)?;
                    if let Some(previous) = catalogue.insert(id, label.clone()) {
                        ensure!(previous == label, "Conflicting dataset task identity");
                    }
                }
            }
        }
        let mut episode_tasks = BTreeMap::new();
        let episodes_path = dataset.join("meta/episodes");
        if episodes_path.is_dir() {
            for path in parquet_files(&episodes_path)? {
                for batch in ParquetRecordBatchReaderBuilder::try_new(File::open(path)?)?
                    .with_batch_size(256)
                    .build()?
                {
                    let batch = batch?;
                    let Some(tasks) = batch.column_by_name("tasks") else {
                        continue;
                    };
                    for row in 0..batch.num_rows() {
                        let episode = identifier(number(column(&batch, "episode_index")?, row)?)?;
                        episode_tasks.insert(episode, texts(tasks.as_ref(), row)?);
                    }
                }
            }
        }
        let segments = metadata["segments"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter(|segment| {
                        segment["outcome"] != "retry"
                            && segment.get("recorderSlotCount").and_then(Value::as_u64) != Some(0)
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut total = 0_u64;
        let segment_ends = if !segments.is_empty()
            && segments
                .iter()
                .all(|segment| segment["recorderSlotCount"].as_u64().is_some())
        {
            Some(
                segments
                    .iter()
                    .map(|segment| {
                        total = total
                            .checked_add(segment["recorderSlotCount"].as_u64().unwrap())
                            .context("Task segment frame counts exceed their limit")?;
                        Ok(total)
                    })
                    .collect::<Result<Vec<_>>>()?,
            )
        } else {
            None
        };
        Ok(Self {
            metadata: metadata.clone(),
            specification,
            catalogue,
            episode_tasks,
            segments,
            segment_ends,
            current_episode: None,
            episode_rows: 0,
            active: None,
            intervals: Vec::new(),
        })
    }

    fn metadata_applies(&self, episode: u32) -> bool {
        self.metadata
            .get("episodeIndex")
            .and_then(Value::as_u64)
            .is_none_or(|id| id == u64::from(episode))
    }
    fn validate_episode(&self) -> Result<()> {
        if let Some(episode) = self.current_episode
            && self.metadata_applies(episode)
            && let Some(ends) = &self.segment_ends
        {
            ensure!(
                ends.last() == Some(&self.episode_rows),
                "Task segment frame counts differ from the replay observations"
            );
        }
        Ok(())
    }
    fn close(&mut self, end_us: i64) -> Result<()> {
        if let Some(mut active) = self.active.take() {
            ensure!(
                end_us > active.interval.start_us,
                "Task interval has no replay duration"
            );
            active.interval.attributes["end_us"] = json!(end_us);
            self.intervals.push(active.interval);
        }
        Ok(())
    }
    fn select_segment(&self, episode: u32, source_us: Option<i64>) -> Result<Option<usize>> {
        if !self.metadata_applies(episode) || self.segments.is_empty() {
            return Ok(None);
        }
        if let Some(ends) = &self.segment_ends {
            let index = ends.partition_point(|end| *end <= self.episode_rows);
            ensure!(
                index < ends.len(),
                "Task segment frame counts do not cover the replay observations"
            );
            return Ok(Some(index));
        }
        if let Some(source_us) = source_us
            && let Some((index, _)) = self.segments.iter().enumerate().rev().find(|(_, segment)| {
                segment["startSourceTimestampUs"]
                    .as_i64()
                    .is_some_and(|start| source_us >= start)
                    && segment["endSourceTimestampUs"]
                        .as_i64()
                        .is_none_or(|end| source_us <= end)
            })
        {
            return Ok(Some(index));
        }
        if self.segments.len() == 1 && self.segments[0].get("startSourceTimestampUs").is_none() {
            return Ok(Some(0));
        }
        Ok(None)
    }
    fn specification_task(
        &self,
        task: Option<u32>,
        segment: &Value,
        label: Option<&str>,
    ) -> Option<(usize, &Value)> {
        let tasks = self.specification["tasks"].as_array()?;
        let id = supplied_string(segment, "taskId");
        tasks.iter().enumerate().find(|(_, candidate)| {
            id.is_some_and(|id| candidate["id"].as_str() == Some(id))
                || task.is_some_and(|index| {
                    candidate["datasetTaskIndex"].as_u64() == Some(u64::from(index))
                })
                || label.is_some_and(|label| {
                    candidate["label"]
                        .as_str()
                        .is_some_and(|value| value.trim() == label.trim())
                })
        })
    }
    fn attributes(
        &self,
        episode: u32,
        segment_index: Option<usize>,
        task: Option<u32>,
        start_us: i64,
    ) -> Value {
        let applies = self.metadata_applies(episode);
        let segment = segment_index
            .map(|index| &self.segments[index])
            .unwrap_or(&Value::Null);
        let catalogue_label = task
            .and_then(|task| self.catalogue.get(&task))
            .map(String::as_str);
        let episode_label = self
            .episode_tasks
            .get(&episode)
            .filter(|tasks| tasks.len() == 1)
            .map(|tasks| tasks[0].as_str());
        let label = supplied_string(segment, "taskLabel")
            .or(catalogue_label)
            .or(episode_label);
        let specification_task = applies
            .then(|| self.specification_task(task, segment, label))
            .flatten();
        let entry = specification_task
            .map(|(_, entry)| entry)
            .unwrap_or(&Value::Null);
        let label = label
            .or_else(|| supplied_string(entry, "label"))
            .or_else(|| {
                applies
                    .then(|| supplied_string(&self.metadata["bridge"], "task"))
                    .flatten()
            })
            .unwrap_or("Dataset episode");
        let description = supplied_string(segment, "taskDescription")
            .or_else(|| supplied_string(entry, "instructions"))
            .unwrap_or("");
        let mut value = json!({"schema":"ceres-replay-task","version":1,"action":"stop","name":label,"title":label,"description":description,"episode_index":episode,"start_us":start_us});
        if let Some(task) = task {
            value["task_index"] = json!(task);
        }
        if let Some((index, _)) = specification_task {
            value["specification_task_index"] = json!(index);
        }
        if let Some(id) =
            supplied_string(segment, "taskId").or_else(|| supplied_string(entry, "id"))
        {
            value["task_id"] = json!(id);
        }
        if !segment.is_null() {
            value["source_segment"] = segment.clone();
            for (key, original) in [
                ("segment_id", "id"),
                ("repetition", "repetition"),
                ("take", "take"),
                ("cycle", "cycle"),
                ("repetition_label", "label"),
                ("source_start_us", "startSourceTimestampUs"),
                ("source_end_us", "endSourceTimestampUs"),
                ("started_at", "startedAt"),
                ("ended_at", "endedAt"),
            ] {
                copy_field(&mut value, key, segment, original);
            }
        }
        if applies {
            for (key, original) in [
                ("episode_id", "episodeId"),
                ("task_spec_hash", "taskSpecHash"),
                ("task_spec_version", "taskSpecVersion"),
            ] {
                copy_field(&mut value, key, &self.metadata, original);
            }
            if value.get("cycle").is_none() {
                if self.metadata.get("cycle").is_some() {
                    copy_field(&mut value, "cycle", &self.metadata, "cycle");
                } else {
                    copy_field(&mut value, "cycle", &self.metadata["capture"], "cycle");
                }
            }
        }
        if applies && !self.specification.is_null() {
            value["task_specification"] = self.specification.clone();
            copy_field(&mut value, "run_title", &self.specification, "runTitle");
            copy_field(
                &mut value,
                "run_description",
                &self.specification,
                "runDescription",
            );
        }
        value
    }
    pub fn observe(
        &mut self,
        batch: &RecordBatch,
        row: usize,
        time: i64,
        identity: &PoseIdentity,
    ) -> Result<()> {
        let episode = identifier(number(column(batch, "episode_index")?, row)?)?;
        if self.current_episode != Some(episode) {
            self.validate_episode()?;
            self.current_episode = Some(episode);
            self.episode_rows = 0;
        }
        let source = batch
            .column_by_name("ceres.source_timestamp")
            .filter(|column| {
                !matches!(
                    column.data_type(),
                    arrow_schema::DataType::FixedSizeList(_, _)
                )
            })
            .map(|column| micros(number(column.as_ref(), row)?))
            .transpose()?;
        let segment = self.select_segment(episode, source)?;
        let task = optional_number(batch, "task_index", row)?
            .map(identifier)
            .transpose()?;
        let key = TaskKey {
            episode,
            segment,
            task,
        };
        if self.active.as_ref().is_none_or(|active| active.key != key) {
            self.close(time)?;
            self.active = Some(ActiveTask {
                interval: TaskInterval {
                    start_us: time,
                    identity: *identity,
                    attributes: self.attributes(episode, segment, task, time),
                },
                key,
            });
        }
        self.episode_rows += 1;
        Ok(())
    }
    pub fn finish(mut self, end_us: i64) -> Result<Vec<TaskInterval>> {
        self.validate_episode()?;
        self.close(end_us)?;
        Ok(self.intervals)
    }
}
