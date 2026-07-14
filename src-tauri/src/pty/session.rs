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
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};

use crate::events::{PTY_BELL, PTY_DATA, PTY_EXIT};
use crate::pty::{PtyBellEvent, PtyDataEvent, PtyExitEvent, PtyId, SpawnOptions};

/// Maximum time we wait for the reader thread to drain & exit when the session is dropped.
/// Beyond this we abandon the handle. The thread owns an INDEPENDENT cloned reader handle
/// (from `try_clone_reader`), so dropping the session's `master` Arc does NOT close it; the
/// thread only exits once its blocking `read()` finally unblocks (EOF/EIO/BrokenPipe). In the
/// rare genuinely-wedged case this leaks the thread + cloned read handle + a `child` Arc clone
/// until then — accepted as a bounded close-path tradeoff rather than freezing the UI longer.
const READER_JOIN_TIMEOUT: Duration = Duration::from_millis(500);

/// Read buffer size — 32 KiB pulls more bytes per `read()` syscall so bulk output
/// (build logs, `cat`, file dumps) needs far fewer reads. The flusher (below)
/// coalesces many reads into one IPC event regardless, so a larger buffer is pure
/// upside here.
const READ_BUFFER_SIZE: usize = 32 * 1024;

/// Coalescing window. The flusher thread drains every read that arrives within
/// this window into a *single* `pty://data` event. One animation frame (~6 ms)
/// is imperceptible for keystroke echo yet collapses bursty SSH / AI-CLI output
/// (which trickles in as many tiny reads) by ~10–50×, slashing the per-event
/// JSON-serialize + WebView2 IPC + JS-dispatch overhead that used to be paid
/// once *per read*.
const COALESCE_WINDOW: Duration = Duration::from_millis(6);

/// Hard cap on the bytes accumulated before we force a flush, so a firehose
/// still emits in healthy-sized chunks instead of one unbounded string.
const FLUSH_SIZE: usize = 64 * 1024;

/// A flush younger than this marks an ACTIVE BURST: the zero-latency
/// fast-path below is skipped so consecutive chunks coalesce. Without this
/// gate, a release-build flusher outruns the reader — `try_recv` sees Empty
/// after EVERY chunk and each ~100 B ConPTY read ships as its own IPC event
/// (measured: 2441 events for a 253 KB dump vs ~35 coalesced). Interactive
/// echo is unaffected: keystrokes arrive with ≫30 ms gaps, so their first
/// chunk still flushes instantly.
const BURST_GAP: Duration = Duration::from_millis(30);

/// How often the idle flusher wakes to check the `alive` flag. Normally the
/// flusher stops the instant the reader forwards `Exit`; this poll is the
/// fallback for the rare case where `kill()` does not unblock the reader's
/// blocking `read()` (so `Exit` is never sent) — without it the flusher would
/// orphan. Idle cost is ~5 wake-ups/s/PTY (nil while output is flowing).
const SHUTDOWN_POLL: Duration = Duration::from_millis(200);

/// How often the child-exit watcher polls `try_wait()`. On Windows ConPTY the
/// master read pipe stays OPEN while we hold the master handle alive (needed
/// for resize), so a shell that exits cleanly (`exit`, Ctrl+D) never delivers
/// EOF to the blocking reader — the reader would wait forever and `pty://exit`
/// would never fire, leaving the pane looking "running" over a dead shell.
/// The watcher detects the process exit out-of-band and forwards it. 250 ms is
/// imperceptible for a pane going inert and costs one non-blocking
/// `GetExitCodeProcess`/`waitpid(WNOHANG)` per tick.
const CHILD_WATCH_POLL: Duration = Duration::from_millis(250);

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
    /// Held to keep the child alive and to back `clone_killer`; the reader thread waits on a
    /// dedicated clone, so this field looks unused to clippy from the struct's public surface.
    #[allow(dead_code)]
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    /// Independent killer cloned from the child so we can SIGKILL without blocking on a
    /// `.wait()` happening on the reader thread.
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Set to false by `kill` / `Drop` to signal the reader thread to stop ASAP.
    alive: Arc<AtomicBool>,
    /// Reader thread join handle — taken in `Drop` to join with a timeout.
    reader: Option<thread::JoinHandle<()>>,
    /// OS process id of the spawned shell — used to walk the process tree and
    /// detect an `ssh` child for remote image paste. `None` if the backend
    /// couldn't report it.
    child_pid: Option<u32>,
}

