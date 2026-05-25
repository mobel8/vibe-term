//! vibe-term — modern cross-platform terminal with native image support and integrated AI.
//!
//! This library wires up the Tauri application: plugins, state, IPC commands, and event handlers.
//! Module-level features (PTY backend, image manager, SQLite store, AI client, OCR, config, hotkeys)
//! are implemented in their respective submodules and exposed via the `commands` module.

#![warn(clippy::all, rust_2018_idioms)]

use tauri::Manager;

mod commands;
mod error;
mod events;
mod state;

// Feature modules — filled phase by phase per the implementation roadmap.
// Each module exposes a manager type stored in `state::AppState` and a set of
// Tauri commands re-exported from `commands::*`.
mod pty;

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
        .invoke_handler(tauri::generate_handler![commands::ping, commands::app_info,])
        .run(tauri::generate_context!())
        .expect("error while running vibe-term");
}
