mod bundle;
mod ceres;
mod config;
mod error;
mod exporter;
mod metadata;
mod parquet_io;
mod stats;

pub use bundle::ExportBundle;
pub use ceres::{
    CERES_ACTION_NAMES, CERES_STATE_DIM, CERES_TELEMETRY_DIM, XR_HAND_JOINTS, state_names,
};
pub use config::{
    ExportConfig, LEROBOT_CODEBASE_VERSION, LEROBOT_ORACLE_COMMIT, LEROBOT_ORACLE_TAG, TaskConfig,
};
pub use error::{ExportError, Result};
pub use exporter::{EpisodeExporter, ExportMetrics};
pub use metadata::{VideoMetadata, compatibility_profile_json};

#[cfg(target_arch = "wasm32")]
mod wasm_api {
    use wasm_bindgen::prelude::*;

    use super::*;

    fn js_error(error: ExportError) -> JsError {
        JsError::new(&error.to_string())
    }

    #[wasm_bindgen(js_name = CeresLeRobotExporter)]
    pub struct WasmExporter {
        inner: Option<EpisodeExporter>,
    }

    #[wasm_bindgen(js_class = CeresLeRobotExporter)]
    impl WasmExporter {
        #[wasm_bindgen(constructor)]
        pub fn new(config_json: &str) -> std::result::Result<WasmExporter, JsError> {
            Ok(Self {
                inner: Some(EpisodeExporter::from_json(config_json).map_err(js_error)?),
            })
        }

        #[wasm_bindgen(js_name = pushCeresFrame)]
        pub fn push_ceres_frame(
            &mut self,
            source_frame_index: u64,
            telemetry: &[f64],
            action: &[f32],
        ) -> std::result::Result<(), JsError> {
            self.inner
                .as_mut()
                .ok_or(ExportError::Finalised)
                .and_then(|exporter| {
                    exporter.push_ceres_frame(source_frame_index, telemetry, action)
                })
                .map_err(js_error)
        }

        #[wasm_bindgen(js_name = pushCeresSensorFrameJson)]
        pub fn push_ceres_sensor_frame_json(
            &mut self,
            frame_json: &str,
        ) -> std::result::Result<(), JsError> {
            self.inner
                .as_mut()
                .ok_or(ExportError::Finalised)
                .and_then(|exporter| exporter.push_ceres_sensor_frame_json(frame_json))
                .map_err(js_error)
        }

        #[wasm_bindgen(js_name = pushCeresSensorFrameJsonForTask)]
        pub fn push_ceres_sensor_frame_json_for_task(
            &mut self,
            frame_json: &str,
            task_index: u64,
        ) -> std::result::Result<(), JsError> {
            self.inner
                .as_mut()
                .ok_or(ExportError::Finalised)
                .and_then(|exporter| {
                    exporter.push_ceres_sensor_frame_json_for_task(frame_json, task_index)
                })
                .map_err(js_error)
        }

        #[wasm_bindgen(js_name = reductionReady)]
        pub fn reduction_ready(&self) -> bool {
            self.inner
                .as_ref()
                .is_some_and(EpisodeExporter::reduction_ready)
        }

        #[wasm_bindgen(js_name = pendingReductionRows)]
        pub fn pending_reduction_rows(&self) -> usize {
            self.inner
                .as_ref()
                .map_or(0, EpisodeExporter::pending_reduction_rows)
        }

        #[wasm_bindgen(js_name = pendingReductionDimensions)]
        pub fn pending_reduction_dimensions(&self) -> usize {
            self.inner
                .as_ref()
                .map_or(0, EpisodeExporter::pending_reduction_dimensions)
        }

        #[wasm_bindgen(js_name = pendingReductionValues)]
        pub fn pending_reduction_values(&self) -> Vec<f32> {
            self.inner.as_ref().map_or_else(Vec::new, |exporter| {
                exporter.pending_reduction_values().to_vec()
            })
        }

        #[wasm_bindgen(js_name = reducePendingCpu)]
        pub fn reduce_pending_cpu(&mut self) -> std::result::Result<(), JsError> {
            self.inner
                .as_mut()
                .ok_or(ExportError::Finalised)
                .and_then(EpisodeExporter::reduce_pending_cpu)
                .map_err(js_error)
        }

        #[wasm_bindgen(js_name = acceptGpuReduction)]
        pub fn accept_gpu_reduction(
            &mut self,
            counts: &[u32],
            means: &[f32],
            m2: &[f32],
            minimums: &[f32],
            maximums: &[f32],
        ) -> std::result::Result<(), JsError> {
            self.inner
                .as_mut()
                .ok_or(ExportError::Finalised)
                .and_then(|exporter| {
                    exporter.accept_gpu_reduction(counts, means, m2, minimums, maximums)
                })
                .map_err(js_error)
        }

        #[wasm_bindgen(js_name = attachVideo)]
        pub fn attach_video(
            &mut self,
            key: &str,
            metadata_json: &str,
            bytes: &[u8],
        ) -> std::result::Result<(), JsError> {
            let metadata = VideoMetadata::from_json(metadata_json).map_err(js_error)?;
            self.inner
                .as_mut()
                .ok_or(ExportError::Finalised)
                .and_then(|exporter| exporter.attach_video(key, metadata, bytes.to_vec()))
                .map_err(js_error)
        }

        #[wasm_bindgen(js_name = metricsJson)]
        pub fn metrics_json(&self) -> std::result::Result<String, JsError> {
            self.inner
                .as_ref()
                .ok_or(ExportError::Finalised)
                .and_then(EpisodeExporter::metrics_json)
                .map_err(js_error)
        }

        pub fn finish(&mut self) -> std::result::Result<WasmExportBundle, JsError> {
            let exporter = self.inner.take().ok_or(ExportError::Finalised)?;
            Ok(WasmExportBundle {
                inner: exporter.finish().map_err(js_error)?,
            })
        }
    }

    #[wasm_bindgen(js_name = LeRobotExportBundle)]
    pub struct WasmExportBundle {
        inner: ExportBundle,
    }

    #[wasm_bindgen(js_class = LeRobotExportBundle)]
    impl WasmExportBundle {
        #[wasm_bindgen(js_name = artifactCount)]
        pub fn artifact_count(&self) -> usize {
            self.inner.artifact_count()
        }

        #[wasm_bindgen(js_name = artifactPath)]
        pub fn artifact_path(&self, index: usize) -> std::result::Result<String, JsError> {
            self.inner
                .artifact_path(index)
                .map(str::to_owned)
                .map_err(js_error)
        }

        #[wasm_bindgen(js_name = artifactMediaType)]
        pub fn artifact_media_type(&self, index: usize) -> std::result::Result<String, JsError> {
            self.inner
                .artifact_media_type(index)
                .map(str::to_owned)
                .map_err(js_error)
        }

        #[wasm_bindgen(js_name = artifactBytes)]
        pub fn artifact_bytes(&self, index: usize) -> std::result::Result<Vec<u8>, JsError> {
            self.inner
                .artifact_bytes(index)
                .map(<[u8]>::to_vec)
                .map_err(js_error)
        }
    }

    #[wasm_bindgen(js_name = lerobotCompatibilityProfile)]
    pub fn wasm_compatibility_profile() -> String {
        compatibility_profile_json()
    }
}
