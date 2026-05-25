//! Tauri command surface exposed to the React frontend.
//!
//! Each command must also be declared in `tauri::generate_handler!` inside `lib.rs::run`.
//! Long-running work emits results via Tauri events (see `events.rs`) rather than blocking
//! the IPC reply, so the frontend stays responsive.

use serde::Serialize;

use crate::error::AppError;

#[derive(Debug, Serialize)]
pub struct AppInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub target_os: &'static str,
    pub target_arch: &'static str,
}

#[tauri::command]
pub async fn ping() -> Result<&'static str, AppError> {
    Ok("pong")
}

#[tauri::command]
pub async fn app_info() -> Result<AppInfo, AppError> {
    Ok(AppInfo {
        name: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
        target_os: std::env::consts::OS,
        target_arch: std::env::consts::ARCH,
    })
}
