//! Tauri command surface exposed to the React frontend.
//!
//! Every command listed here must also be declared in `tauri::generate_handler!` inside
//! `lib.rs::run`. Long-running work either runs on a `tokio::task::spawn_blocking` worker
//! (synchronous SQLite / filesystem operations) or returns immediately and emits results
//! over Tauri events (PTY streams, AI deltas), so the IPC channel stays responsive.
//!
//! Errors flow through [`AppError`], which serialises as a plain JSON string for the
//! frontend (see `error.rs` and `tests/rust/lib_smoke.rs`).

#![allow(clippy::too_many_arguments)]

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::ai::{
    keystore, provider_catalogue, AiClient, AiProvider, Message, ProviderModels, SendRequest,
};
use crate::config::{ConfigStore, Settings};
use crate::error::AppError;
use crate::export::{
    export_session_to_file as export_to_file, render_session as export_render, ExportFormat,
    ExportOptions,
};
use crate::hotkeys::{HotkeyBinding, HotkeyRegistry};
use crate::images::screenshot::{CaptureMode, MonitorInfo};
use crate::images::{
    clipboard as image_clipboard, screenshot as image_screenshot, ImageManager, ImageMeta,
    ImageSource,
};
use crate::ocr::Engine as OcrEngine;
use crate::pty::shell::{self, ShellInfo};
use crate::pty::{PtyManager, SpawnOptions};
use crate::state::AppState;
use crate::store::{
    blocks::{
        self, AppendAiExchangeParams, AppendBlockParams, Block, BlockKind, CreateImageParams,
        Image as DbImage, ImageSource as DbImageSource,
    },
    search::{self, ImageSearchHit, SearchHit},
    sessions::{self, Session},
    Db,
};

// ---------------------------------------------------------------------------
// Misc / app info
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
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

// ---------------------------------------------------------------------------
// PTY commands (Phase 1)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn pty_spawn(state: State<'_, AppState>, opts: SpawnOptions) -> Result<String, AppError> {
    let manager = Arc::clone(&state.pty);
    manager
        .spawn(opts)
        .await
        .map_err(|e| AppError::other(format!("pty_spawn: {e}")))
}

#[tauri::command]
pub async fn pty_write(
    state: State<'_, AppState>,
    pty_id: String,
    data: String,
) -> Result<(), AppError> {
    let manager: Arc<PtyManager> = Arc::clone(&state.pty);
    tokio::task::spawn_blocking(move || {
        manager
            .write(&pty_id, &data)
            .map_err(|e| AppError::other(format!("pty_write: {e}")))
    })
    .await
    .map_err(|e| AppError::other(format!("pty_write join: {e}")))?
}

#[tauri::command]
pub async fn pty_resize(
    state: State<'_, AppState>,
    pty_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    let manager: Arc<PtyManager> = Arc::clone(&state.pty);
    tokio::task::spawn_blocking(move || {
        manager
            .resize(&pty_id, cols, rows)
            .map_err(|e| AppError::other(format!("pty_resize: {e}")))
    })
    .await
    .map_err(|e| AppError::other(format!("pty_resize join: {e}")))?
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, AppState>, pty_id: String) -> Result<(), AppError> {
    let manager: Arc<PtyManager> = Arc::clone(&state.pty);
    tokio::task::spawn_blocking(move || {
        manager
            .kill(&pty_id)
            .map_err(|e| AppError::other(format!("pty_kill: {e}")))
    })
    .await
    .map_err(|e| AppError::other(format!("pty_kill join: {e}")))?
}

#[tauri::command]
pub async fn detect_shells() -> Result<Vec<ShellInfo>, AppError> {
    tokio::task::spawn_blocking(shell::detect_shells)
        .await
        .map_err(|e| AppError::other(format!("detect_shells join: {e}")))
}

#[tauri::command]
pub async fn default_shell() -> Result<Option<ShellInfo>, AppError> {
    tokio::task::spawn_blocking(shell::default_shell)
        .await
        .map_err(|e| AppError::other(format!("default_shell join: {e}")))
}

// ---------------------------------------------------------------------------
// SSH image paste: detect an `ssh` child of a tab's shell and stream a local
// image to that remote host so Claude Code (running over SSH) can `@`-attach
// it. The transfer rides scp with whatever key/agent the user's ssh already
// uses (BatchMode avoids interactive prompts).
// ---------------------------------------------------------------------------