impl PtySession {
    /// OS pid of the spawned shell process (the root of this tab's tree).
    pub fn child_pid(&self) -> Option<u32> {
        self.child_pid
    }
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

        let child_pid = child.process_id();

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

        // If the OS refuses a new thread (handle/thread exhaustion, RLIMIT_NPROC, low
        // memory) the child shell is ALREADY running. `Self` (whose `Drop` kills the
        // child) is not constructed yet, so we must reap the orphan here before
        // surfacing the error — otherwise the documented no-zombie guarantee is
        // defeated exactly on the construction-failure path.
        let reader = match spawn_reader_thread(
            id.clone(),
            reader_handle,
            child.clone(),
            alive.clone(),
            app_handle,
        ) {
            Ok(handle) => handle,
            Err(err) => {
                let _ = killer.clone_killer().kill();
                return Err(anyhow!("failed to spawn pty reader thread for {id}: {err}"));
            }
        };

        Ok(Self {
            id,
            master,
            writer,
            child,
            killer,
            alive,
            reader: Some(reader),
            child_pid,
        })
    }

    /// A clone of the master writer handle (an `Arc<Mutex<…>>`). The caller locks
    /// and writes on it WITHOUT holding the `PtyManager` sessions lock, so a write
    /// that blocks on a slow/full pipe (e.g. a slow SSH pane draining) never stalls
    /// keystrokes / resize / spawn in OTHER panes. Same-pane writes still serialise
    /// on this per-pane mutex, so byte order within a pane is preserved.
    pub fn writer_arc(&self) -> Arc<Mutex<Box<dyn Write + Send>>> {
        Arc::clone(&self.writer)
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
            // forget it. NOTE: the thread holds its OWN cloned reader handle (and a `child`
            // Arc clone), so dropping the session's `master` Arc below does NOT free them —
            // they are reclaimed only if/when that blocking read eventually unblocks.
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

/// Message from the blocking reader thread to the coalescing flusher thread.
enum ReaderMsg {
    /// A chunk of bytes read from the PTY master.
    Data(Vec<u8>),
    /// The child has been reaped; carries its exit code. Always the LAST message,
    /// so the flusher can emit `pty://exit` only after the final data flush.
    Exit(Option<i32>),
}

/// Spawn the PTY reader pipeline. It is split across **two** threads so we can
/// coalesce output without ever parking the un-cancellable blocking reader:
///
///   • **reader** (this thread): blocking `read()` loop into a `READ_BUFFER_SIZE`
///     buffer; forwards each chunk to the flusher over an mpsc channel. On EOF /
///     read error / `alive == false` it reaps the child and forwards `Exit`.
///   • **flusher**: drains all chunks arriving within `COALESCE_WINDOW` (or up to
///     `FLUSH_SIZE`) into ONE `pty://data` event, decoding UTF-8 on the
///     *accumulated* buffer (so a multibyte codepoint split across two reads is
///     never mangled into replacement chars), emitting ≤1 `pty://bell` per flush,
///     and finally `pty://exit`.
///
/// A single blocking reader cannot self-coalesce: the next `read()` parks until a
/// byte arrives, so a "buffer then check a deadline" loop would never fire its
/// deadline on an idle stream (and could hold the first chunk — including the
/// shell's `\x1b[6n` CPR query — indefinitely). The producer/consumer split keeps
/// the first chunk flowing within one `COALESCE_WINDOW` while still batching bursts.
fn spawn_reader_thread(
    id: PtyId,
    mut reader: Box<dyn Read + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    alive: Arc<AtomicBool>,
    app_handle: AppHandle,
) -> std::io::Result<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name(format!("pty-reader-{id}"))
        .spawn(move || {
            let (tx, rx) = mpsc::channel::<ReaderMsg>();
            // The flusher owns every emit (coalesced PTY_DATA + PTY_BELL + the
            // terminal PTY_EXIT), guaranteeing data is always flushed before exit.
            // It also watches `alive` so it can stop even if this reader wedges.
            let flusher = match spawn_flusher_thread(id.clone(), rx, alive.clone(), app_handle) {
                Ok(handle) => handle,
                Err(err) => {
                    // OS refused the flusher thread. We can't stream this PTY, so tear it
                    // down rather than leak the running child: clear `alive` and kill the
                    // child. (`tx` drops at end of scope; with no flusher there is nothing
                    // to flush.) The reader thread itself simply returns.
                    tracing::error!(pty_id = %id, error = %err, "failed to spawn flusher thread; killing child");
                    alive.store(false, Ordering::SeqCst);
                    let _ = child.lock().kill();
                    return;
                }
            };

            // Child-exit watcher: forwards a clean shell exit that the blocking
            // reader can't see (ConPTY keeps the read pipe open while the master
            // lives — see CHILD_WATCH_POLL). It races the reader to send `Exit`;
            // the flusher emits `pty://exit` on the FIRST one and returns, so the
            // loser's send hits a closed channel and is harmlessly dropped. Best
            // -effort: if the OS refuses the thread, the kill-path still works.
            spawn_child_watcher(id.clone(), child.clone(), alive.clone(), tx.clone());

            // No artificial startup delay: the frontend buffers early PTY_DATA
            // events keyed by ptyId and replays them from the spawn .then() once
            // ptyIdRef.current is set (see TerminalView.tsx `pendingDataRef`).
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
                        // Observability: each read is what the pre-coalescing code emitted
                        // as one IPC event. Compare against "metric:flush" counts to see the
                        // coalescing ratio. Off unless RUST_LOG enables this module at trace.
                        tracing::trace!(pty_id = %id, n, "metric:read");
                        if tx.send(ReaderMsg::Data(buf[..n].to_vec())).is_err() {
                            // Flusher gone (webview closed) -> nothing left to do.
                            tracing::debug!(pty_id = %id, "reader: flusher dropped, stopping");
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

            // Hand the exit code to the flusher so it emits PTY_EXIT *after* the
            // last data flush, then wait for it to drain and stop.
            let _ = tx.send(ReaderMsg::Exit(exit_code));
            drop(tx);
            let _ = flusher.join();
        })
}

/// Spawn the child-exit watcher (see the call site for why it exists). Detached:
/// it self-terminates when the child exits or `alive` is cleared, holding only
/// cheap `Arc` clones meanwhile. Errors spawning it are non-fatal — the reader's
/// own EOF/kill path still emits exit for every case EXCEPT the clean-exit +
/// held-master ConPTY wedge this watcher is here to cover.
fn spawn_child_watcher(
    id: PtyId,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    alive: Arc<AtomicBool>,
    tx: mpsc::Sender<ReaderMsg>,
) {
    let thread_id = id.clone(); // `id` stays available for the spawn-error log
    let spawned = thread::Builder::new()
        .name(format!("pty-watch-{thread_id}"))
        .spawn(move || loop {
            if !alive.load(Ordering::SeqCst) {
                // Session tearing down (kill/Drop) — the reader owns exit here.
                break;
            }
            // Non-blocking probe. `try_wait` locks the child mutex only briefly;
            // the reader holds that lock solely for its own terminal `wait()`,
            // which by then races to the same conclusion.
            let status = child.lock().try_wait();
            match status {
                Ok(Some(status)) => {
                    let code = status.exit_code() as i32;
                    tracing::debug!(pty_id = %thread_id, code, "watcher: child exited, forwarding");
                    alive.store(false, Ordering::SeqCst);
                    let _ = tx.send(ReaderMsg::Exit(Some(code)));
                    break;
                }
                Ok(None) => thread::sleep(CHILD_WATCH_POLL),
                Err(err) => {
                    tracing::debug!(pty_id = %thread_id, error = %err, "watcher: try_wait failed, stopping");
                    break;
                }
            }
        });
    if let Err(err) = spawned {
        tracing::warn!(pty_id = %id, error = %err, "failed to spawn child-exit watcher; clean-exit detection degraded");
    }
}

/// Coalescing flusher: see [`spawn_reader_thread`]. Drains reads arriving within
/// `COALESCE_WINDOW` (or up to `FLUSH_SIZE`) into one `pty://data` event.
fn spawn_flusher_thread(
    id: PtyId,
    rx: mpsc::Receiver<ReaderMsg>,
    alive: Arc<AtomicBool>,
    app_handle: AppHandle,
) -> std::io::Result<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name(format!("pty-flusher-{id}"))
        .spawn(move || {
            // Trailing bytes of an incomplete multibyte UTF-8 sequence held back
            // from the previous flush (≤3 bytes), prepended to the next one.
            let mut carry: Vec<u8> = Vec::new();
            let mut acc: Vec<u8> = Vec::with_capacity(FLUSH_SIZE);
            // Timestamp of the previous flush — gates the zero-latency
            // fast-path so it only serves ISOLATED chunks (see BURST_GAP).
            // checked_sub: subtracting near the Instant epoch can panic on
            // some platforms; falling back to `now` merely costs the very
            // first chunk one coalesce window (≤6 ms) once per session.
            let mut last_flush = Instant::now()
                .checked_sub(BURST_GAP * 2)
                .unwrap_or_else(Instant::now);

            loop {
                // Wait for the next message, waking periodically to check `alive`.
                match rx.recv_timeout(SHUTDOWN_POLL) {
                    Ok(ReaderMsg::Data(chunk)) => acc.extend_from_slice(&chunk),
                    Ok(ReaderMsg::Exit(code)) => {
                        flush(&app_handle, &id, &mut acc, &mut carry, true);
                        emit_exit(&app_handle, &id, code);
                        return;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        // Idle. If the session is shutting down but the reader is
                        // wedged in a read() that never unblocked (so it never sent
                        // Exit), stop now rather than orphan this thread.
                        if !alive.load(Ordering::SeqCst) {
                            flush(&app_handle, &id, &mut acc, &mut carry, true);
                            return;
                        }
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        // Sender dropped without an Exit (shouldn't happen) -> drain & stop.
                        flush(&app_handle, &id, &mut acc, &mut carry, true);
                        return;
                    }
                }

                // Latency fast-path: if NOTHING else is queued AND we are not
                // inside an active burst, this is a lone chunk (an isolated
                // keystroke echo, common over SSH) — flush it NOW instead of
                // waiting the full COALESCE_WINDOW. The BURST_GAP gate is what
                // keeps this from defeating coalescing entirely: in a release
                // build this thread outruns the reader, so during bulk output
                // `try_recv` is Empty after EVERY chunk — ungated, each ~100 B
                // ConPTY read became its own IPC event (2441 events / 253 KB).
                if last_flush.elapsed() >= BURST_GAP {
                    match rx.try_recv() {
                        Ok(ReaderMsg::Data(more)) => acc.extend_from_slice(&more),
                        Ok(ReaderMsg::Exit(code)) => {
                            flush(&app_handle, &id, &mut acc, &mut carry, true);
                            emit_exit(&app_handle, &id, code);
                            return;
                        }
                        Err(mpsc::TryRecvError::Empty) => {
                            flush(&app_handle, &id, &mut acc, &mut carry, false);
                            last_flush = Instant::now();
                            continue;
                        }
                        Err(mpsc::TryRecvError::Disconnected) => {
                            flush(&app_handle, &id, &mut acc, &mut carry, true);
                            return;
                        }
                    }
                }

                // Drain everything that arrives within the coalescing window or
                // until we hit the size cap, then flush once.
                let deadline = Instant::now() + COALESCE_WINDOW;
                loop {
                    if acc.len() >= FLUSH_SIZE {
                        break;
                    }
                    let now = Instant::now();
                    if now >= deadline {
                        break;
                    }
                    match rx.recv_timeout(deadline - now) {
                        Ok(ReaderMsg::Data(more)) => acc.extend_from_slice(&more),
                        Ok(ReaderMsg::Exit(code)) => {
                            flush(&app_handle, &id, &mut acc, &mut carry, true);
                            emit_exit(&app_handle, &id, code);
                            return;
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            flush(&app_handle, &id, &mut acc, &mut carry, true);
                            return;
                        }
                    }
                }
                flush(&app_handle, &id, &mut acc, &mut carry, false);
                last_flush = Instant::now();
            }
        })
}

