//! Cross-platform screenshot capture, built on top of [`xcap`].
//!
//! Three capture modes are supported:
//! * **Fullscreen** / **ActiveMonitor** — capture the primary monitor in its native resolution.
//! * **Region** — capture the primary monitor and crop to the requested rectangle (logical pixels).
//!
//! All paths return PNG bytes ready to be persisted by [`super::ImageManager`].
//!
//! **macOS note** — Screen capture requires the `NSScreenCaptureUsageDescription` entry in
//! `Info.plist` and explicit user consent in System Settings → Privacy & Security → Screen
//! Recording. The first capture attempt will silently return a blacked-out image until the
//! permission is granted (Apple's documented behaviour); the OS prompt should fire once the
//! app actually invokes a capture API.

#![warn(clippy::all, rust_2018_idioms)]

use std::io::Cursor;

use image::{DynamicImage, ImageBuffer, ImageFormat, Rgba};
use serde::{Deserialize, Serialize};
use tracing::debug;
use ts_rs::TS;
use xcap::Monitor;

use crate::error::AppError;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CaptureMode {
    /// Capture every pixel of the primary monitor.
    Fullscreen,
    /// Same as [`CaptureMode::Fullscreen`] today; reserved for "monitor under cursor" in v2.
    ActiveMonitor,
    /// Capture an arbitrary rectangle on the primary monitor. Coordinates are in logical pixels.
    Region { x: u32, y: u32, w: u32, h: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub id: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub is_primary: bool,
}

/// List every monitor reported by the OS. Returns an empty `Vec` if no display is attached
/// (headless CI, SSH session without X forwarding, …).
pub fn list_monitors() -> Result<Vec<MonitorInfo>, AppError> {
    let monitors = Monitor::all().map_err(|e| AppError::other(format!("xcap monitors: {e}")))?;
    let mut out = Vec::with_capacity(monitors.len());
    for m in monitors {
        out.push(MonitorInfo {
            id: m.id(),
            name: m.name().to_string(),
            width: m.width(),
            height: m.height(),
            x: m.x(),
            y: m.y(),
            is_primary: m.is_primary(),
        });
    }
    Ok(out)
}

/// Take a screenshot according to `mode`. Returns the encoded PNG bytes.
///
/// Picks the primary monitor when available, otherwise the first one returned by `xcap`.
pub fn capture(mode: CaptureMode) -> Result<Vec<u8>, AppError> {
    let monitors = Monitor::all().map_err(|e| AppError::other(format!("xcap monitors: {e}")))?;
    if monitors.is_empty() {
        return Err(AppError::other("no monitors detected"));
    }
    let monitor = monitors
        .iter()
        .find(|m| m.is_primary())
        .unwrap_or(&monitors[0]);

    debug!(target: "vibe_term::images", "capturing {:?} on monitor {}", mode, monitor.name());

    let rgba = monitor
        .capture_image()
        .map_err(|e| AppError::other(format!("xcap capture: {e}")))?;
    let (mw, mh) = rgba.dimensions();

    let dyn_image = match mode {
        CaptureMode::Fullscreen | CaptureMode::ActiveMonitor => DynamicImage::ImageRgba8(rgba),
        CaptureMode::Region { x, y, w, h } => {
            if w == 0 || h == 0 {
                return Err(AppError::InvalidInput(
                    "region width/height must be > 0".into(),
                ));
            }
            // The region arrives in LOGICAL pixels (the webview coordinate space),
            // but `capture_image()` returns a PHYSICAL-pixel buffer. On a HiDPI
            // monitor (scale_factor > 1 — e.g. 1.25 at 125% Windows scaling) we
            // must scale the crop rect up to physical pixels, otherwise the
            // selection is cropped at the wrong size/offset (or spuriously
            // rejected as out-of-bounds).
            let scale = monitor.scale_factor().max(1.0);
            let px = ((x as f32) * scale).round() as u32;
            let py = ((y as f32) * scale).round() as u32;
            let pw = ((w as f32) * scale).round() as u32;
            let ph = ((h as f32) * scale).round() as u32;
            if px.saturating_add(pw) > mw || py.saturating_add(ph) > mh {
                return Err(AppError::InvalidInput(format!(
                    "region {}x{}+{}+{} (physical {}x{}+{}+{}) out of bounds ({}x{})",
                    w, h, x, y, pw, ph, px, py, mw, mh
                )));
            }
            // `DynamicImage::crop_imm` keeps the original buffer intact (no in-place mutation).
            DynamicImage::ImageRgba8(rgba).crop_imm(px, py, pw, ph)
        }
    };

    encode_png(dyn_image)
}

fn encode_png(image: DynamicImage) -> Result<Vec<u8>, AppError> {
    let rgba: ImageBuffer<Rgba<u8>, Vec<u8>> = image.to_rgba8();
    let (w, h) = rgba.dimensions();
    let mut bytes = Vec::with_capacity((w as usize * h as usize * 4) / 2);
    rgba.write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .map_err(|e| AppError::other(format!("png encode: {e}")))?;
    Ok(bytes)
}