/// Extract the destination ([user@]host) from a parsed `ssh` argv. Skips the
/// program name, single-letter value options and their values, returning the
/// first bare token — exactly how ssh itself resolves the destination.
fn parse_ssh_destination(args: &[String]) -> Option<String> {
    // ssh single-letter options that consume the following argument.
    const VALUE_OPTS: &[char] = &[
        'B', 'b', 'c', 'D', 'E', 'e', 'F', 'I', 'i', 'J', 'L', 'l', 'm', 'O', 'o', 'P', 'p', 'Q',
        'R', 'S', 'W', 'w',
    ];
    let mut iter = args.iter().skip(1); // skip the ssh executable
    while let Some(a) = iter.next() {
        if a.is_empty() {
            continue; // ConPTY argv can contain empty tokens (e.g. "ssh  host")
        }
        if a == "--" {
            return iter.next().cloned();
        }
        if let Some(rest) = a.strip_prefix('-') {
            // Walk a possibly-clustered short-flag token (`-tt`, `-vvv`, `-p2222`,
            // `-Cp2222`, `-4i mykey`). When a value-taking option char is reached,
            // its value is either the glued remainder of the cluster or the NEXT
            // argv token — either way no destination lives here, so skip ahead.
            // (The old code only handled the lone `-x value` case, so a cluster
            // like `-4i` wrongly returned the keyfile token as the host.)
            let mut chars = rest.chars();
            while let Some(ch) = chars.next() {
                if VALUE_OPTS.contains(&ch) {
                    if chars.as_str().is_empty() {
                        iter.next(); // value is the next argv token
                    }
                    break; // any remainder was the glued value
                }
            }
            continue;
        }
        return Some(a.clone());
    }
    None
}

/// Walk the process tree rooted at `root_pid` (the tab's shell) and return the
/// ssh destination of the first `ssh` descendant, if any.
fn find_ssh_destination(root_pid: u32) -> Option<String> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut sys = System::new();
    // The convenience `refresh_processes` does NOT populate each process's
    // command line (only memory/cpu/disk/exe), so `proc_.cmd()` would come back
    // empty and we'd never recover the ssh destination. Opt into `cmd` refresh
    // explicitly; parent PID and process name are always populated regardless.
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::new().with_cmd(UpdateKind::Always),
    );
    let procs = sys.processes();

    let mut queue: Vec<Pid> = vec![Pid::from_u32(root_pid)];
    let mut visited: std::collections::HashSet<Pid> = std::collections::HashSet::new();
    while let Some(cur) = queue.pop() {
        if !visited.insert(cur) {
            continue;
        }
        for (pid, proc_) in procs.iter() {
            if proc_.parent() != Some(cur) {
                continue;
            }
            let name = proc_.name().to_string_lossy().to_ascii_lowercase();
            if name == "ssh.exe" || name == "ssh" {
                let argv: Vec<String> = proc_
                    .cmd()
                    .iter()
                    .map(|s| s.to_string_lossy().into_owned())
                    .collect();
                let dest = parse_ssh_destination(&argv);
                // Log only the resolved destination — never the full argv, which can
                // carry sensitive `-o ProxyCommand=...`/credential material into the
                // persisted (always-on, info-level) log file. The argv is available at
                // trace level for debugging.
                log::trace!("ssh descendant pid={pid} argv={argv:?}");
                log::info!("ssh descendant pid={pid} -> dest={dest:?}");
                if let Some(dest) = dest {
                    return Some(dest);
                }
            }
            queue.push(*pid);
        }
    }
    None
}

/// If the given tab is currently inside an `ssh` session, return its
/// destination ([user@]host). The frontend uses this to decide whether a
/// pasted image must be uploaded to the remote rather than handed to a local
/// Claude.
#[tauri::command]
pub async fn pty_ssh_host(
    state: State<'_, AppState>,
    pty_id: String,
) -> Result<Option<String>, AppError> {
    let manager: Arc<PtyManager> = Arc::clone(&state.pty);
    let pid = manager.child_pid(&pty_id);
    log::info!("pty_ssh_host pty_id={pty_id} child_pid={pid:?}");
    tokio::task::spawn_blocking(move || pid.and_then(find_ssh_destination))
        .await
        .map_err(|e| AppError::other(format!("pty_ssh_host join: {e}")))
}

/// Count the live descendant processes of `root_pid` (the tab's shell),
/// excluding ConPTY plumbing (conhost/OpenConsole). 0 means the shell sits at
/// an idle prompt — nothing that could legitimately own TUI terminal modes.
fn count_descendants(root_pid: u32) -> u32 {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    // No cmd/env refresh — parent links and names are enough here, which keeps
    // this probe cheap (it runs on wheel/paste in suspicious states + on close).
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::new(),
    );
    let procs = sys.processes();

    let mut count = 0u32;
    let mut queue: Vec<Pid> = vec![Pid::from_u32(root_pid)];
    let mut visited: std::collections::HashSet<Pid> = std::collections::HashSet::new();
    while let Some(cur) = queue.pop() {
        if !visited.insert(cur) {
            continue;
        }
        for (pid, proc_) in procs.iter() {
            if proc_.parent() != Some(cur) {
                continue;
            }
            let name = proc_.name().to_string_lossy().to_ascii_lowercase();
            // Console-host plumbing exists even for an idle ConPTY shell —
            // it must not count as "user work".
            if name != "conhost.exe" && name != "openconsole.exe" {
                count += 1;
            }
            queue.push(*pid);
        }
    }
    count
}

