//! Lazy OCR engine wrapping [`ocrs`].
//!
//! The underlying [`ocrs::OcrEngine`] loads two ONNX models (~25 MB each) from disk on its
//! first invocation. We delay that work until the user actually requests OCR for an image
//! (right-click → "Extract text", or programmatic call from the AI assistant) so cold-start
//! of the terminal app stays snappy.
//!
//! Models are expected under `~/.cache/vibe-term/models/`:
//! * `text-detection.rten`
//! * `text-recognition.rten`
//!
//! A helper script (`scripts/fetch-ocr-models.sh`) downloads them from the official mirror
//! published by the upstream maintainer of `ocrs`.

#![warn(clippy::all, rust_2018_idioms)]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use ocrs::{ImageSource, OcrEngine, OcrEngineParams};
use once_cell::sync::OnceCell;
use rten::Model;
use tracing::{info, warn};

use crate::error::AppError;

const DETECTION_MODEL: &str = "text-detection.rten";
const RECOGNITION_MODEL: &str = "text-recognition.rten";

/// Lazy wrapper around [`OcrEngine`]. Cheap to construct; the heavy `Model::load_file` work
/// only happens on the first [`Engine::extract_text`] call.
pub struct Engine {
    models_dir: PathBuf,
    inner: OnceCell<Arc<OcrEngine>>,
}

impl Engine {
    pub fn new(models_dir: PathBuf) -> Self {
        Self {
            models_dir,
            inner: OnceCell::new(),
        }
    }

    /// Resolve a default model directory under the user's cache dir. Falls back to `./models`
    /// when no cache directory is available (very restricted sandbox).
    pub fn default_models_dir() -> PathBuf {
        dirs::cache_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("vibe-term")
            .join("models")
    }

    pub fn models_dir(&self) -> &Path {
        &self.models_dir
    }

    /// Whether both required ONNX model files are present on disk. Cheap stat call; safe to
    /// invoke from a UI thread.
    pub fn models_present(&self) -> bool {
        self.models_dir.join(DETECTION_MODEL).is_file()
            && self.models_dir.join(RECOGNITION_MODEL).is_file()
    }

    /// Run OCR on a PNG buffer and return the recognised text as a single newline-separated
    /// string (one line per detected text line, mirroring `OcrEngine::get_text`).
    pub fn extract_text(&self, png_bytes: &[u8]) -> Result<String, AppError> {
        let engine = self.get_or_init_engine()?;
        let dyn_image = image::load_from_memory(png_bytes)
            .map_err(|e| AppError::other(format!("ocr: decode png: {e}")))?;
        let rgb = dyn_image.into_rgb8();
        let (w, h) = rgb.dimensions();
        let source = ImageSource::from_bytes(rgb.as_raw(), (w, h))
            .map_err(|e| AppError::other(format!("ocr: image source: {e}")))?;
        let input = engine
            .prepare_input(source)
            .map_err(|e| AppError::other(format!("ocr: prepare input: {e}")))?;
        let text = engine
            .get_text(&input)
            .map_err(|e| AppError::other(format!("ocr: recognise: {e}")))?;
        Ok(text)
    }

    fn get_or_init_engine(&self) -> Result<Arc<OcrEngine>, AppError> {
        if let Some(engine) = self.inner.get() {
            return Ok(engine.clone());
        }

        if !self.models_present() {
            return Err(AppError::other(format!(
                "OCR models not available. Run `scripts/fetch-ocr-models.sh` or check {:?}",
                self.models_dir
            )));
        }

        info!(
            target: "vibe_term::ocr",
            "loading OCR models from {:?} (this may take a moment...)",
            self.models_dir
        );
        let detection_path = self.models_dir.join(DETECTION_MODEL);
        let recognition_path = self.models_dir.join(RECOGNITION_MODEL);
        let detection_model = Model::load_file(&detection_path)
            .map_err(|e| AppError::other(format!("ocr: load detection model: {e}")))?;
        let recognition_model = Model::load_file(&recognition_path)
            .map_err(|e| AppError::other(format!("ocr: load recognition model: {e}")))?;
        let engine = OcrEngine::new(OcrEngineParams {
            detection_model: Some(detection_model),
            recognition_model: Some(recognition_model),
            ..Default::default()
        })
        .map_err(|e| AppError::other(format!("ocr: engine init: {e}")))?;
        let arc = Arc::new(engine);
        if self.inner.set(arc.clone()).is_err() {
            // Lost a race with another caller — that's fine, the other engine is identical.
            warn!(target: "vibe_term::ocr", "OCR engine lost initialisation race; using existing instance");
            return Ok(self.inner.get().cloned().unwrap_or(arc));
        }
        Ok(arc)
    }
}
