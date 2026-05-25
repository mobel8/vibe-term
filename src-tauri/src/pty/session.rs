//! A live PTY session: owns the `portable-pty` master/slave handles, the spawned child,
//! the writer pipe, and a dedicated OS thread that pumps reads into Tauri events.
//!
//! Design notes:
//! - The reader is a **blocking** `std::thread` (not a tokio task) because `MasterPty::try_clone_reader`
//!   returns a `Box<dyn std::io::Read + Send>` with no async support, and offloading the blocking read
//!   to a tokio worker via `spawn_blocking` would pin the runtime.
//! - We keep an `Arc<AtomicBool>` "alive" flag so that `Drop`/`kill` can signal the reader to stop
//!   gracefully; the reader also exits naturally on EOF/EIO once the child closes its end.
//! - The child is killed in `Drop` to guarantee no zombie processes when the manager forgets
//!   the session (e.g. window close path).

#![warn(clippy::all, rust_2018_idioms)]

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};

use crate::events::{PTY_DATA, PTY_EXIT};
use crate::pty::{PtyDataEvent, PtyExitEvent, PtyId, SpawnOptions};

/// Maximum time we wait for the reader thread to drain & exit when the session is dropped.
/// Beyond this we abandon the handle (thread will exit when the OS reclaims the fd anyway).
const READER_JOIN_TIMEOUT: Duration = Duration::from_millis(500);

/// Read buffer size — 8 KiB is a sweet spot for terminal output (matches a typical `cat` stride
/// and stays under TCP-ish MTUs for the IPC event payloads).
const READ_BUFFER_SIZE: usize = 8 * 1024;

pub struct PtySession {
    id: PtyId,
    /// Master end — used for resize and to keep the master fd alive while the session lives.
    /// Behind a Mutex because `resize` may run concurrently with the reader thread on some
    /// portable-pty backends (ConPTY in particular).
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    /// The writer half of the master. `take_writer()` may only be called once per master, so we
    /// hold the boxed writer forever and serialise writes through a mutex.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// Handle to the spawned child — wrapped to allow `kill()` to mutate it from any thread.
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    /// Independent killer cloned from the child so we can SIGKILL without blocking on a
    /// `.wait()` happening on the reader thread.
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Set to false by `kill` / `Drop` to signal the reader thread to stop ASAP.
    alive: Arc<AtomicBool>,
    /// Reader thread join handle — taken in `Drop` to join with a timeout.
    reader: Option<thread::JoinHandle<()>>,
}