/// Number of live child processes under the tab's shell (ConPTY plumbing
/// excluded). The frontend uses 0 as "idle prompt": safe to close without
/// confirmation, and — combined with suspicious emulator modes — proof that a
/// TUI died uncleanly and its leaked modes can be auto-reset.
#[tauri::command]
pub async fn pty_child_count(
    state: State<'_, AppState>,
    pty_id: String,
) -> Result<u32, AppError> {
    let manager: Arc<PtyManager> = Arc::clone(&state.pty);
    let pid = manager.child_pid(&pty_id);
    tokio::task::spawn_blocking(move || pid.map(count_descendants).unwrap_or(0))
        .await
        .map_err(|e| AppError::other(format!("pty_child_count join: {e}")))
}

/// Upload a local file to `host:~/.vibe-shots/<filename>` and return the remote
/// path (`~/.vibe-shots/<filename>`) for use in a `@`-mention. Relies on the
/// user's existing ssh auth (key/agent); `BatchMode=yes` keeps it non-blocking.
///
/// Uses a **single** ssh connection that both creates the directory and streams
/// the file in over stdin (`cat >`) — the previous ssh-mkdir + scp approach paid
/// two TLS/auth handshakes. The filename is a sha256 hash + `.png`, so it needs
/// no shell quoting. No PTY is allocated, so the byte stream stays binary-clean.
#[tauri::command]
pub async fn ssh_upload_image(host: String, local_path: String) -> Result<String, AppError> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    tokio::task::spawn_blocking(move || -> Result<String, AppError> {
        // The local file is named `<sha256>.png` (64 hex chars) — far too long for
        // the `@mention` the user sees in claude. An 8-char prefix is plenty to stay
        // collision-free for a session's screenshots and keeps dedup (same image →
        // same short name → harmless overwrite).
        let path = std::path::Path::new(&local_path);
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("png");
        let stem: String = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("vibe-paste")
            .chars()
            .take(8)
            .collect();
        let file_name = format!("{stem}.{ext}");

        // Defense-in-depth: file_name is interpolated UNQUOTED into a remote shell
        // command below. The stem is sha/name-derived so it's normally safe, but
        // enforce that invariant rather than trust it — reject anything with shell
        // metacharacters so a crafted name can't inject a remote command.
        if file_name.is_empty()
            || !file_name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        {
            return Err(AppError::InvalidInput(format!(
                "refusing unsafe remote screenshot name: {file_name}"
            )));
        }

        let bytes = std::fs::read(&local_path)
            .map_err(|e| AppError::other(format!("read local image failed: {e}")))?;

        let remote_cmd = format!("mkdir -p ~/.vibe-shots && cat > ~/.vibe-shots/{file_name}");
        let mut ssh = Command::new("ssh");
        ssh.args([
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            // `--` terminates options so a `-`-leading destination can never be
            // reinterpreted as an ssh option.
            "--",
            &host,
            &remote_cmd,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        // CREATE_NO_WINDOW (0x0800_0000): no flashing console window on image
        // upload — release builds are GUI-subsystem, so a console child like ssh
        // would otherwise pop a visible window. Windows-only.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            ssh.creation_flags(0x0800_0000);
        }
        let mut child = ssh
            .spawn()
            .map_err(|e| AppError::other(format!("ssh spawn failed: {e}")))?;

        // Write the file bytes from a separate thread so stdout/stderr stay drained
        // concurrently. Screenshots can be hundreds of KB–several MB, far larger than
        // the ~64 KB OS pipe buffer; if ssh emits enough on stderr (verbose negotiation,
        // host-key notice, auth diagnostics) while we synchronously push stdin, both
        // pipes wedge into a classic two-pipe deadlock. `wait_with_output()` drains
        // stdout and stderr for us, and dropping the stdin handle when the writer thread
        // finishes signals EOF so the remote `cat` completes.
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::other("ssh stdin unavailable".to_string()))?;
        let writer = std::thread::spawn(move || {
            // A broken-pipe error here still surfaces via ssh's non-zero exit status
            // and stderr below, so swallowing it does not hide failures.
            let _ = stdin.write_all(&bytes);
        });

        let out = child
            .wait_with_output()
            .map_err(|e| AppError::other(format!("ssh wait failed: {e}")))?;
        let _ = writer.join();
        if !out.status.success() {
            return Err(AppError::other(format!(
                "ssh upload failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        Ok(format!("~/.vibe-shots/{file_name}"))
    })
    .await
    .map_err(|e| AppError::other(format!("ssh_upload_image join: {e}")))?
}

/// Copy a locally-saved screenshot into `~/.vibe-shots/<stem>.<ext>` so a LOCAL
/// Claude Code can read it via the *same* `@~/.vibe-shots/<id>.png` mention the
/// SSH path uses. The filename scheme (first 8 chars of the stem + original ext)
/// matches both `ssh_upload_image` and the frontend's `remoteShotPath`, so the
/// inserted mention always points at the file we just wrote. Returns the
/// `~`-relative path for the mention.
#[tauri::command]
pub async fn stage_local_shot(local_path: String) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || -> Result<String, AppError> {
        let src = std::path::Path::new(&local_path);
        let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("png");
        let stem: String = src
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("vibe-paste")
            .chars()
            .take(8)
            .collect();
        let file_name = format!("{stem}.{ext}");
        let home = dirs::home_dir()
            .ok_or_else(|| AppError::other("could not resolve home dir".to_string()))?;
        let dir = home.join(".vibe-shots");
        std::fs::create_dir_all(&dir)
            .map_err(|e| AppError::other(format!("create ~/.vibe-shots failed: {e}")))?;
        std::fs::copy(&local_path, dir.join(&file_name))
            .map_err(|e| AppError::other(format!("stage local shot failed: {e}")))?;
        Ok(format!("~/.vibe-shots/{file_name}"))
    })
    .await
    .map_err(|e| AppError::other(format!("stage_local_shot join: {e}")))?
}

// ---------------------------------------------------------------------------
// Session / block / search commands (Phase 5)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn session_create(state: State<'_, AppState>, name: String) -> Result<Session, AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || sessions::create(&db, &name))
        .await
        .map_err(|e| AppError::other(format!("session_create join: {e}")))?
}

