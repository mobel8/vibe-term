//! Image asset manager — clipboard / drop / screenshot / terminal-generated images.
//!
//! Responsibilities:
//! * Decode arbitrary input bytes (PNG, JPEG, WebP, GIF, raw RGBA from clipboard) into a
//!   canonical lossless PNG on disk under `~/.local/share/vibe-term/images/` (XDG path).
//! * Deduplicate via the sha256 of the *re-encoded* canonical PNG.
//! * Maintain a small in-memory LRU cache of recently used metadata to avoid hitting disk
//!   on every IPC request from the React frontend.
//! * Emit `image://added` events so the frontend can surface new pastes/captures as inline
//!   chips without polling.
//!
//! Public methods are blocking but cheap (decode + PNG re-encode for a 1080p frame stays
//! well under 100 ms in release mode). Wrap calls in `tokio::task::spawn_blocking` from a
//! command handler if you ever need to feed multi-megapixel images.

#![warn(clippy::all, rust_2018_idioms)]

pub mod clipboard;
pub mod screenshot;
pub mod storage;

use std::fs;
use std::io::Cursor;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use chrono::Utc;
use image::ImageFormat;
use lru::LruCache;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, Wry};
use tracing::{debug, info, warn};
use ts_rs::TS;

use crate::error::AppError;
use crate::events;

const CACHE_CAPACITY: usize = 64;
const ID_ALPHABET: [char; 36] = [
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i',
    'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
];

/// Where an image originally came from. Persisted as a lowercase string for SQLite friendliness.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum ImageSource {
    Clipboard,
    Screenshot,
    Drop,
    Terminal,
}

/// Public metadata payload describing one stored image. Mirrored in TypeScript via `ts-rs`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ImageMeta {
    pub id: String,
    pub sha256: String,
    /// Path relative to the manager's storage directory (just `{sha256}.png`).
    pub path: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub source: ImageSource,
    pub ocr_text: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageAddedEvent<'a> {
    image_id: &'a str,
    source: ImageSource,
    w: u32,
    h: u32,
    bytes: u64,
}

/// Owner of the image cache + storage directory. Construct once via [`AppState`] and share
/// behind an `Arc`. All public methods take `&self` and use interior mutability so the
/// manager can be passed across Tauri command boundaries without `Mutex<AppState>` gymnastics.
///
/// Generic over the Tauri runtime so integration tests can inject `MockRuntime`; production
/// callers use the default [`Wry`] runtime and don't need to spell the generic out.
pub struct ImageManager<R: Runtime = Wry> {
    app_handle: AppHandle<R>,
    storage_dir: PathBuf,
    cache: Mutex<LruCache<String, Arc<ImageMeta>>>,
    /// Secondary index sha256 → image_id, allowing dedup lookups in O(1).
    sha_index: Mutex<LruCache<String, String>>,
    /// Serializes the dedup-or-create tail of `add_from_bytes` so two threads
    /// adding the SAME bytes concurrently can't both miss the dedup checks and
    /// each mint a distinct id (last sidecar writer would win, orphaning the
    /// other id). Held only across the re-check → write → cache → emit section;
    /// the common non-concurrent path is behaviorally unchanged.
    insert_guard: Mutex<()>,
}

impl<R: Runtime> ImageManager<R> {
    /// Resolve the storage directory (`~/.local/share/vibe-term/images/` on Linux,
    /// `~/Library/Application Support/...` on macOS, `%LOCALAPPDATA%\...` on Windows),
    /// create it if missing and return a ready-to-use manager.
    pub fn new(app_handle: AppHandle<R>) -> Result<Self, AppError> {
        Self::with_storage_dir(app_handle, storage::default_storage_dir())
    }

