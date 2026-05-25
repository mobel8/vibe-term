//! Cross-module integration smoke test.
//!
//! Exercises the three modules that hold most of the application state — `config`,
//! `store`, and the underlying PTY layer — together in a single test, on the same
//! tempdir, to catch breakage that would only surface when these subsystems are
//! wired up by the live app.
//!
//! Lives outside the `src-tauri` crate so it consumes `vibe_term_lib` as a regular
//! library user. Wire it into the cargo test runner via:
//!
//! ```toml
//! [[test]]
//! name = "cross_module_integration"
//! path = "../tests/rust/cross_module_integration.rs"
//! ```
//!
//! On Windows we skip the PTY portion — `portable-pty` works there but the shell
//! invocation differs enough that the surrounding smoke (already covered by
//! `pty_smoke`) is sufficient. We still exercise config + store on every platform.

#![warn(clippy::all, rust_2018_idioms)]

use std::path::PathBuf;

use vibe_term_lib::config::Settings;
use vibe_term_lib::store::{
    blocks::{self, AppendBlockParams, BlockKind},
    sessions, Db,
};

/// Build a unique tempfile path under the OS temp dir.
fn temp_path(prefix: &str, ext: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    let suffix = nanoid::nanoid!(10);
    p.push(format!("vibe-term-xmod-{prefix}-{suffix}.{ext}"));
    p
}

/// RAII helper: wipe the DB and its WAL sidecars on drop.
struct DbGuard {
    path: PathBuf,
    db: Db,
}

impl DbGuard {
    fn open() -> Self {
        let path = temp_path("db", "db");
        let db = Db::open(&path).expect("open db");
        Self { path, db }
    }
}

impl Drop for DbGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(self.path.with_extension("db-wal"));
        let _ = std::fs::remove_file(self.path.with_extension("db-shm"));
    }
}

/// End-to-end happy path:
///
///   1. Load the default `Settings` (mirrors `Settings::load_or_default` on a
///      brand-new install where no config.toml exists yet).
///   2. Open a brand-new on-disk SQLite store and create a session named after
///      the loaded theme.
///   3. Spawn `echo test` inside a real PTY, collect its output, and append the
///      captured text into the DB as an Output block belonging to that session.
///   4. Assert all three layers agree on what happened.
///
/// The PTY portion is gated behind `cfg(unix)` because the GitHub Windows runners
/// occasionally race the cmd.exe startup banner — the dedicated `pty_smoke` test
/// covers that path separately. On Windows we still exercise config + store +
/// block insert / list with a synthesised "test" payload to keep coverage.
#[test]
fn config_db_pty_smoke() {
    // ---- 1. Config ------------------------------------------------------
    let settings = Settings::default();
    assert!(
        !settings.appearance.theme.is_empty(),
        "default settings must carry a theme"
    );

    // ---- 2. Store -------------------------------------------------------
    let g = DbGuard::open();
    let db = &g.db;

    let session_name = format!("xmod / theme={}", settings.appearance.theme);
    let session = sessions::create(db, &session_name).expect("create session");
    assert!(session.id.starts_with("sess_"));
    assert_eq!(session.name, session_name);

    // ---- 3. PTY (unix only) --------------------------------------------
    let captured = pty_collect_test_output();
    assert!(
        captured.contains("test"),
        "PTY output should contain literal 'test', got {captured:?}"
    );

    // ---- 4. Glue: persist captured output as a Block -------------------
    let cmd_block = blocks::append(
        db,
        AppendBlockParams {
            session_id: session.id.clone(),
            pty_id: Some("pty-xmod".into()),
            kind: BlockKind::Command,
            content: "echo test".into(),
            ansi_raw: None,
            exit_code: None,
            duration_ms: None,
        },
    )
    .expect("append command block");
    assert_eq!(cmd_block.kind, BlockKind::Command);
    assert_eq!(cmd_block.sequence, 1);

    let out_block = blocks::append(
        db,
        AppendBlockParams {
            session_id: session.id.clone(),
            pty_id: Some("pty-xmod".into()),
            kind: BlockKind::Output,
            content: captured.clone(),
            ansi_raw: None,
            exit_code: Some(0),
            duration_ms: Some(5),
        },
    )
    .expect("append output block");
    assert_eq!(out_block.sequence, 2);

    let listed = blocks::list_for_session(db, &session.id, 100, 0).expect("list blocks");
    assert_eq!(listed.len(), 2, "expected two blocks in the session");
    assert_eq!(listed[0].id, cmd_block.id);
    assert_eq!(listed[1].id, out_block.id);
    assert!(
        listed[1].content.contains("test"),
        "stored output must reflect what we captured from the PTY"
    );
}

// ---------------------------------------------------------------------------
// PTY helper — only compiled on Unix.
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn pty_collect_test_output() -> String {
    use std::io::Read;
    use std::time::{Duration, Instant};

    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    const READ_TIMEOUT: Duration = Duration::from_secs(2);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty failed");

    let mut cmd = CommandBuilder::new("sh");
    cmd.args(["-c", "echo test && exit"]);

    let mut child = pair.slave.spawn_command(cmd).expect("spawn_command failed");

    // Drop the slave so the master observes EOF when the child exits.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .expect("try_clone_reader failed");

    // Run the blocking read on a worker thread so the test can enforce a deadline.
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let mut acc = Vec::<u8>::new();
    let deadline = Instant::now() + READ_TIMEOUT;
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(chunk) => {
                acc.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&acc).contains("test") {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    // Best-effort reap so we do not leak a zombie into the test runner.
    let _ = child.wait();

    String::from_utf8_lossy(&acc).into_owned()
}

/// Windows fallback: synthesise the same payload `echo test` would have produced
/// so the assertions downstream still have something meaningful to chew on.
/// The dedicated `pty_smoke` test exercises the real PTY path on Windows.
#[cfg(windows)]
fn pty_collect_test_output() -> String {
    "test\r\n".to_string()
}