#[tauri::command]
pub async fn session_list(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<Session>, AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    let limit = limit.unwrap_or(100);
    tokio::task::spawn_blocking(move || sessions::list(&db, limit))
        .await
        .map_err(|e| AppError::other(format!("session_list join: {e}")))?
}

#[tauri::command]
pub async fn session_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<Session>, AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || sessions::get(&db, &id))
        .await
        .map_err(|e| AppError::other(format!("session_get join: {e}")))?
}

#[tauri::command]
pub async fn session_rename(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<(), AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || sessions::rename(&db, &id, &name))
        .await
        .map_err(|e| AppError::other(format!("session_rename join: {e}")))?
}

#[tauri::command]
pub async fn session_touch(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || sessions::touch(&db, &id))
        .await
        .map_err(|e| AppError::other(format!("session_touch join: {e}")))?
}

#[tauri::command]
pub async fn session_delete(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || sessions::delete(&db, &id))
        .await
        .map_err(|e| AppError::other(format!("session_delete join: {e}")))?
}

/// Frontend-friendly payload for [`block_append`]. We accept everything as plain JSON
/// (so `ansi_raw` arrives as an array of bytes, not a SQLite blob) and convert to the
/// internal [`AppendBlockParams`] before forwarding.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendBlockArgs {
    pub session_id: String,
    #[serde(default)]
    pub pty_id: Option<String>,
    pub kind: BlockKind,
    pub content: String,
    #[serde(default)]
    pub ansi_raw: Option<Vec<u8>>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
}

#[tauri::command]
pub async fn block_append(
    state: State<'_, AppState>,
    params: AppendBlockArgs,
) -> Result<Block, AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || {
        blocks::append(
            &db,
            AppendBlockParams {
                session_id: params.session_id,
                pty_id: params.pty_id,
                kind: params.kind,
                content: params.content,
                ansi_raw: params.ansi_raw,
                exit_code: params.exit_code,
                duration_ms: params.duration_ms,
            },
        )
    })
    .await
    .map_err(|e| AppError::other(format!("block_append join: {e}")))?
}

#[tauri::command]
pub async fn block_list(
    state: State<'_, AppState>,
    session_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<Block>, AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    let limit = limit.unwrap_or(500);
    let offset = offset.unwrap_or(0);
    tokio::task::spawn_blocking(move || blocks::list_for_session(&db, &session_id, limit, offset))
        .await
        .map_err(|e| AppError::other(format!("block_list join: {e}")))?
}

#[tauri::command]
pub async fn block_count(state: State<'_, AppState>, session_id: String) -> Result<i64, AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || blocks::count_for_session(&db, &session_id))
        .await
        .map_err(|e| AppError::other(format!("block_count join: {e}")))?
}

#[tauri::command]
pub async fn search_fts(
    state: State<'_, AppState>,
    query: String,
    session: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<SearchHit>, AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    let limit = limit.unwrap_or(50);
    tokio::task::spawn_blocking(move || {
        search::search_blocks(&db, &query, session.as_deref(), limit)
    })
    .await
    .map_err(|e| AppError::other(format!("search_fts join: {e}")))?
}

