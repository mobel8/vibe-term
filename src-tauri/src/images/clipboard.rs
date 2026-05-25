//! Read images from the system clipboard.
//!
//! Primary path is the [`arboard`] crate which works on macOS, Windows and Linux/X11. On
//! Wayland sessions `arboard` 3.4+ also works in most compositors, but some (Sway, older
//! GNOME) still need an out-of-process helper: we fall back to `wl-paste --type image/png`
//! if arboard returns an error on Wayland.
//!
//! Returns PNG bytes (always re-encoded from the raw RGBA buffer that arboard yields) so
//! callers can hash/store them in a single canonical format.

#![warn(clippy::all, rust_2018_idioms)]

use std::io::Cursor;
#[cfg(target_os = "linux")]
use std::process::Command;

use arboard::Clipboard;
use image::{ImageBuffer, ImageFormat, Rgba};
use tracing::{debug, warn};

use crate::error::AppError;

/// Try to read an image from the clipboard, returning PNG bytes on success.
///
/// * `Ok(Some(bytes))` — an image was retrieved and re-encoded as PNG.
/// * `Ok(None)`        — the clipboard does not currently hold an image (not an error).
/// * `Err(_)`          — clipboard infrastructure failure (no display, permission denied, …).
pub fn read_image_from_clipboard() -> Result<Option<Vec<u8>>, AppError> {
    match read_via_arboard() {
        Ok(Some(bytes)) => Ok(Some(bytes)),
        Ok(None) => {
            #[cfg(target_os = "linux")]
            {
                if is_wayland() {
                    debug!(target: "vibe_term::images", "arboard returned no image on Wayland; trying wl-paste fallback");
                    return read_via_wl_paste();
                }
            }
            Ok(None)
        }
        Err(err) => {
            #[cfg(target_os = "linux")]
            {
                if is_wayland() {
                    warn!(
                        target: "vibe_term::images",
                        "arboard image read failed on Wayland ({}); trying wl-paste fallback", err
                    );
                    return read_via_wl_paste();
                }
            }
            Err(err)
        }
    }
}

fn read_via_arboard() -> Result<Option<Vec<u8>>, AppError> {
    let mut clipboard =
        Clipboard::new().map_err(|e| AppError::other(format!("clipboard init: {e}")))?;
    match clipboard.get_image() {
        Ok(image_data) => {
            let width = u32::try_from(image_data.width)
                .map_err(|_| AppError::other("clipboard image width overflows u32"))?;
            let height = u32::try_from(image_data.height)
                .map_err(|_| AppError::other("clipboard image height overflows u32"))?;
            if width == 0 || height == 0 {
                return Ok(None);
            }
            let buffer: ImageBuffer<Rgba<u8>, Vec<u8>> =
                ImageBuffer::from_raw(width, height, image_data.bytes.into_owned())
                    .ok_or_else(|| AppError::other("clipboard image buffer has unexpected size"))?;
            let mut png = Vec::with_capacity((width as usize * height as usize * 4) / 2);
            buffer
                .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
                .map_err(|e| AppError::other(format!("png encode: {e}")))?;
            Ok(Some(png))
        }
        Err(arboard::Error::ContentNotAvailable) => Ok(None),
        Err(arboard::Error::ClipboardNotSupported) => Ok(None),
        Err(err) => Err(AppError::other(format!("clipboard image: {err}"))),
    }
}

#[cfg(target_os = "linux")]
fn is_wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
}

/// Fallback on Wayland: shell out to `wl-paste`. Available in the `wl-clipboard` package
/// on every modern distro. If the binary is missing we just return `Ok(None)` rather than
/// error so the UI can stay silent (instead of nagging users on every paste attempt).
#[cfg(target_os = "linux")]
fn read_via_wl_paste() -> Result<Option<Vec<u8>>, AppError> {
    let output = match Command::new("wl-paste")
        .args(["--type", "image/png"])
        .output()
    {
        Ok(o) => o,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            warn!(target: "vibe_term::images", "wl-paste not installed; cannot read Wayland clipboard image");
            return Ok(None);
        }
        Err(err) => return Err(AppError::other(format!("wl-paste spawn: {err}"))),
    };

    if !output.status.success() {
        // Exit code 1 = "no image on clipboard" — treat as empty.
        debug!(
            target: "vibe_term::images",
            "wl-paste exited with status {}; assuming no image on clipboard",
            output.status
        );
        return Ok(None);
    }
    if output.stdout.is_empty() {
        return Ok(None);
    }
    Ok(Some(output.stdout))
}
