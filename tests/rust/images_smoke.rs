//! Smoke tests for the `images` and `ocr` modules.
//!
//! These tests deliberately avoid spinning up a Tauri runtime (no display server, no event
//! loop) and instead exercise the public surface of `ImageManager` against a `MockRuntime`
//! `AppHandle` — which is the runtime the rest of the project uses in integration tests.
//!
//! The OCR test is gated behind a feature flag because it requires ~50 MB of ONNX models on
//! disk that we do not ship in-tree. Set `VIBE_OCR_MODELS_DIR` or run the smoke test with
//! `--features ocr-models` after running `scripts/fetch-ocr-models.sh`.

#![cfg(test)]
#![warn(clippy::all, rust_2018_idioms)]

use std::io::Cursor;

use image::{ImageBuffer, ImageFormat, Rgba};
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri::Manager;
use tempfile::tempdir;

use vibe_term_lib::images::{ImageManager, ImageSource};

/// Build a deterministic 100x100 RGBA PNG with a single solid colour. Returns the raw PNG
/// bytes ready to be fed into `ImageManager::add_from_bytes`.
fn make_solid_png(width: u32, height: u32, rgba: [u8; 4]) -> Vec<u8> {
    let buffer: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_fn(width, height, |_, _| Rgba(rgba));
    let mut bytes = Vec::new();
    buffer
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .expect("encode test png");
    bytes
}

fn build_mock_app() -> tauri::App<tauri::test::MockRuntime> {
    mock_builder()
        .build(mock_context(noop_assets()))
        .expect("build mock tauri app")
}

#[test]
fn add_from_bytes_roundtrip_and_dedup() {
    let dir = tempdir().expect("tempdir");
    let app = build_mock_app();

    let manager = ImageManager::with_storage_dir(app.handle().clone(), dir.path().to_path_buf())
        .expect("manager init");

    let png = make_solid_png(100, 100, [255, 0, 128, 255]);

    let first = manager
        .add_from_bytes(&png, ImageSource::Clipboard)
        .expect("first add");
    assert!(first.id.starts_with("img_"));
    assert_eq!(first.width, 100);
    assert_eq!(first.height, 100);
    assert_eq!(first.mime, "image/png");
    assert_eq!(first.source, ImageSource::Clipboard);
    assert!(first.ocr_text.is_none());

    let fetched = manager
        .get(&first.id)
        .expect("get ok")
        .expect("image exists");
    assert_eq!(fetched.sha256, first.sha256);
    assert_eq!(fetched.id, first.id);

    let bytes = manager.read_bytes(&first.id).expect("read bytes");
    assert!(!bytes.is_empty());

    let b64 = manager.read_as_base64(&first.id).expect("base64");
    assert!(!b64.is_empty());
    assert!(b64
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='));

    // Second add of identical bytes must dedup (same sha + same id, single asset file).
    let second = manager
        .add_from_bytes(&png, ImageSource::Drop)
        .expect("second add");
    assert_eq!(second.sha256, first.sha256, "sha256 must be stable");
    assert_eq!(second.id, first.id, "dedup must reuse existing id");

    // Exactly one PNG and one sidecar on disk.
    let mut pngs = 0;
    let mut sidecars = 0;
    for entry in std::fs::read_dir(dir.path())
        .expect("read storage dir")
        .flatten()
    {
        match entry.path().extension().and_then(|e| e.to_str()) {
            Some("png") => pngs += 1,
            Some("json") => sidecars += 1,
            _ => {}
        }
    }
    assert_eq!(pngs, 1, "dedup should keep a single PNG on disk");
    assert_eq!(sidecars, 1, "dedup should keep a single sidecar on disk");
}

#[test]
fn add_from_path_decodes_existing_png() {
    let dir = tempdir().expect("tempdir");
    let asset_dir = tempdir().expect("asset dir");
    let app = build_mock_app();

    let manager = ImageManager::with_storage_dir(app.handle().clone(), dir.path().to_path_buf())
        .expect("manager init");

    let png = make_solid_png(50, 75, [0, 200, 50, 255]);
    let asset_path = asset_dir.path().join("source.png");
    std::fs::write(&asset_path, &png).expect("write asset");

    let meta = manager
        .add_from_path(&asset_path, ImageSource::Screenshot)
        .expect("add from path");
    assert_eq!(meta.width, 50);
    assert_eq!(meta.height, 75);
    assert_eq!(meta.source, ImageSource::Screenshot);
}

#[test]
fn delete_is_idempotent_and_removes_assets() {
    let dir = tempdir().expect("tempdir");
    let app = build_mock_app();

    let manager = ImageManager::with_storage_dir(app.handle().clone(), dir.path().to_path_buf())
        .expect("manager init");

    let png = make_solid_png(10, 10, [10, 20, 30, 255]);
    let meta = manager
        .add_from_bytes(&png, ImageSource::Terminal)
        .expect("add");

    manager.delete(&meta.id).expect("first delete");
    // Idempotent: deleting again must not error.
    manager.delete(&meta.id).expect("second delete");
    assert!(manager.get(&meta.id).expect("get after delete").is_none());

    let remaining = std::fs::read_dir(dir.path()).expect("dir").count();
    assert_eq!(remaining, 0, "storage dir should be empty after delete");
}

#[test]
fn add_from_bytes_rejects_empty_input() {
    let dir = tempdir().expect("tempdir");
    let app = build_mock_app();

    let manager = ImageManager::with_storage_dir(app.handle().clone(), dir.path().to_path_buf())
        .expect("manager init");

    let err = manager.add_from_bytes(&[], ImageSource::Clipboard);
    assert!(err.is_err(), "empty input must be rejected");
}

/// Sanity: the OCR engine should be cheaply constructible (no model load) and report missing
/// models as a clean error rather than panicking.
#[test]
fn ocr_engine_lazy_init_reports_missing_models_cleanly() {
    let dir = tempdir().expect("tempdir");
    let engine = vibe_term_lib::ocr::Engine::new(dir.path().to_path_buf());
    assert!(!engine.models_present());

    let png = make_solid_png(20, 20, [255, 255, 255, 255]);
    let err = engine
        .extract_text(&png)
        .expect_err("should error without models");
    let msg = format!("{err}");
    assert!(
        msg.contains("OCR models not available"),
        "error must guide the user to the fetch script, got: {msg}"
    );
}

/// Real OCR end-to-end test, opt-in. Gated by the `ocr-models` feature so it does not break
/// CI on machines without the ONNX models. Run with:
///     cargo test -p vibe-term --features ocr-models images_smoke -- --ignored
#[test]
#[cfg_attr(not(feature = "ocr-models"), ignore)]
fn ocr_engine_extracts_text_from_real_image() {
    // The test relies on a user-provided fixture rendered with text; we only sanity-check
    // that the engine returns *some* string. Skip if no fixture is configured.
    let fixture = match std::env::var("VIBE_OCR_FIXTURE_PNG") {
        Ok(p) => p,
        Err(_) => return,
    };
    let engine = vibe_term_lib::ocr::Engine::new(vibe_term_lib::ocr::Engine::default_models_dir());
    let bytes = std::fs::read(fixture).expect("read fixture");
    let text = engine.extract_text(&bytes).expect("ocr");
    assert!(!text.is_empty(), "OCR should produce non-empty text");
}
