//! PTY manager — owns spawned pseudo-terminal sessions and streams their output to the frontend.
//!
//! Each spawned session is keyed by a UUID v4 string and exposed to the frontend as a plain
//! `string`. The manager owns the [`PtySession`] map behind a `parking_lot::Mutex` (sync, fast,
//! no async overhead — PTY ops are non-blocking and protected by the inner [`portable_pty`] APIs)
//! and an `AppHandle` used to emit `pty://data` and `pty://exit` events.
//!
//! See `pty::session::PtySession` for the reader-thread lifecycle and `pty::shell` for shell
//! detection on each platform.

#![warn(clippy::all, rust_2018_idioms)]

use std::collections::HashMap;

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use ts_rs::TS;
use uuid::Uuid;

pub mod session;
pub mod shell;

use session::PtySession;

/// Stable identifier for a spawned PTY session — UUID v4 serialised as a string.
pub type PtyId = String;

/// Options supplied by the frontend when spawning a new PTY.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    /// Absolute path to the shell executable (e.g. `/bin/zsh`, `C:\\Program Files\\PowerShell\\7\\pwsh.exe`).
    pub shell: String,
    /// Arguments passed to the shell. Often empty for an interactive shell.
    pub args: Vec<String>,
    /// Working directory for the shell. Falls back to `$HOME` (or `%USERPROFILE%`) when `None`.
    pub cwd: Option<String>,
    /// Initial column count.
    pub cols: u16,
    /// Initial row count.
    pub rows: u16,
    /// Additional environment variables to set in the child process.
    /// Pairs are `(KEY, VALUE)` and override the inherited environment.
    pub env: Vec<(String, String)>,
}

/// Payload of the `pty://data` event — UTF-8 chunk decoded losslessly from the PTY master read.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct PtyDataEvent {
    pub pty_id: PtyId,
    pub data: String,
}

/// Payload of the `pty://exit` event — exit code is `None` when the child was killed by signal.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct PtyExitEvent {
    pub pty_id: PtyId,
    pub code: Option<i32>,
}

/// Owns the live map of [`PtySession`] handles and emits PTY events to the frontend.
pub struct PtyManager {
    app_handle: AppHandle,
    sessions: Mutex<HashMap<PtyId, PtySession>>,
}

impl PtyManager {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Spawn a new PTY, register it in the session map and start the reader thread.
    /// The spawn itself is a blocking syscall sequence but cheap (<10ms); we still mark
    /// the method `async` so the Tauri IPC layer keeps the main thread responsive.
    pub async fn spawn(&self, opts: SpawnOptions) -> Result<PtyId> {
        let id = Uuid::new_v4().to_string();
        let session = PtySession::spawn(id.clone(), opts, self.app_handle.clone())
            .with_context(|| format!("failed to spawn PTY session {id}"))?;

        let mut guard = self.sessions.lock();
        guard.insert(id.clone(), session);
        tracing::info!(pty_id = %id, "pty session spawned");
        Ok(id)
    }

    /// Write `data` to the PTY master. Returns `Err` if the id is unknown or the writer pipe is closed.
    pub fn write(&self, id: &str, data: &str) -> Result<()> {
        let mut guard = self.sessions.lock();
        let session = guard
            .get_mut(id)
            .ok_or_else(|| anyhow!("unknown pty id: {id}"))?;
        session.write(data.as_bytes())
    }

    /// Update the kernel-known winsize. Frontend should debounce these (~100ms) on Windows
    /// to avoid ConPTY corruption on rapid resize bursts (see plan section H.3).
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let guard = self.sessions.lock();
        let session = guard
            .get(id)
            .ok_or_else(|| anyhow!("unknown pty id: {id}"))?;
        session.resize(cols, rows)
    }

    /// Force-kill the child and remove the session from the map. The reader thread will exit
    /// on its next read (EIO/EOF) and emit `pty://exit` itself.
    pub fn kill(&self, id: &str) -> Result<()> {
        let mut guard = self.sessions.lock();
        let session = guard
            .remove(id)
            .ok_or_else(|| anyhow!("unknown pty id: {id}"))?;
        session.kill()?;
        drop(session); // explicit: trigger Drop which joins the reader with a short timeout
        tracing::info!(pty_id = %id, "pty session killed");
        Ok(())
    }
}
