//! Application state container shared between Tauri commands.
//!
//! Each feature manager (PTY, images, store, AI, OCR, config, hotkeys) is an `Arc` so the
//! frontend can invoke commands concurrently without blocking on a single lock.

use std::sync::Arc;
use tauri::AppHandle;

use crate::pty::PtyManager;

#[derive(Clone)]
pub struct AppState {
    pub app_handle: AppHandle,
    pub pty: Arc<PtyManager>,
}

impl AppState {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle: app_handle.clone(),
            pty: Arc::new(PtyManager::new(app_handle)),
        }
    }
}