#[tauri::command]
pub async fn search_images_fts(
    state: State<'_, AppState>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<ImageSearchHit>, AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    let limit = limit.unwrap_or(50);
    tokio::task::spawn_blocking(move || search::search_images(&db, &query, limit))
        .await
        .map_err(|e| AppError::other(format!("search_images_fts join: {e}")))?
}

// ---------------------------------------------------------------------------
// Image / OCR commands (Phase 4)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn image_from_clipboard(
    state: State<'_, AppState>,
) -> Result<Option<ImageMeta>, AppError> {
    let images: Arc<ImageManager> = Arc::clone(&state.images);
    tokio::task::spawn_blocking(
        move || match image_clipboard::read_image_from_clipboard()? {
            Some(bytes) => Ok(Some(images.add_from_bytes(&bytes, ImageSource::Clipboard)?)),
            None => Ok::<Option<ImageMeta>, AppError>(None),
        },
    )
    .await
    .map_err(|e| AppError::other(format!("image_from_clipboard join: {e}")))?
}

#[tauri::command]
pub async fn image_from_path(
    state: State<'_, AppState>,
    path: String,
    source: Option<ImageSource>,
) -> Result<ImageMeta, AppError> {
    let images: Arc<ImageManager> = Arc::clone(&state.images);
    let source = source.unwrap_or(ImageSource::Drop);
    let pb = PathBuf::from(&path);
    tokio::task::spawn_blocking(move || images.add_from_path(&pb, source))
        .await
        .map_err(|e| AppError::other(format!("image_from_path join: {e}")))?
}

#[tauri::command]
pub async fn image_from_bytes(
    state: State<'_, AppState>,
    bytes: Vec<u8>,
    source: Option<ImageSource>,
) -> Result<ImageMeta, AppError> {
    let images: Arc<ImageManager> = Arc::clone(&state.images);
    let source = source.unwrap_or(ImageSource::Drop);
    tokio::task::spawn_blocking(move || images.add_from_bytes(&bytes, source))
        .await
        .map_err(|e| AppError::other(format!("image_from_bytes join: {e}")))?
}

#[tauri::command]
pub async fn image_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<ImageMeta>, AppError> {
    let images: Arc<ImageManager> = Arc::clone(&state.images);
    tokio::task::spawn_blocking(move || images.get(&id))
        .await
        .map_err(|e| AppError::other(format!("image_get join: {e}")))?
}

/// List every persisted image (sidecar scan), newest-first. Seeds the gallery panel
/// with screenshots from previous sessions; the in-memory cache only covers the
/// current run.
#[tauri::command]
pub async fn list_images_on_disk(
    state: State<'_, AppState>,
) -> Result<Vec<ImageMeta>, AppError> {
    let images: Arc<ImageManager> = Arc::clone(&state.images);
    tokio::task::spawn_blocking(move || images.list_all())
        .await
        .map_err(|e| AppError::other(format!("list_images_on_disk join: {e}")))?
}

#[tauri::command]
pub async fn image_read_base64(state: State<'_, AppState>, id: String) -> Result<String, AppError> {
    let images: Arc<ImageManager> = Arc::clone(&state.images);
    tokio::task::spawn_blocking(move || images.read_as_base64(&id))
        .await
        .map_err(|e| AppError::other(format!("image_read_base64 join: {e}")))?
}

/// Copy an image's pixels onto the OS clipboard so the user can paste it
/// anywhere. Decodes the stored PNG to RGBA and hands it to arboard — entirely
/// backend-side, avoiding the JS image/clipboard plugin capability surface
/// (which `Image.fromBytes` + `writeImage` would otherwise require).
#[tauri::command]
pub async fn copy_image_to_clipboard(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    let images: Arc<ImageManager> = Arc::clone(&state.images);
    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        let bytes = images.read_bytes(&id)?;
        let rgba = image::load_from_memory(&bytes)
            .map_err(|e| AppError::other(format!("image decode: {e}")))?
            .to_rgba8();
        let (w, h) = (rgba.width() as usize, rgba.height() as usize);
        let mut clipboard = arboard::Clipboard::new()
            .map_err(|e| AppError::other(format!("clipboard open: {e}")))?;
        clipboard
            .set_image(arboard::ImageData {
                width: w,
                height: h,
                bytes: std::borrow::Cow::Owned(rgba.into_raw()),
            })
            .map_err(|e| AppError::other(format!("clipboard set_image: {e}")))?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::other(format!("copy_image_to_clipboard join: {e}")))?
}

#[tauri::command]
pub async fn image_delete(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let images: Arc<ImageManager> = Arc::clone(&state.images);
    tokio::task::spawn_blocking(move || images.delete(&id))
        .await
        .map_err(|e| AppError::other(format!("image_delete join: {e}")))?
}

