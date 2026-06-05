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

/// Best-effort cleanup for the temp file used by the atomic write below. While `path` is
/// `Some`, dropping the guard removes that file (ignoring secondary errors). It is set to
/// `None` after a successful rename so the published asset is never touched.
struct TmpGuard {
    path: Option<PathBuf>,
}

impl Drop for TmpGuard {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = fs::remove_file(path);
        }
    }
}

/// Write a PNG to `dir/{sha256}.png` if it does not yet exist, returning the absolute path
/// of the resulting file. Existing files are left untouched (dedup).
pub(super) fn write_png_dedup(dir: &Path, sha256: &str, bytes: &[u8]) -> Result<PathBuf, AppError> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    fs::create_dir_all(dir)?;
    let path = dir.join(format!("{}.png", sha256));
    if !path.exists() {
        // Atomic write: write to a unique temp file then rename onto the final
        // path. A crash mid-write can no longer leave a TRUNCATED {sha}.png that
        // the exists()-based dedup would treat as complete forever. rename() is
        // atomic on the same volume on Windows/macOS/Linux.
        let tmp = dir.join(format!(
            "{}.png.tmp.{}",
            sha256,
            TMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        // Guard the temp file so a failure (or panic) on any path before the
        // rename completes deletes it on drop, rather than leaking a full-size
        // {sha}.png.tmp.N forever. Temp names carry a numeric extension so they
        // are invisible to list_all/get/delete_assets and could never be GC'd.
        let mut guard = TmpGuard { path: Some(tmp.clone()) };
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, &path)?;
        // Rename published the bytes; the temp no longer exists, so disarm.
        guard.path = None;
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
    let mut meta: ImageMeta = serde_json::from_slice(&bytes)?;
    // Reconstruct the absolute PNG path from the storage dir + sha. Older
    // sidecars persisted only the bare filename, which is useless to external
    // CLI consumers; recomputing here keeps every read consistent regardless
    // of when the sidecar was written.
    meta.path = dir.join(format!("{}.png", sha256)).to_string_lossy().into_owned();
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