    /// Same as [`Self::new`] but allows injecting a custom storage directory — used by
    /// integration tests so each test can operate in an isolated `tempdir`.
    pub fn with_storage_dir(
        app_handle: AppHandle<R>,
        storage_dir: PathBuf,
    ) -> Result<Self, AppError> {
        fs::create_dir_all(&storage_dir)?;
        let capacity = NonZeroUsize::new(CACHE_CAPACITY)
            .expect("CACHE_CAPACITY must be > 0; this is a compile-time invariant");
        Ok(Self {
            app_handle,
            storage_dir,
            cache: Mutex::new(LruCache::new(capacity)),
            sha_index: Mutex::new(LruCache::new(capacity)),
            insert_guard: Mutex::new(()),
        })
    }

    pub fn storage_dir(&self) -> &Path {
        &self.storage_dir
    }

    /// Canonical absolute asset path for a sha. Normalizes any sidecar's
    /// `meta.path` consistently (defends against legacy bare-filename sidecars
    /// and a relocated storage dir, and keeps every loader from drifting).
    fn asset_path_for(&self, sha256: &str) -> std::path::PathBuf {
        self.storage_dir.join(format!("{sha256}.png"))
    }

    /// Decode arbitrary `bytes` (PNG, JPEG, WebP, GIF, raw clipboard PNG, …), re-encode as a
    /// canonical PNG and persist it. Returns the resulting metadata; emits `image://added`.
    ///
    /// Deduplication: if the canonical PNG already exists on disk the original metadata is
    /// returned verbatim (no new ID generated, no event emitted again).
    pub fn add_from_bytes(&self, bytes: &[u8], source: ImageSource) -> Result<ImageMeta, AppError> {
        if bytes.is_empty() {
            return Err(AppError::InvalidInput("image bytes are empty".into()));
        }

        // Decode through a limit-aware reader so a crafted/oversized image can't
        // OOM-crash the app — cap the pixel-buffer allocation before it
        // materialises (paste/drop can carry arbitrary, untrusted image bytes).
        let mut reader = image::ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|e| AppError::other(format!("image format probe: {e}")))?;
        let mut limits = image::Limits::default();
        limits.max_alloc = Some(256 * 1024 * 1024);
        reader.limits(limits);
        let decoded = reader
            .decode()
            .map_err(|e| AppError::other(format!("image decode: {e}")))?;
        let width = decoded.width();
        let height = decoded.height();
        if width == 0 || height == 0 {
            return Err(AppError::InvalidInput("image has zero dimension".into()));
        }

        // Canonicalise as PNG. Lossless, decoder-agnostic — guarantees stable sha256 across
        // re-imports (a JPEG and its PNG re-export will *not* dedup, by design).
        let mut canonical = Vec::with_capacity(bytes.len());
        decoded
            .write_to(&mut Cursor::new(&mut canonical), ImageFormat::Png)
            .map_err(|e| AppError::other(format!("png encode: {e}")))?;

        let sha = storage::sha256_hex(&canonical);

        // Cheap path: known sha is in the in-memory index.
        if let Some(existing_id) = self.sha_index.lock().get(&sha).cloned() {
            if let Some(meta) = self.cache.lock().get(&existing_id).cloned() {
                debug!(target: "vibe_term::images", "dedup hit (cache) for {}", sha);
                return Ok((*meta).clone());
            }
        }

        // Serialize the dedup-or-create tail so two threads adding the SAME
        // bytes concurrently can't both miss the checks below and each mint a
        // distinct id (TOCTOU on the sidecar). Held across re-check → write →
        // cache → emit; unrelated adds are infrequent and sub-100ms so a single
        // global guard is acceptable and keeps the non-concurrent path identical.
        let _insert = self.insert_guard.lock();

        // Re-run the cheap cache check now that we hold the guard: a concurrent
        // insert of the same sha may have completed while we decoded/encoded.
        if let Some(existing_id) = self.sha_index.lock().get(&sha).cloned() {
            if let Some(meta) = self.cache.lock().get(&existing_id).cloned() {
                debug!(target: "vibe_term::images", "dedup hit (cache, guarded) for {}", sha);
                return Ok((*meta).clone());
            }
        }

