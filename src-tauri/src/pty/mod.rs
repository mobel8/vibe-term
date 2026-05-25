//! PTY manager — owns spawned pseudo-terminal sessions and streams their output to the frontend.
//!
//! Phase 1 will replace the stubbed implementation with `portable-pty` backed sessions, a
//! per-session reader task that publishes `events::PTY_DATA`, and full lifecycle handling
//! (resize, write, kill, exit).

use tauri::AppHandle;

#[allow(dead_code)]
pub struct PtyManager {
    app_handle: AppHandle,
}

impl PtyManager {
    pub fn new(app_handle: AppHandle) -> Self {
        Self { app_handle }
    }
}
