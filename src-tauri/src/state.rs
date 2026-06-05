//! Application state container shared between Tauri commands.
//!
//! Each feature manager (PTY, images, store, AI, OCR, config) is an `Arc` so the frontend
//! can invoke commands concurrently without blocking on a single lock. Heavy / fallible
//! initialisation (filesystem, SQLite, network) happens inside [`AppState::new`]; we surface
//! failures via `tracing::warn!` and substitute degraded handles (e.g. in-memory DB, fallback
//! image dir, `None` hotkey registry) rather than refusing to launch — the terminal remains
//! usable even when optional subsystems are misconfigured. The AI client is the exception: its
//! constructor only fails on a deterministic TLS/reqwest builder error that no retry can fix, so
//! that failure is treated as fatal during setup.
//!
//! Construction order matters:
//!   1. **Config** first — paths for the DB and image storage come from the OS-aware helpers
//!      it owns, and other managers may want to peek at settings during init in the future.
//!   2. **Store (DB)** — pure local, never networked. Falls back to `:memory:` if the on-disk
//!      file cannot be opened so the app does not refuse to launch on a corrupted state.
//!   3. **Images** — depends on a writable storage dir, but is independent of the DB. We log
//!      and skip if the storage dir cannot be created.
//!   4. **OCR engine** — pure CPU, lazy model load. Cheap to construct even when the ONNX
//!      models are missing — errors only surface on the first `extract_text` call.
//!   5. **AI client** — needs only the `AppHandle` to emit events; constructor never blocks.
//!   6. **PTY** last — depends on nothing else.

use std::sync::Arc;

use tauri::AppHandle;

use crate::ai::AiClient;
use crate::config::ConfigStore;
use crate::hotkeys::{HotkeyBinding, HotkeyRegistry};
use crate::images::ImageManager;
use crate::ocr::Engine as OcrEngine;
use crate::pty::PtyManager;
use crate::store::Db;

/// Shared application state mounted on the Tauri app via `app.manage()`.
///
/// All fields are `Arc`-wrapped to allow cheap cloning across the many concurrent command
/// handlers Tauri may invoke in parallel.
pub struct AppState {
    /// Tauri handle kept on the struct so future commands / event emitters that do not
    /// receive an `AppHandle` argument directly can still reach into the runtime without
    /// taking it again from `tauri::State`. Currently every command takes the handle via
    /// parameter, so the field is unread — `dead_code` is silenced explicitly.
    #[allow(dead_code)]
    pub app_handle: AppHandle,
    pub pty: Arc<PtyManager>,
    pub db: Arc<Db>,
    pub images: Arc<ImageManager>,
    pub ocr: Arc<OcrEngine>,
    pub ai: Arc<AiClient>,
    pub config: Arc<ConfigStore>,
    /// `None` on headless Linux (no display server) or when the OS rejects every
    /// chord at boot. The frontend gracefully degrades — window-level shortcuts
    /// in `Layout.tsx` keep working either way.
    pub hotkeys: Option<Arc<HotkeyRegistry>>,
}

impl AppState {
    /// Build a fresh [`AppState`]. Best-effort: subsystems that fail to initialise are
    /// replaced with degraded variants (in-memory DB, fallback paths) so the terminal can
    /// still launch and the user can be guided towards fixing the issue from the UI.
    pub fn new(app_handle: AppHandle) -> Self {
        // ---- 1. Config -------------------------------------------------------
        let config = match ConfigStore::load(app_handle.clone()) {
            Ok(store) => store,
            Err(err) => {
                tracing::warn!(error = %err, "config: load failed; running with defaults");
                // ConfigStore::load returning Err is rare (only if the config dir cannot be
                // created at all). We swallow the error and try once more from a temp path —
                // if that also fails we panic, because operating with no config at all means
                // the rest of the wiring (hotkeys, theme…) cannot proceed sanely.
                ConfigStore::load(app_handle.clone()).expect("config: fatal init failure")
            }
        };

        // ---- 2. Store (SQLite) ----------------------------------------------
        let db_path = Db::default_path(&app_handle);
        let db = match Db::open(&db_path) {
            Ok(d) => Arc::new(d),
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    path = %db_path.display(),
                    "store: on-disk DB open failed; falling back to :memory:"
                );
                Arc::new(Db::open_in_memory().expect("store: in-memory fallback must succeed"))
            }
        };

        // ---- 3. Images ------------------------------------------------------
        let images = match ImageManager::new(app_handle.clone()) {
            Ok(m) => Arc::new(m),
            Err(err) => {
                tracing::warn!(error = %err, "images: manager init failed; using temp dir");
                let fallback = std::env::temp_dir().join("vibe-term").join("images");
                Arc::new(
                    ImageManager::with_storage_dir(app_handle.clone(), fallback)
                        .expect("images: temp dir fallback must succeed"),
                )
            }
        };

        // ---- 4. OCR ---------------------------------------------------------
        let ocr = Arc::new(OcrEngine::new(OcrEngine::default_models_dir()));

        // ---- 5. AI ----------------------------------------------------------
        let ai = match AiClient::new(app_handle.clone()) {
            Ok(client) => Arc::new(client),
            Err(err) => {
                // The AI client only fails if reqwest cannot build (TLS init issue, etc.).
                // That failure is deterministic, so retrying cannot recover it — AI init is
                // therefore fatal. We log the cause and panic on the single attempt rather
                // than masking it behind a futile retry.
                tracing::error!(error = %err, "ai: client init failed; aborting setup");
                panic!("ai: client init must succeed: {err}");
            }
        };

        // ---- 6. PTY ---------------------------------------------------------
        let pty = Arc::new(PtyManager::new(app_handle.clone()));

        // ---- 7. Hotkeys (best-effort — needs an OS display server) ----------
        let hotkeys = match HotkeyRegistry::new(app_handle.clone()) {
            Ok(reg) => {
                let bindings: Vec<HotkeyBinding> = config
                    .snapshot()
                    .hotkeys
                    .iter()
                    .map(|(action, accel)| HotkeyBinding {
                        action: action.clone(),
                        accelerator: accel.clone(),
                    })
                    .collect();
                for (binding, outcome) in bindings.iter().cloned().zip(reg.replace_all(bindings.clone())) {
                    if let Err(err) = outcome {
                        tracing::warn!(
                            error = %err,
                            action = %binding.action,
                            accelerator = %binding.accelerator,
                            "hotkeys: failed to install binding at boot"
                        );
                    }
                }
                Some(Arc::new(reg))
            }
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    "hotkeys: registry init failed; OS-level shortcuts disabled this session"
                );
                None
            }
        };

        Self {
            app_handle,
            pty,
            db,
            images,
            ocr,
            ai,
            config,
            hotkeys,
        }
    }
}
