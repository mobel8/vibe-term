//! Smoke test: spawn a tiny command via `portable-pty` directly and confirm we see its output.
//!
//! Lives outside the `src-tauri` crate to keep PTY-specific integration coverage isolated from
//! Tauri's AppHandle plumbing. To wire it into the cargo test runner, add the following entry
//! to `src-tauri/Cargo.toml` (handled by the main agent, not Agent A):
//!
//! ```toml
//! [[test]]
//! name = "pty_smoke"
//! path = "../tests/rust/pty_smoke.rs"
//! ```
//!
//! The test deliberately avoids `PtyManager` because that requires a `tauri::AppHandle`, which
//! cannot be constructed outside a running Tauri context.

#![warn(clippy::all, rust_2018_idioms)]

use std::io::Read;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

/// How long we are willing to wait for `"hello"` to appear in the PTY output.
const SMOKE_TIMEOUT: Duration = Duration::from_secs(2);

#[test]
fn spawn_echoes_hello() {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty failed");

    #[cfg(unix)]
    let cmd = {
        let mut c = CommandBuilder::new("sh");
        c.args(["-c", "echo hello && exit"]);
        c
    };

    #[cfg(windows)]
    let cmd = {
        let mut c = CommandBuilder::new("cmd.exe");
        c.args(["/c", "echo hello && exit"]);
        c
    };

    let mut child = pair.slave.spawn_command(cmd).expect("spawn_command failed");

    // Critical: drop the slave so the master can observe EOF when the child exits.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .expect("try_clone_reader failed");

    // Read for up to SMOKE_TIMEOUT, accumulating output until we see "hello".
    // A dedicated thread keeps the blocking read off the test runtime so we can enforce a deadline.
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break; // receiver gone
                    }
                }
                Err(_) => break,
            }
        }
    });

    let mut acc = Vec::<u8>::new();
    let deadline = Instant::now() + SMOKE_TIMEOUT;
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(chunk) => {
                acc.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&acc).contains("hello") {
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    // Best-effort reap so we don't leave zombies in the test runner.
    let _ = child.wait();

    let decoded = String::from_utf8_lossy(&acc);
    assert!(
        decoded.contains("hello"),
        "expected 'hello' in PTY output, got {:?}",
        decoded
    );
}
