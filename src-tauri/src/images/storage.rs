//! On-disk image storage with sha256-based dedup.
//!
//! Images are persisted as `{sha256}.png` files under a single flat directory. A small JSON
//! sidecar (`{sha256}.json`) holds the metadata so the manager can rebuild its in-memory cache
//! after a restart without re-decoding the PNG.

#![warn(clippy::all, rust_2018_idioms)]

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tracing::debug;

use crate::error::AppError;

use super::ImageMeta;

/// Compute the hex-encoded sha256 of an arbitrary byte slice.
pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest.iter() {
        hex.push_str(&format!("{:02x}", byte));
    }
    hex
}

/// Resolve the per-OS default storage directory for image assets.
///
/// Falls back to `./vibe-term-images` in the current working directory if the standard
/// XDG/AppData location cannot be determined (e.g. very restricted sandbox).
pub fn default_storage_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("vibe-term")
        .join("images")
}

/// Write a PNG to `dir/{sha256}.png` if it does not yet exist, returning the absolute path
/// of the resulting file. Existing files are left untouched (dedup).
pub(super) fn write_png_dedup(dir: &Path, sha256: &str, bytes: &[u8]) -> Result<PathBuf, AppError> {
    fs::create_dir_all(dir)?;
    let path = dir.join(format!("{}.png", sha256));
    if !path.exists() {
        fs::write(&path, bytes)?;
        debug!(target: "vibe_term::images", "wrote new image asset {} bytes", bytes.len());
    } else {
        debug!(target: "vibe_term::images", "deduped image asset {}", sha256);
    }
    Ok(path)
}

/// Persist the JSON sidecar describing an image. Overwrites any prior content (cheap, < 1 KB).
pub(super) fn write_sidecar(dir: &Path, meta: &ImageMeta) -> Result<(), AppError> {
    let path = dir.join(format!("{}.json", meta.sha256));
    let json = serde_json::to_vec_pretty(meta)?;
    fs::write(path, json)?;
    Ok(())
}

/// Attempt to load a previously-persisted sidecar by sha256. Returns `Ok(None)` if the file is
/// absent (which is the normal "cache miss" path), and a typed error only for IO/serde failures.
pub(super) fn read_sidecar(dir: &Path, sha256: &str) -> Result<Option<ImageMeta>, AppError> {
    let path = dir.join(format!("{}.json", sha256));
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path)?;
    let meta: ImageMeta = serde_json::from_slice(&bytes)?;
    Ok(Some(meta))
}

/// Delete both the PNG and JSON sidecar associated with an image. Missing files are ignored
/// (the operation is idempotent so the frontend can call `image_delete` defensively).
pub(super) fn delete_assets(dir: &Path, sha256: &str) -> Result<(), AppError> {
    let png = dir.join(format!("{}.png", sha256));
    let json = dir.join(format!("{}.json", sha256));
    for path in [png, json] {
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}
