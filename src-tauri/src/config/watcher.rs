//! Filesystem watcher that hot-reloads `config.toml` into the running app.
//!
//! Design notes:
//! - We use `notify::RecommendedWatcher` (inotify on Linux, FSEvents on macOS,
//!   ReadDirectoryChanges on Windows) in `NonRecursive` mode on the *parent*
//!   directory. Watching the file directly is unreliable across editors that
//!   atomically replace it (write-to-temp + rename — vim, Sublime, JetBrains).
//! - A small debounce thread coalesces bursts of events: editors typically
//!   produce several create/modify pairs within a few ms when saving. We wait
//!   200ms of silence before re-reading the file.
//! - All work happens on a dedicated `std::thread`. We never park inside the
//!   notify event handler because backend threads vary across OSes and must
//!   stay responsive.
//! - The watcher handle is returned and stored on the `ConfigStore` so it
//!   stays alive for the app lifetime; dropping it would silently stop
//!   notifications.
//!
//! Errors during parsing emit a `config://parse_error` event so the frontend
//! can surface a toast. The previous (valid) settings remain in effect.

#![warn(clippy::all, rust_2018_idioms)]

use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use notify::{
    event::{EventKind, ModifyKind},
    Config, RecommendedWatcher, RecursiveMode, Watcher,
};
use parking_lot::RwLock;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::config::schema::Settings;
use crate::error::AppError;
use crate::events::CONFIG_CHANGED;

/// Event name emitted when the watcher fails to parse the on-disk file.
pub const CONFIG_PARSE_ERROR: &str = "config://parse_error";

/// How long to wait after the last filesystem event before re-reading the file.
const DEBOUNCE: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Serialize)]
pub struct ConfigParseError {
    pub message: String,
    pub path: String,
}

/// Spawn a watcher on `config.toml`'s parent directory. The returned
/// [`RecommendedWatcher`] must be kept alive for the watcher to keep firing —
/// store it on the `ConfigStore`.
pub fn spawn_watcher(
    path: PathBuf,
    store: Arc<RwLock<Settings>>,
    app_handle: AppHandle,
) -> Result<RecommendedWatcher, AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::other("config path has no parent directory"))?
        .to_path_buf();

    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = RecommendedWatcher::new(tx, Config::default())
        .map_err(|e| AppError::Other(format!("failed to create config watcher: {e}")))?;
    watcher
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|e| AppError::Other(format!("failed to watch {}: {e}", parent.display())))?;

    let watch_path = path.clone();
    thread::Builder::new()
        .name("vibe-term-config-watcher".to_string())
        .spawn(move || debounce_loop(rx, watch_path, store, app_handle))
        .map_err(|e| AppError::Other(format!("failed to spawn config watcher thread: {e}")))?;

    tracing::info!(path = %path.display(), "config watcher started");
    Ok(watcher)
}

fn debounce_loop(
    rx: mpsc::Receiver<notify::Result<notify::Event>>,
    target: PathBuf,
    store: Arc<RwLock<Settings>>,
    app_handle: AppHandle,
) {
    let mut last_change: Option<Instant> = None;

    loop {
        // Wait for the next event or, if we are debouncing, until the debounce
        // window elapses. `recv_timeout` returns `Err(Disconnected)` when the
        // notify watcher is dropped, which is our cue to exit cleanly.
        let timeout = match last_change {
            Some(t) => {
                let elapsed = t.elapsed();
                if elapsed >= DEBOUNCE {
                    handle_change(&target, &store, &app_handle);
                    last_change = None;
                    continue;
                }
                DEBOUNCE - elapsed
            }
            None => Duration::from_secs(60), // long park when nothing is pending
        };

        match rx.recv_timeout(timeout) {
            Ok(Ok(event)) => {
                if event_touches_target(&event, &target) && is_relevant_kind(&event.kind) {
                    last_change = Some(Instant::now());
                }
            }
            Ok(Err(err)) => {
                tracing::warn!(error = %err, "config watcher reported error");
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if last_change.is_some() {
                    handle_change(&target, &store, &app_handle);
                    last_change = None;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                tracing::debug!("config watcher channel disconnected; exiting");
                break;
            }
        }
    }
}

fn event_touches_target(event: &notify::Event, target: &Path) -> bool {
    if event.paths.is_empty() {
        // Backend doesn't expose paths (rare) — assume it's relevant.
        return true;
    }
    event.paths.iter().any(|p| paths_match(p, target))
}

fn paths_match(observed: &Path, target: &Path) -> bool {
    if observed == target {
        return true;
    }
    // Editors using rename-on-save may report a tempfile then rename to
    // `target`. Compare canonicalised paths when both exist.
    match (observed.canonicalize(), target.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => observed.file_name() == target.file_name(),
    }
}

fn is_relevant_kind(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Modify(ModifyKind::Any)
            | EventKind::Modify(ModifyKind::Data(_))
            | EventKind::Modify(ModifyKind::Name(_))
            | EventKind::Modify(ModifyKind::Other)
            | EventKind::Create(_)
            | EventKind::Any
    )
}

fn handle_change(target: &Path, store: &Arc<RwLock<Settings>>, app_handle: &AppHandle) {
    // Hold the write guard across the disk read + parse + swap so this
    // read-then-swap is serialized against `ConfigStore::update`'s
    // write-then-swap. Because `update` holds the lock across its own
    // `fs::write`, a watcher holding the lock is guaranteed to read disk no
    // older than the last completed update, closing the TOCTOU window where a
    // stale read could clobber a newer in-memory snapshot.
    let mut guard = store.write();

    let raw = match std::fs::read_to_string(target) {
        Ok(s) => s,
        Err(err) => {
            // The file may briefly disappear during atomic-save replace; log
            // and let the next event re-trigger us.
            tracing::warn!(path = %target.display(), error = %err, "config read failed");
            return;
        }
    };

    match Settings::from_toml_str(&raw) {
        Ok(parsed) => {
            *guard = parsed.clone();
            // Release the lock before crossing the Tauri IPC boundary.
            drop(guard);
            if let Err(err) = app_handle.emit(
                CONFIG_CHANGED,
                serde_json::json!({ "settings": &parsed }),
            ) {
                tracing::warn!(error = %err, "failed to emit config://changed event");
            } else {
                tracing::info!(path = %target.display(), "config hot-reloaded");
            }
        }
        Err(err) => {
            // Parse failed: keep the previous settings untouched and release
            // the lock before emitting.
            drop(guard);
            let payload = ConfigParseError {
                message: err.to_string(),
                path: target.display().to_string(),
            };
            tracing::error!(error = %err, "config parse failed; keeping previous settings");
            if let Err(emit_err) = app_handle.emit(CONFIG_PARSE_ERROR, &payload) {
                tracing::warn!(error = %emit_err, "failed to emit config://parse_error event");
            }
        }
    }
}
