//! vibe-term — modern cross-platform terminal with native image support and integrated AI.
//!
//! This library wires up the Tauri application: plugins, state, IPC commands, and event handlers.
//! Module-level features (PTY backend, image manager, SQLite store, AI client, OCR, config)
//! are implemented in their respective submodules and exposed via the `commands` module.

#![warn(clippy::all, rust_2018_idioms)]

use tauri::Manager;

mod commands;
mod error;
// Event-name constants — some are emitted from feature modules, others are reserved for
// frontend listeners that don't have a Rust call site yet (PTY_BELL, HOTKEY_TRIGGERED, …).
// Suppress dead-code warnings at the module level so a `-D warnings` clippy build doesn't
// regress until every event has a backend emitter.
#[allow(dead_code)]
mod events;
mod state;

// Feature modules — each owns a manager type stored in `state::AppState` and a set of Tauri
// commands re-exported from `commands::*`. `pub` so the integration tests under
// `tests/rust/` can exercise the typed surface as a regular downstream crate.
pub mod ai;
pub mod config;
pub mod export;
pub mod hotkeys;
pub mod images;
pub mod ocr;
mod pty;
pub mod store;

pub use error::AppError;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,vibe_term_lib=debug"));
    tracing_subscriber::fmt().with_env_filter(env_filter).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let app_state = state::AppState::new(app.handle().clone());
            app.manage(app_state);
            tracing::info!("vibe-term initialised");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Misc
            commands::ping,
            commands::app_info,
            commands::data_paths,
            // PTY
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::detect_shells,
            commands::default_shell,
            // Sessions / blocks / search
            commands::session_create,
            commands::session_list,
            commands::session_get,
            commands::session_rename,
            commands::session_touch,
            commands::session_delete,
            commands::block_append,
            commands::block_list,
            commands::block_count,
            commands::search_fts,
            commands::search_images_fts,
            // Images / screenshot / OCR
            commands::image_from_clipboard,
            commands::image_from_path,
            commands::image_from_bytes,
            commands::image_get,
            commands::image_read_base64,
            commands::image_delete,
            commands::screenshot_capture,
            commands::list_monitors,
            commands::ocr_extract,
            // DB image registry helpers
            commands::db_image_create,
            commands::db_image_get,
            commands::db_image_list,
            commands::db_image_set_ocr,
            commands::db_image_attach_to_block,
            // AI
            commands::ai_send,
            commands::ai_stop,
            commands::ai_set_api_key,
            commands::ai_has_api_key,
            commands::ai_delete_api_key,
            commands::ai_api_key_preview,
            commands::ai_conversation_create,
            commands::ai_conversation_list,
            commands::ai_exchange_append,
            commands::ai_exchange_list,
            // Config
            commands::config_get,
            commands::config_update,
            commands::config_path,
            // Hotkeys (Phase 7 — global OS-level)
            commands::hotkey_register,
            commands::hotkey_unregister,
            commands::hotkey_replace_all,
            commands::hotkey_list,
            // Export (Phase 5 — session → Markdown/HTML)
            commands::export_session,
            commands::export_session_to_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running vibe-term");
}