        // Sidecar exists ⇒ image is already on disk; reuse its meta.
        if let Some(meta) = storage::read_sidecar(&self.storage_dir, &sha)? {
            debug!(target: "vibe_term::images", "dedup hit (sidecar) for {}", sha);
            self.cache_meta(Arc::new(meta.clone()));
            return Ok(meta);
        }

        // Fresh import: write PNG, build meta, persist sidecar, cache, emit.
        let abs_path = storage::write_png_dedup(&self.storage_dir, &sha, &canonical)?;
        let bytes_on_disk = canonical.len() as u64;
        let id = format!("img_{}", generate_short_id());
        let meta = ImageMeta {
            id: id.clone(),
            sha256: sha.clone(),
            // Store the FULL absolute path. External CLI consumers (claude
            // code, ripgrep, etc.) need an absolute filesystem path they can
            // open directly. Previously this was just the filename, which
            // was useless outside the storage_dir context.
            path: abs_path.to_string_lossy().into_owned(),
            mime: "image/png".into(),
            width,
            height,
            bytes: bytes_on_disk,
            source,
            ocr_text: None,
            created_at: now_ms(),
        };
        storage::write_sidecar(&self.storage_dir, &meta)?;
        let arc_meta = Arc::new(meta.clone());
        self.cache_meta(arc_meta);

        info!(
            target: "vibe_term::images",
            "added image {} ({}x{}, {} bytes, source={:?})",
            id, width, height, bytes_on_disk, source
        );
        if let Err(err) = self.app_handle.emit(
            events::IMAGE_ADDED,
            ImageAddedEvent {
                image_id: &meta.id,
                source: meta.source,
                w: meta.width,
                h: meta.height,
                bytes: meta.bytes,
            },
        ) {
            warn!(target: "vibe_term::images", "failed to emit image://added: {}", err);
        }

