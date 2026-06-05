//! Configuration subsystem — TOML file on disk, in-memory `Settings` snapshot,
//! and a background watcher that hot-reloads changes through a Tauri event.
//!
//! Architecture:
//!
//! ```text
//!   ┌────────────────┐     load()      ┌─────────────────────────────┐
//!   │ config.toml on │ ──────────────▶ │ Settings (Arc<RwLock<…>>)   │
//!   │ disk           │                 │ + RecommendedWatcher handle │
//!   └────────────────┘ ◀───────────── └─────────────────────────────┘
//!         ▲                update()           │
//!         │                                   │ emit("config://changed", Settings)
//!         │ notify event                      ▼
//!         └────────────── debounce 200ms ──── frontend listens
//! ```
//!
//! `ConfigStore::load` is the single entry point: it bootstraps the file from
//! the bundled `default_config.toml` on first run, parses the on-disk version,
//! and spawns the watcher. Callers store the resulting `Arc<ConfigStore>` on
//! `AppState` and expose `snapshot` / `update` / `path` through Tauri commands.

#![warn(clippy::all, rust_2018_idioms)]

mod paths;
mod schema;
mod watcher;

use std::path::PathBuf;
use std::sync::Arc;

use notify::RecommendedWatcher;
use parking_lot::{Mutex, RwLock};
use tauri::{AppHandle, Emitter};

use crate::error::AppError;

pub use paths::{config_dir, config_path, ensure_config_dir};
pub use schema::{
    default_hotkeys, AiProvider, AiSettings, AppearanceSettings, CursorStyle, GeneralSettings,
    Settings, TerminalSettings,
};
pub use watcher::{ConfigParseError, CONFIG_PARSE_ERROR};

/// Bundled bootstrap file written to disk the first time the app launches.
const DEFAULT_CONFIG_TOML: &str = include_str!("default_config.toml");

/// Shared configuration handle stored on `AppState`. Cloning is cheap (it is
/// just `Arc` bumps); cloning the inner `Settings` requires a `.snapshot()`.
pub struct ConfigStore {
    current: Arc<RwLock<Settings>>,
    path: PathBuf,
    app_handle: AppHandle,
    /// Watcher handle — kept alive solely so notify keeps firing events.
    /// Wrapped in `Mutex` to give us interior mutability if we ever need to
    /// rebuild it (e.g. user moves the config file).
    _watcher: Mutex<Option<RecommendedWatcher>>,
}