#[tauri::command]
pub async fn screenshot_capture(
    state: State<'_, AppState>,
    mode: CaptureMode,
) -> Result<ImageMeta, AppError> {
    let images: Arc<ImageManager> = Arc::clone(&state.images);
    tokio::task::spawn_blocking(move || {
        let bytes = image_screenshot::capture(mode)?;
        images.add_from_bytes(&bytes, ImageSource::Screenshot)
    })
    .await
    .map_err(|e| AppError::other(format!("screenshot_capture join: {e}")))?
}

#[tauri::command]
pub async fn list_monitors() -> Result<Vec<MonitorInfo>, AppError> {
    tokio::task::spawn_blocking(image_screenshot::list_monitors)
        .await
        .map_err(|e| AppError::other(format!("list_monitors join: {e}")))?
}

#[tauri::command]
pub async fn ocr_extract(state: State<'_, AppState>, image_id: String) -> Result<String, AppError> {
    let images: Arc<ImageManager> = Arc::clone(&state.images);
    let ocr: Arc<OcrEngine> = Arc::clone(&state.ocr);
    tokio::task::spawn_blocking(move || -> Result<String, AppError> {
        let bytes = images.read_bytes(&image_id)?;
        ocr.extract_text(&bytes)
    })
    .await
    .map_err(|e| AppError::other(format!("ocr_extract join: {e}")))?
}

// ---------------------------------------------------------------------------
// AI commands (Phase 6)
// ---------------------------------------------------------------------------

/// Frontend-facing send arguments. The `apiKey` field is optional: when omitted we look up
/// the stored key from the OS keystore. Both forms exist so the frontend can either let the
/// backend manage the secret (default) or pass through a one-shot key for testing.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSendArgs {
    pub conversation_id: String,
    pub message_id: String,
    #[serde(default)]
    pub provider: AiProvider,
    pub model: String,
    #[serde(default)]
    pub max_tokens: u32,
    #[serde(default)]
    pub system_prompt: Option<String>,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub temperature: Option<f32>,
}

#[tauri::command]
pub async fn ai_send(state: State<'_, AppState>, req: AiSendArgs) -> Result<(), AppError> {
    let client: Arc<AiClient> = Arc::clone(&state.ai);
    let account = req.provider.keystore_account();

    // Resolve the API key for THIS provider: explicit argument > per-provider keystore.
    let api_key = match req.api_key {
        Some(k) if !k.is_empty() => k,
        _ => tokio::task::spawn_blocking(move || keystore::load_api_key(account))
            .await
            .map_err(|e| AppError::other(format!("ai_send keystore join: {e}")))??
            .ok_or_else(|| {
                AppError::InvalidInput(format!(
                    "no api key stored for {account}; set it in Settings → AI first"
                ))
            })?,
    };

    let send_req = SendRequest {
        conversation_id: req.conversation_id,
        message_id: req.message_id,
        provider: req.provider,
        model: req.model,
        max_tokens: req.max_tokens,
        system_prompt: req.system_prompt,
        messages: req.messages,
        api_key,
        temperature: req.temperature,
    };
    client.send(send_req).await
}

#[tauri::command]
pub async fn ai_stop(state: State<'_, AppState>, conversation_id: String) -> Result<(), AppError> {
    state.ai.stop(&conversation_id);
    Ok(())
}

#[tauri::command]
pub async fn ai_set_api_key(provider: AiProvider, key: String) -> Result<(), AppError> {
    let account = provider.keystore_account();
    tokio::task::spawn_blocking(move || keystore::store_api_key(account, &key))
        .await
        .map_err(|e| AppError::other(format!("ai_set_api_key join: {e}")))?
}

#[tauri::command]
pub async fn ai_has_api_key(provider: AiProvider) -> Result<bool, AppError> {
    let account = provider.keystore_account();
    tokio::task::spawn_blocking(move || keystore::load_api_key(account).map(|o| o.is_some()))
        .await
        .map_err(|e| AppError::other(format!("ai_has_api_key join: {e}")))?
}

#[tauri::command]
pub async fn ai_delete_api_key(provider: AiProvider) -> Result<(), AppError> {
    let account = provider.keystore_account();
    tokio::task::spawn_blocking(move || keystore::delete_api_key(account))
        .await
        .map_err(|e| AppError::other(format!("ai_delete_api_key join: {e}")))?
}

#[tauri::command]
pub async fn ai_api_key_preview(provider: AiProvider) -> Result<Option<String>, AppError> {
    let account = provider.keystore_account();
    tokio::task::spawn_blocking(move || {
        keystore::load_api_key(account).map(|opt| opt.map(|k| keystore::redact_key(&k)))
    })
    .await
    .map_err(|e| AppError::other(format!("ai_api_key_preview join: {e}")))?
}

/// The selectable model catalogue per provider — single source of truth shared
/// with the frontend's provider/model pickers.
#[tauri::command]
pub fn ai_list_models() -> Vec<ProviderModels> {
    provider_catalogue()
}

