//! Platform-aware resolver for the config directory and `config.toml` path.
//!
//! We deliberately do not delegate fully to `dirs::config_dir()` on macOS /
//! Windows because the convention for our app is to use the *bundle identifier*
//! (`com.vibeterm.app`) instead of the friendly product name:
//!
//! - **Linux**: `$XDG_CONFIG_HOME/vibe-term`, falling back to `~/.config/vibe-term`.
//! - **macOS**: `~/Library/Application Support/com.vibeterm.app`.
//! - **Windows**: `%APPDATA%\com.vibeterm.app`.
//!
//! The bundle identifier matches `tauri.conf.json::identifier`, which keeps
//! us aligned with what Tauri plugins (`tauri-plugin-window-state`, etc.) use
//! for their own scratch directories.

#![warn(clippy::all, rust_2018_idioms)]

use std::path::PathBuf;

use crate::error::AppError;

/// macOS / Windows bundle identifier (must match `tauri.conf.json`).
const BUNDLE_ID: &str = "com.vibeterm.app";
/// Linux-friendly directory name under `$XDG_CONFIG_HOME`.
const LINUX_DIR: &str = "vibe-term";
/// Filename inside the config dir.
const CONFIG_FILE: &str = "config.toml";

/// Resolve the directory holding the user's `config.toml`. The directory may
/// not exist yet — callers should pair this with [`ensure_config_dir`] before
/// reading or writing.
pub fn config_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        // dirs::config_dir() on macOS already points at ~/Library/Application Support
        if let Some(base) = dirs::config_dir() {
            return base.join(BUNDLE_ID);
        }
    } else if cfg!(target_os = "windows") {
        // dirs::config_dir() on Windows -> %APPDATA% (Roaming)
        if let Some(base) = dirs::config_dir() {
            return base.join(BUNDLE_ID);
        }
    } else if let Some(base) = dirs::config_dir() {
        // Linux + other Unixes: XDG_CONFIG_HOME or ~/.config
        return base.join(LINUX_DIR);
    }

    // Last-ditch fallback when no home dir is detectable (sandboxed builds,
    // misconfigured headless CI). A relative path keeps things working in
    // ephemeral environments — every callsite logs the resolved location.
    PathBuf::from(".vibe-term")
}

/// Full path to `config.toml`. Does not check existence.
pub fn config_path() -> PathBuf {
    config_dir().join(CONFIG_FILE)
}

/// Create the config directory (recursively) if missing. Returns the resolved
/// path on success.
pub fn ensure_config_dir() -> Result<PathBuf, AppError> {
    let dir = config_dir();
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| {
            AppError::Other(format!(
                "failed to create config directory {}: {e}",
                dir.display()
            ))
        })?;
        tracing::info!(path = %dir.display(), "created config directory");
    }
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_path_ends_with_toml_file() {
        let path = config_path();
        assert_eq!(path.file_name().and_then(|s| s.to_str()), Some(CONFIG_FILE));
    }

    #[test]
    fn config_dir_has_app_specific_segment() {
        let dir = config_dir();
        let s = dir.to_string_lossy().to_lowercase();
        // Either the Linux dir or the bundle id should appear.
        assert!(
            s.contains(LINUX_DIR) || s.contains(BUNDLE_ID),
            "config_dir() did not contain an app-specific segment: {dir:?}"
        );
    }
}
