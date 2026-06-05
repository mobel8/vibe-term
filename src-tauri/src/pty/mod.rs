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
use std::io::Write;

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

/// Payload of the `pty://bell` event — emitted when a BEL (0x07) appears in PTY output.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct PtyBellEvent {
    pub pty_id: PtyId,
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
    ///
    /// We clone the target pane's writer handle while holding the global `sessions`
    /// lock, then RELEASE that lock before the (potentially blocking) write+flush.
    /// This way a write that blocks on a slow/full pipe (a slow SSH pane, a large
    /// paste flush) only holds that pane's own writer mutex — it no longer stalls
    /// keystroke echo / resize / spawn in every OTHER pane. Same-pane writes still
    /// serialise on the per-pane mutex, so byte order is preserved (no scramble).
    pub fn write(&self, id: &str, data: &str) -> Result<()> {
        let writer = {
            let guard = self.sessions.lock();
            guard
                .get(id)
                .ok_or_else(|| anyhow!("unknown pty id: {id}"))?
                .writer_arc()
        };
        let mut w = writer.lock();
        w.write_all(data.as_bytes())
            .with_context(|| format!("write failed on pty {id}"))?;
        w.flush()
            .with_context(|| format!("flush failed on pty {id}"))?;
        Ok(())
    }

    /// OS pid of the shell spawned for `id`, if known. Used to detect an `ssh`
    /// child process for remote image paste.
    pub fn child_pid(&self, id: &str) -> Option<u32> {
        let guard = self.sessions.lock();
        guard.get(id).and_then(|s| s.child_pid())
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
        // Take the session OUT under the lock, then release the lock BEFORE
        // killing/dropping it. `PtySession::Drop` busy-waits up to ~500ms joining
        // the reader thread — holding the global `sessions` lock across that would
        // freeze keystroke echo / resize / spawn in EVERY other pane on each tab
        // close. Neither kill, Drop, the reader, nor the flusher touch
        // `PtyManager::sessions`, so releasing first is deadlock-free.
        let session = {
            let mut guard = self.sessions.lock();
            guard
                .remove(id)
                .ok_or_else(|| anyhow!("unknown pty id: {id}"))?
        };
        session.kill()?;
        drop(session); // trigger Drop (reader join) lock-free
        tracing::info!(pty_id = %id, "pty session killed");
        Ok(())
    }
}
