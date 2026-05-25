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

use crate::ai::{keystore, AiClient, ClaudeModel, Message, SendRequest};
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

#[tauri::command]
pub async fn image_read_base64(state: State<'_, AppState>, id: String) -> Result<String, AppError> {
    let images: Arc<ImageManager> = Arc::clone(&state.images);
    tokio::task::spawn_blocking(move || images.read_as_base64(&id))
        .await
        .map_err(|e| AppError::other(format!("image_read_base64 join: {e}")))?
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
    pub model: ClaudeModel,
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

    // Resolve API key: explicit argument > keystore lookup.
    let api_key = match req.api_key {
        Some(k) if !k.is_empty() => k,
        _ => tokio::task::spawn_blocking(keystore::load_api_key)
            .await
            .map_err(|e| AppError::other(format!("ai_send keystore join: {e}")))??
            .ok_or_else(|| {
                AppError::InvalidInput("no api key stored; call ai_set_api_key first".into())
            })?,
    };

    let send_req = SendRequest {
        conversation_id: req.conversation_id,
        message_id: req.message_id,
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
pub async fn ai_set_api_key(key: String) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || keystore::store_api_key(&key))
        .await
        .map_err(|e| AppError::other(format!("ai_set_api_key join: {e}")))?
}

#[tauri::command]
pub async fn ai_has_api_key() -> Result<bool, AppError> {
    tokio::task::spawn_blocking(|| keystore::load_api_key().map(|o| o.is_some()))
        .await
        .map_err(|e| AppError::other(format!("ai_has_api_key join: {e}")))?
}

#[tauri::command]
pub async fn ai_delete_api_key() -> Result<(), AppError> {
    tokio::task::spawn_blocking(keystore::delete_api_key)
        .await
        .map_err(|e| AppError::other(format!("ai_delete_api_key join: {e}")))?
}

#[tauri::command]
pub async fn ai_api_key_preview() -> Result<Option<String>, AppError> {
    tokio::task::spawn_blocking(|| {
        keystore::load_api_key().map(|opt| opt.map(|k| keystore::redact_key(&k)))
    })
    .await
    .map_err(|e| AppError::other(format!("ai_api_key_preview join: {e}")))?
}

// ---------------------------------------------------------------------------
// AI persistence helpers (conversations + exchanges in the SQLite store)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAiConversationArgs {
    pub session_id: String,
    pub model: String,
    #[serde(default)]
    pub title: Option<String>,
}

#[tauri::command]
pub async fn ai_conversation_create(
    state: State<'_, AppState>,
    args: CreateAiConversationArgs,
) -> Result<blocks::AiConversation, AppError> {
    let db: Arc<Db> = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || {
        blocks::create_ai_conversation(&db, &args.session_id, &args.model, args.title.as_deref())
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
