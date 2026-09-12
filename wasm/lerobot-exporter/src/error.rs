use thiserror::Error;

pub type Result<T> = std::result::Result<T, ExportError>;

#[derive(Debug, Error)]
pub enum ExportError {
    #[error("invalid exporter configuration: {0}")]
    InvalidConfig(String),
    #[error("invalid Ceres frame: {0}")]
    InvalidFrame(String),
    #[error("the bounded reduction queue is full; drain it before pushing another frame")]
    ReductionPending,
    #[error("the episode has reached its configured maximum of {0} frames")]
    EpisodeFull(u64),
    #[error("invalid video attachment: {0}")]
    InvalidVideo(String),
    #[error("the exporter has already been finalised")]
    Finalised,
    #[error("Parquet error: {0}")]
    Parquet(#[from] parquet::errors::ParquetError),
    #[error("Arrow error: {0}")]
    Arrow(#[from] arrow_schema::ArrowError),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}