        Ok(meta)
    }

    /// Convenience: load a file and route through [`Self::add_from_bytes`].
    pub fn add_from_path(&self, path: &Path, source: ImageSource) -> Result<ImageMeta, AppError> {
        let bytes = fs::read(path)?;
        self.add_from_bytes(&bytes, source)
    }

    /// Look up an image by its public id (`img_xxxxxx`). Hits the cache first, then falls back
    /// to scanning every sidecar on disk (cold-start path; cheap because sidecars are tiny).
    pub fn get(&self, id: &str) -> Result<Option<ImageMeta>, AppError> {
        if let Some(meta) = self.cache.lock().get(id).cloned() {
            return Ok(Some((*meta).clone()));
        }
        // Cold path: walk the storage dir looking for sidecars whose JSON contains this id.
        // 64 cache slots are plenty in practice, this scan only runs after a restart.
        let entries = match fs::read_dir(&self.storage_dir) {
            Ok(rd) => rd,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err.into()),
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let raw = match fs::read(&path) {
                Ok(b) => b,
                Err(err) => {
                    warn!(target: "vibe_term::images", "failed to read sidecar {:?}: {}", path, err);
                    continue;
                }
            };
            let mut meta: ImageMeta = match serde_json::from_slice(&raw) {
                Ok(m) => m,
                Err(err) => {
                    warn!(target: "vibe_term::images", "malformed sidecar {:?}: {}", path, err);
                    continue;
                }
            };
            // Never build a path from an untrusted sha. A tampered sidecar
            // (`../`, absolute path) would otherwise turn read/delete into an
            // out-of-storage-dir primitive.
            if !is_valid_sha256(&meta.sha256) {
                warn!(target: "vibe_term::images", "sidecar {:?} has invalid sha256, skipping", path);
                continue;
            }
            meta.path = self.asset_path_for(&meta.sha256).to_string_lossy().into_owned();
            if meta.id == id {
                self.cache_meta(Arc::new(meta.clone()));
                return Ok(Some(meta));
            }
        }
        Ok(None)
    }

    /// Enumerate every persisted image by scanning the sidecar JSONs in the storage dir,
    /// newest-first (by `created_at`). Used to seed the image gallery at startup: the
    /// in-memory cache only holds images touched this session, whereas the sidecars are
    /// the durable record of everything ever captured/pasted/dropped.
    pub fn list_all(&self) -> Result<Vec<ImageMeta>, AppError> {
        let entries = match fs::read_dir(&self.storage_dir) {
            Ok(rd) => rd,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(err.into()),
        };
        let mut metas: Vec<ImageMeta> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let raw = match fs::read(&path) {
                Ok(b) => b,
                Err(err) => {
                    warn!(target: "vibe_term::images", "failed to read sidecar {:?}: {}", path, err);
                    continue;
                }
            };
            match serde_json::from_slice::<ImageMeta>(&raw) {
                Ok(mut meta) => {
                    // Reject tampered sidecars before their sha is interpolated
                    // into a path (see `is_valid_sha256` / get()).
                    if !is_valid_sha256(&meta.sha256) {
                        warn!(target: "vibe_term::images", "sidecar {:?} has invalid sha256, skipping", path);
                        continue;
                    }
                    meta.path =
                        self.asset_path_for(&meta.sha256).to_string_lossy().into_owned();
                    metas.push(meta);
                }
                Err(err) => {
                    warn!(target: "vibe_term::images", "malformed sidecar {:?}: {}", path, err);
                }
            }
        }
        // Newest first so the gallery surfaces the most recent screenshots on top.
        metas.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(metas)
    }

    /// Return the canonical PNG bytes for an image, reading them from disk on every call.
    pub fn read_bytes(&self, id: &str) -> Result<Vec<u8>, AppError> {
        let meta = self
            .get(id)?
            .ok_or_else(|| AppError::InvalidInput(format!("image {} not found", id)))?;
        let path = self.asset_path_for(&meta.sha256);
        Ok(fs::read(path)?)
    }

    /// Read the canonical PNG and return its base64-encoded form (no `data:` prefix).
    /// Useful for embedding into Markdown / multimodal AI payloads from the frontend.
    pub fn read_as_base64(&self, id: &str) -> Result<String, AppError> {
        let bytes = self.read_bytes(id)?;
        Ok(BASE64_STANDARD.encode(bytes))
    }

    /// Remove an image from disk + caches. Idempotent: deleting an unknown id is a no-op.
    pub fn delete(&self, id: &str) -> Result<(), AppError> {
        let meta = match self.get(id)? {
            Some(m) => m,
            None => return Ok(()),
        };
        storage::delete_assets(&self.storage_dir, &meta.sha256)?;
        self.cache.lock().pop(id);
        self.sha_index.lock().pop(&meta.sha256);
        debug!(target: "vibe_term::images", "deleted image {}", id);
        Ok(())
    }

    fn cache_meta(&self, meta: Arc<ImageMeta>) {
        self.sha_index
            .lock()
            .put(meta.sha256.clone(), meta.id.clone());
        self.cache.lock().put(meta.id.clone(), meta);
    }
}

/// Six characters from a lowercase alnum alphabet → 36^6 ≈ 2.1 billion combinations, which
/// is plenty for in-session uniqueness (collisions are recovered from gracefully at insert
/// time anyway because of the sha-based dedup).
fn generate_short_id() -> String {
    nanoid::nanoid!(6, &ID_ALPHABET)
}

/// True iff `s` is exactly 64 lowercase/mixed-case ASCII hex chars — the shape
/// every legitimately written sha256 has. Used to reject sidecar JSON whose
/// `sha256` field has been tampered with (`../`, absolute paths, …) before it
/// is ever interpolated into a filesystem path, neutralizing path traversal.
fn is_valid_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_else(|_| Utc::now().timestamp_millis())
}