// ---------------------------------------------------------------------------
// AI persistence helpers (conversations + exchanges in the SQLite store)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAiConversationArgs {
    pub session_id: String,
    pub model: String,
    /// Provider wire value ("anthropic", "groq", …). Defaults to "anthropic"
    /// so older frontends that don't send it keep working.
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default)]
    pub title: Option<String>,
}

fn default_provider() -> String {
    "anthropic".to_string()
}

#[tauri::command]
pub async fn ai_conversation_create(
    state: State<'_, AppState>,
    args: CreateAiConversationArgs,
) -> Result<blocks::AiConversation, AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || {
        blocks::create_ai_conversation(
            &db,
            &args.session_id,
            &args.model,
            &args.provider,
            args.title.as_deref(),
        )
    })
    .await
    .map_err(|e| AppError::other(format!("ai_conversation_create join: {e}")))?
}

#[tauri::command]
pub async fn ai_conversation_list(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<blocks::AiConversation>, AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || blocks::list_ai_conversations(&db, &session_id))
        .await
        .map_err(|e| AppError::other(format!("ai_conversation_list join: {e}")))?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendAiExchangeArgs {
    pub conversation_id: String,
    pub role: String,
    pub content_json: String,
    #[serde(default)]
    pub input_tokens: Option<i64>,
    #[serde(default)]
    pub output_tokens: Option<i64>,
}

#[tauri::command]
pub async fn ai_exchange_append(
    state: State<'_, AppState>,
    args: AppendAiExchangeArgs,
) -> Result<blocks::AiExchange, AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || {
        blocks::append_ai_exchange(
            &db,
            AppendAiExchangeParams {
                conversation_id: args.conversation_id,
                role: args.role,
                content_json: args.content_json,
                input_tokens: args.input_tokens,
                output_tokens: args.output_tokens,
            },
        )
    })
    .await
    .map_err(|e| AppError::other(format!("ai_exchange_append join: {e}")))?
}

#[tauri::command]
pub async fn ai_exchange_list(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<blocks::AiExchange>, AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || blocks::list_ai_exchanges(&db, &conversation_id))
        .await
        .map_err(|e| AppError::other(format!("ai_exchange_list join: {e}")))?
}

// ---------------------------------------------------------------------------
// DB image registry helpers (the on-disk PNG lives in ImageManager; the SQL
// row in the `images` table tracks metadata + OCR text for FTS).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbImageCreateArgs {
    pub sha256: String,
    pub path: String,
    pub mime: String,
    pub width: i64,
    pub height: i64,
    pub bytes: i64,
    pub source: DbImageSource,
}

#[tauri::command]
pub async fn db_image_create(
    state: State<'_, AppState>,
    args: DbImageCreateArgs,
) -> Result<DbImage, AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || {
        blocks::create_image(
            &db,
            CreateImageParams {
                sha256: args.sha256,
                path: args.path,
                mime: args.mime,
                width: args.width,
                height: args.height,
                bytes: args.bytes,
                source: args.source,
            },
        )
    })
    .await
    .map_err(|e| AppError::other(format!("db_image_create join: {e}")))?
}

#[tauri::command]
pub async fn db_image_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<DbImage>, AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || blocks::get_image(&db, &id))
        .await
        .map_err(|e| AppError::other(format!("db_image_get join: {e}")))?
}

#[tauri::command]
pub async fn db_image_list(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<DbImage>, AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    let limit = limit.unwrap_or(50);
    tokio::task::spawn_blocking(move || blocks::list_images(&db, limit))
        .await
        .map_err(|e| AppError::other(format!("db_image_list join: {e}")))?
}

#[tauri::command]
pub async fn db_image_set_ocr(
    state: State<'_, AppState>,
    id: String,
    text: Option<String>,
) -> Result<(), AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || blocks::set_ocr_text(&db, &id, text.as_deref()))
        .await
        .map_err(|e| AppError::other(format!("db_image_set_ocr join: {e}")))?
}

#[tauri::command]
pub async fn db_image_attach_to_block(
    state: State<'_, AppState>,
    block_id: String,
    image_id: String,
    position: Option<i64>,
) -> Result<(), AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    let position = position.unwrap_or(0);
    tokio::task::spawn_blocking(move || {
        blocks::attach_image_to_block(&db, &block_id, &image_id, position)
    })
    .await
    .map_err(|e| AppError::other(format!("db_image_attach_to_block join: {e}")))?
}

// ---------------------------------------------------------------------------
// Config commands (Phase 7)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn config_get(state: State<'_, AppState>) -> Result<Settings, AppError> {
    Ok(state.config.snapshot())
}

#[tauri::command]
pub async fn config_update(
    state: State<'_, AppState>,
    patch: serde_json::Value,
) -> Result<Settings, AppError> {
    let cfg: Arc<ConfigStore> = Arc::clone(&state.config);
    tokio::task::spawn_blocking(move || cfg.update(patch))
        .await
        .map_err(|e| AppError::other(format!("config_update join: {e}")))?
}