impl ConfigStore {
    /// Load (or bootstrap) the config file, populate the in-memory snapshot,
    /// and start the hot-reload watcher.
    pub fn load(app_handle: AppHandle) -> Result<Arc<Self>, AppError> {
        let dir = ensure_config_dir()?;
        let path = dir.join("config.toml");

        let settings = if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(raw) => Settings::from_toml_str(&raw).unwrap_or_else(|err| {
                    tracing::warn!(
                        error = %err,
                        path = %path.display(),
                        "failed to parse config, falling back to defaults"
                    );
                    Settings::default()
                }),
                Err(err) => {
                    tracing::warn!(
                        error = %err,
                        path = %path.display(),
                        "failed to read config, falling back to defaults"
                    );
                    Settings::default()
                }
            }
        } else {
            tracing::info!(path = %path.display(), "no config found, writing default");
            std::fs::write(&path, DEFAULT_CONFIG_TOML).map_err(|e| {
                AppError::Other(format!(
                    "failed to write default config to {}: {e}",
                    path.display()
                ))
            })?;
            // Re-parse so that the in-memory shape matches what's on disk.
            Settings::from_toml_str(DEFAULT_CONFIG_TOML).unwrap_or_default()
        };

        let current = Arc::new(RwLock::new(settings));
        let watcher =
            match watcher::spawn_watcher(path.clone(), Arc::clone(&current), app_handle.clone()) {
                Ok(w) => Some(w),
                Err(err) => {
                    tracing::warn!(error = %err, "config watcher unavailable; hot-reload disabled");
                    None
                }
            };

        Ok(Arc::new(Self {
            current,
            path,
            app_handle,
            _watcher: Mutex::new(watcher),
        }))
    }

    /// Snapshot of the current settings. Cheap clone of the typed struct.
    pub fn snapshot(&self) -> Settings {
        self.current.read().clone()
    }

    /// Path to the on-disk `config.toml`.
    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    /// Apply a JSON patch on top of the current settings, persist the result,
    /// and update the in-memory snapshot. Returns the new settings on success.
    ///
    /// The watcher will *also* observe the resulting write and fire
    /// `config://changed`; the duplicate is intentional and lets us keep one
    /// single source of truth for change notification on the frontend.
    pub fn update(&self, patch: serde_json::Value) -> Result<Settings, AppError> {
        // Hold ONE write lock across the whole read-modify-write-persist-swap so
        // concurrent updates can't clobber each other (the old code released the
        // read lock before computing/writing → a lost-update race where the last
        // writer overwrote a sibling-section edit). parking_lot RwLock is
        // non-reentrant, but neither apply_patch nor to_toml_string re-locks.
        let next = {
            let mut guard = self.current.write();
            // Merge against the *current on-disk* state rather than the possibly
            // stale in-memory snapshot: the watcher only refreshes `current`
            // after its 200ms debounce, so an external hand-edit (or a second
            // window) made just before this update would otherwise be silently
            // clobbered. Re-reading happens under the held write lock so it stays
            // atomic w.r.t. other update() calls, and neither read_to_string nor
            // from_toml_str re-locks `current`, so there is no reentrancy
            // deadlock. Fall back to the in-memory guard on read/parse failure.
            let base = std::fs::read_to_string(&self.path)
                .ok()
                .and_then(|raw| Settings::from_toml_str(&raw).ok())
                .unwrap_or_else(|| guard.clone());
            let next = base.apply_patch(patch)?;
            let serialised = next.to_toml_string()?;
            // Write atomically: a plain fs::write truncates then rewrites in
            // place, so a crash/disk-full mid-write would leave config.toml
            // empty/truncated and silently reset all settings on next launch.
            // Serialise to a sibling temp file, fsync it, then rename over the
            // target — rename atomically replaces the file on Windows/macOS/Linux
            // and can never leave a truncated config.toml. (The watcher already
            // tolerates this temp-then-rename pattern, like vim/JetBrains.)
            let tmp = self.path.with_extension("toml.tmp");
            {
                use std::io::Write as _;
                let mut file = std::fs::File::create(&tmp).map_err(|e| {
                    AppError::Other(format!(
                        "failed to create temp config {}: {e}",
                        tmp.display()
                    ))
                })?;
                file.write_all(serialised.as_bytes()).map_err(|e| {
                    AppError::Other(format!(
                        "failed to write temp config {}: {e}",
                        tmp.display()
                    ))
                })?;
                file.sync_all().map_err(|e| {
                    AppError::Other(format!("failed to fsync temp config {}: {e}", tmp.display()))
                })?;
            }
            std::fs::rename(&tmp, &self.path).map_err(|e| {
                AppError::Other(format!(
                    "failed to persist config to {}: {e}",
                    self.path.display()
                ))
            })?;
            *guard = next.clone();
            next
        };
        // Best-effort: surface the change immediately even if the watcher is
        // slow to debounce. Errors here are non-fatal.
        if let Err(err) = self.app_handle.emit(
            crate::events::CONFIG_CHANGED,
            serde_json::json!({ "settings": &next }),
        ) {
            tracing::warn!(error = %err, "failed to emit config://changed after update");
        }
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_default_toml_parses_into_settings() {
        let parsed = Settings::from_toml_str(DEFAULT_CONFIG_TOML)
            .expect("bundled default_config.toml must parse cleanly");
        // Sanity-check a handful of fields against the defaults.
        assert_eq!(parsed.appearance.theme, "dark");
        assert_eq!(parsed.appearance.font_family, "JetBrains Mono");
        assert_eq!(parsed.general.scrollback_lines, 10_000);
        assert!(parsed.hotkeys.contains_key("new_tab"));
        assert!(parsed.hotkeys.contains_key("command_palette"));
    }
}