impl PtySession {
    /// Spawn a new PTY with the supplied options and kick off the reader thread.
    pub fn spawn(id: PtyId, opts: SpawnOptions, app_handle: AppHandle) -> Result<Self> {
        if opts.shell.trim().is_empty() {
            return Err(anyhow!("spawn options: shell path is empty"));
        }
        if opts.cols == 0 || opts.rows == 0 {
            return Err(anyhow!(
                "spawn options: cols and rows must be > 0 (got cols={}, rows={})",
                opts.cols,
                opts.rows
            ));
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: opts.rows,
                cols: opts.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("openpty failed")?;

        let mut cmd = CommandBuilder::new(&opts.shell);
        for arg in &opts.args {
            cmd.arg(arg);
        }

        // Resolve cwd: explicit -> $HOME -> let the child inherit ours as last resort.
        let cwd = opts
            .cwd
            .clone()
            .or_else(|| dirs::home_dir().map(|p| p.to_string_lossy().into_owned()));
        if let Some(cwd) = cwd {
            cmd.cwd(cwd);
        }

        // Sensible defaults so TUIs (vim, htop, fzf) render colours correctly. The frontend
        // can still override these via `opts.env`.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for (key, value) in &opts.env {
            cmd.env(key, value);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .with_context(|| format!("spawn_command failed for shell {}", opts.shell))?;

        // Drop the slave before reading: keeping it open prevents EOF detection on the master
        // when the child exits (the slave fd would still hold the pty open from kernel POV).
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .context("master.take_writer() failed")?;
        let reader_handle = pair
            .master
            .try_clone_reader()
            .context("master.try_clone_reader() failed")?;

        let killer = child.clone_killer();

        let master = Arc::new(Mutex::new(pair.master));
        let writer = Arc::new(Mutex::new(writer));
        let child = Arc::new(Mutex::new(child));
        let alive = Arc::new(AtomicBool::new(true));

        let reader = spawn_reader_thread(
            id.clone(),
            reader_handle,
            child.clone(),
            alive.clone(),
            app_handle,
        );

        Ok(Self {
            id,
            master,
            writer,
            child,
            killer,
            alive,
            reader: Some(reader),
        })
    }

    /// Write bytes to the PTY master. May block briefly on a full pipe, but never long enough
    /// to warrant async on a desktop interactive terminal.
    pub fn write(&mut self, data: &[u8]) -> Result<()> {
        let mut writer = self.writer.lock();
        writer
            .write_all(data)
            .with_context(|| format!("write failed on pty {}", self.id))?;
        writer
            .flush()
            .with_context(|| format!("flush failed on pty {}", self.id))?;
        Ok(())
    }

    /// Resize the PTY. Frontend must debounce on Windows (ConPTY race — see plan H.3).
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        if cols == 0 || rows == 0 {
            return Err(anyhow!(
                "resize: cols and rows must be > 0 (got cols={cols}, rows={rows})"
            ));
        }
        let master = self.master.lock();
        master
            .resize(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .with_context(|| format!("resize failed on pty {}", self.id))?;
        tracing::debug!(pty_id = %self.id, cols, rows, "pty resized");
        Ok(())
    }

    /// Force-kill the child. Subsequent reads will hit EOF and the reader will emit `pty://exit`.
    pub fn kill(&self) -> Result<()> {
        self.alive.store(false, Ordering::SeqCst);
        // We use the cloned killer rather than locking `child` to avoid deadlocking with the
        // reader thread that holds `child.lock()` during its terminal `.wait()` call.
        let mut killer = self.killer.clone_killer();
        killer
            .kill()
            .with_context(|| format!("kill failed on pty {}", self.id))?;
        tracing::debug!(pty_id = %self.id, "pty kill signal sent");
        Ok(())
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // Signal the reader to stop, then best-effort kill the child. We *don't* propagate
        // errors here — `Drop` runs even when the manager already removed the session, and
        // double-kill is harmless.
        self.alive.store(false, Ordering::SeqCst);
        if let Err(err) = self.killer.kill() {
            tracing::debug!(pty_id = %self.id, error = %err, "drop: kill returned error (likely already exited)");
        }

        if let Some(handle) = self.reader.take() {
            // We can't `join_timeout` directly on a JoinHandle, so we spin briefly. If the
            // thread is wedged in a blocking read against an fd that didn't EOF, we just
            // forget it — the OS will reap the fd when the master Arc drops below.
            let start = Instant::now();
            while !handle.is_finished() {
                if start.elapsed() >= READER_JOIN_TIMEOUT {
                    tracing::warn!(
                        pty_id = %self.id,
                        "reader thread did not exit within {}ms; abandoning handle",
                        READER_JOIN_TIMEOUT.as_millis()
                    );
                    return;
                }
                thread::sleep(Duration::from_millis(10));
            }
            if let Err(panic) = handle.join() {
                tracing::error!(pty_id = %self.id, ?panic, "reader thread panicked");
            }
        }
    }
}

/// Spawn the blocking reader thread. The thread:
///   1. Reads up to `READ_BUFFER_SIZE` bytes per iteration.
///   2. Emits a `pty://data` event for each non-empty chunk (UTF-8 lossy decode).
///   3. On EOF / read error / `alive == false`, blocks on `child.wait()` and emits `pty://exit`.
fn spawn_reader_thread(
    id: PtyId,
    mut reader: Box<dyn Read + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    alive: Arc<AtomicBool>,
    app_handle: AppHandle,
) -> thread::JoinHandle<()> {
    thread::Builder::new()
        .name(format!("pty-reader-{id}"))
        .spawn(move || {
            let mut buf = vec![0u8; READ_BUFFER_SIZE];
            loop {
                if !alive.load(Ordering::SeqCst) {
                    tracing::debug!(pty_id = %id, "reader: alive flag cleared, breaking");
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => {
                        tracing::debug!(pty_id = %id, "reader: EOF on master");
                        break;
                    }
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                        let payload = PtyDataEvent {
                            pty_id: id.clone(),
                            data: chunk,
                        };
                        if let Err(err) = app_handle.emit(PTY_DATA, payload) {
                            // Webview gone (window closed) -> emit fails. Treat as EOF.
                            tracing::warn!(pty_id = %id, error = %err, "emit pty://data failed; stopping reader");
                            break;
                        }
                    }
                    Err(err) => {
                        // On Unix, a killed child manifests as EIO. On Windows ConPTY, BrokenPipe.
                        // Either way we treat it as terminal and proceed to wait().
                        tracing::debug!(pty_id = %id, error = %err, "reader: read error, exiting loop");
                        break;
                    }
                }
            }

            // Reap the exit status. `wait` blocks until the child is fully reaped; on Drop
            // paths the kill has already been issued, so this returns quickly.
            let exit_code = {
                let mut guard = child.lock();
                match guard.wait() {
                    Ok(status) => {
                        let code = status.exit_code() as i32;
                        if status.success() {
                            tracing::info!(pty_id = %id, code, "pty child exited normally");
                        } else if let Some(sig) = status.signal() {
                            tracing::info!(pty_id = %id, signal = sig, "pty child terminated by signal");
                        } else {
                            tracing::info!(pty_id = %id, code, "pty child exited with non-zero code");
                        }
                        Some(code)
                    }
                    Err(err) => {
                        tracing::warn!(pty_id = %id, error = %err, "child.wait() failed");
                        None
                    }
                }
            };

            let payload = PtyExitEvent {
                pty_id: id.clone(),
                code: exit_code,
            };
            if let Err(err) = app_handle.emit(PTY_EXIT, payload) {
                tracing::warn!(pty_id = %id, error = %err, "emit pty://exit failed (webview likely gone)");
            }
        })
        .expect("OS refused to spawn reader thread")
}