#[tauri::command]
pub async fn config_path(state: State<'_, AppState>) -> Result<String, AppError> {
    Ok(state.config.path().display().to_string())
}

// ---------------------------------------------------------------------------
// Diagnostic helpers — used by the frontend's "About" / debug panels.
// ---------------------------------------------------------------------------

/// Snapshot of the resolved data directories — handy for the "Open config folder"
/// UX hook the frontend exposes in the settings page.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataPaths {
    pub config_path: String,
    pub db_path: String,
    pub images_dir: String,
    pub models_dir: String,
}

#[tauri::command]
pub async fn data_paths(
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<DataPaths, AppError> {
    let config_path = state.config.path().display().to_string();
    let db_path = Db::default_path(&app_handle).display().to_string();
    let images_dir = state.images.storage_dir().display().to_string();
    let models_dir = state.ocr.models_dir().display().to_string();
    Ok(DataPaths {
        config_path,
        db_path,
        images_dir,
        models_dir,
    })
}

// ---------------------------------------------------------------------------
// Hotkey commands (Phase 7 — global OS-level)
// ---------------------------------------------------------------------------

/// Per-binding outcome returned by [`hotkey_replace_all`]. `error` is `null` on
/// success or carries the platform-provided reason (already-grabbed chord,
/// unparseable accelerator, …) when the binding could not be installed.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyReplaceResult {
    pub binding: HotkeyBinding,
    pub error: Option<String>,
}

fn require_hotkeys(state: &AppState) -> Result<Arc<HotkeyRegistry>, AppError> {
    state
        .hotkeys
        .as_ref()
        .cloned()
        .ok_or_else(|| AppError::other("hotkeys: registry unavailable (no display server?)"))
}

#[tauri::command]
pub async fn hotkey_register(
    state: State<'_, AppState>,
    binding: HotkeyBinding,
) -> Result<(), AppError> {
    let registry = require_hotkeys(&state)?;
    tokio::task::spawn_blocking(move || registry.register(binding))
        .await
        .map_err(|e| AppError::other(format!("hotkey_register join: {e}")))?
}

#[tauri::command]
pub async fn hotkey_unregister(
    state: State<'_, AppState>,
    action: String,
) -> Result<(), AppError> {
    let registry = require_hotkeys(&state)?;
    tokio::task::spawn_blocking(move || registry.unregister(&action))
        .await
        .map_err(|e| AppError::other(format!("hotkey_unregister join: {e}")))?
}

#[tauri::command]
pub async fn hotkey_replace_all(
    state: State<'_, AppState>,
    bindings: Vec<HotkeyBinding>,
) -> Result<Vec<HotkeyReplaceResult>, AppError> {
    let registry = require_hotkeys(&state)?;
    let captured = bindings.clone();
    let results = tokio::task::spawn_blocking(move || registry.replace_all(bindings))
        .await
        .map_err(|e| AppError::other(format!("hotkey_replace_all join: {e}")))?;
    Ok(captured
        .into_iter()
        .zip(results)
        .map(|(b, r)| HotkeyReplaceResult {
            binding: b,
            error: r.err().map(|e| e.to_string()),
        })
        .collect())
}

#[tauri::command]
pub async fn hotkey_list(state: State<'_, AppState>) -> Result<Vec<HotkeyBinding>, AppError> {
    let Some(registry) = state.hotkeys.as_ref().cloned() else {
        return Ok(Vec::new());
    };
    tokio::task::spawn_blocking(move || registry.list())
        .await
        .map_err(|e| AppError::other(format!("hotkey_list join: {e}")))
}

// ---------------------------------------------------------------------------
// Export commands (Phase 5 — session → Markdown / HTML)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRenderArgs {
    pub session_id: String,
    pub format: ExportFormat,
    #[serde(default)]
    pub options: ExportOptions,
}

#[tauri::command]
pub async fn export_session(
    state: State<'_, AppState>,
    args: ExportRenderArgs,
) -> Result<String, AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || {
        export_render(&db, &args.session_id, args.format, &args.options)
    })
    .await
    .map_err(|e| AppError::other(format!("export_session join: {e}")))?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportToFileArgs {
    pub session_id: String,
    pub output_path: String,
    pub format: ExportFormat,
    #[serde(default)]
    pub options: ExportOptions,
}

#[tauri::command]
pub async fn export_session_to_file(
    state: State<'_, AppState>,
    args: ExportToFileArgs,
) -> Result<(), AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || {
        export_to_file(
            &db,
            &args.session_id,
            std::path::Path::new(&args.output_path),
            args.format,
            &args.options,
        )
    })
    .await
    .map_err(|e| AppError::other(format!("export_session_to_file join: {e}")))?
}