/// Decode `carry || acc`, emit one `pty://data` (and a single `pty://bell` if a
/// BEL byte is present), and stash any trailing incomplete UTF-8 sequence in
/// `carry` for the next flush. On `final_flush` nothing is held back so no bytes
/// are lost at stream end. `acc` is left empty.
fn flush(
    app_handle: &AppHandle,
    id: &PtyId,
    acc: &mut Vec<u8>,
    carry: &mut Vec<u8>,
    final_flush: bool,
) {
    if acc.is_empty() && carry.is_empty() {
        return;
    }
    // Prepend the carried partial sequence from the previous flush.
    let mut bytes = std::mem::take(carry);
    bytes.append(acc); // `acc` is now empty and reused next iteration.
    if bytes.is_empty() {
        return;
    }

    // BEL (0x07) is ASCII so it can never live in a carried continuation byte;
    // emit at most one bell per flush regardless of how many BELs the burst held.
    if bytes.contains(&0x07) {
        let _ = app_handle.emit(PTY_BELL, PtyBellEvent { pty_id: id.clone() });
    }

    let chunk: String = match std::str::from_utf8(&bytes) {
        Ok(s) => s.to_owned(),
        Err(e) => {
            let valid = e.valid_up_to();
            match e.error_len() {
                // `None` => the buffer ends mid-codepoint. Emit the valid prefix
                // and carry the tail for the next flush (unless the stream ended).
                None if !final_flush => {
                    // SAFETY: `valid_up_to()` guarantees `[..valid]` is valid UTF-8.
                    let s = unsafe { std::str::from_utf8_unchecked(&bytes[..valid]) }.to_owned();
                    *carry = bytes[valid..].to_vec();
                    s
                }
                // A genuine invalid byte sequence earlier in the buffer (`error_len() ==
                // Some(_)`). The whole-buffer lossy decode used here would also clobber a
                // legitimately-incomplete multibyte sequence sitting at the very END of the
                // buffer (turning it + its continuation bytes in the next read into stray
                // U+FFFD), defeating the carry machinery. So when this is not the final
                // flush, peel off a trailing incomplete-but-valid prefix (≤3 bytes) and
                // carry it forward; lossy-decode only the rest.
                Some(_) if !final_flush => {
                    // Find the last UTF-8 lead byte (not a 0b10xxxxxx continuation) within the
                    // final ≤3 bytes; that is the only place a legitimately-incomplete trailing
                    // codepoint could begin. Carry `bytes[lead..]` forward ONLY if it is a clean
                    // incomplete-but-valid prefix (from_utf8 errors with error_len() == None) —
                    // i.e. a real multibyte char awaiting its continuation bytes in the next read.
                    // Anything else (valid, or genuinely invalid) carries nothing and is lossy-
                    // decoded in full below, exactly as before.
                    let lo = bytes.len().saturating_sub(3);
                    let split = (lo..bytes.len())
                        .rev()
                        .find(|&i| bytes[i] & 0xC0 != 0x80)
                        .filter(|&i| {
                            matches!(
                                std::str::from_utf8(&bytes[i..]),
                                Err(te) if te.valid_up_to() == 0 && te.error_len().is_none()
                            )
                        })
                        .unwrap_or(bytes.len());
                    let s = String::from_utf8_lossy(&bytes[..split]).into_owned();
                    *carry = bytes[split..].to_vec();
                    s
                }
                // A genuine invalid byte sequence (or the final flush): lossy-decode
                // the whole buffer so nothing is dropped.
                _ => String::from_utf8_lossy(&bytes).into_owned(),
            }
        }
    };

    if chunk.is_empty() {
        return;
    }
    // Observability: one coalesced IPC event. See "metric:read" for the ratio.
    tracing::trace!(pty_id = %id, bytes = chunk.len(), "metric:flush");
    let payload = PtyDataEvent {
        pty_id: id.clone(),
        data: chunk,
    };
    if let Err(err) = app_handle.emit(PTY_DATA, payload) {
        tracing::warn!(pty_id = %id, error = %err, "emit pty://data failed (webview likely gone)");
    }
}

/// Emit the terminal `pty://exit` event.
fn emit_exit(app_handle: &AppHandle, id: &PtyId, code: Option<i32>) {
    let payload = PtyExitEvent {
        pty_id: id.clone(),
        code,
    };
    if let Err(err) = app_handle.emit(PTY_EXIT, payload) {
        tracing::warn!(pty_id = %id, error = %err, "emit pty://exit failed (webview likely gone)");
    }
}
