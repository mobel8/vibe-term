//! Block, image and AI helpers.
//!
//! A `Block` is the canonical unit of terminal history. Each session is an
//! append-only stream of blocks ordered by `sequence`. Blocks may also carry
//! a list of attached `images` via the `block_images` join table.
//!
//! This module additionally exposes thin helpers for `images`,
//! `ai_conversations` and `ai_exchanges` so the rest of the backend can stay
//! free of raw SQL.

#![warn(clippy::all, rust_2018_idioms)]

use rusqlite::Row;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::AppError;

use super::{map_sqlite_err, now_ms, short_id, Db};

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/// Kind discriminator for a block, mirroring the `kind` TEXT column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../src/ipc/bindings/")]
pub enum BlockKind {
    /// User-entered shell command.
    Command,
    /// Shell output emitted in response to a command.
    Output,
    /// Prompt the user typed in the AI sidebar.
    AiUser,
    /// Streamed reply from the assistant.
    AiAssistant,
    /// Synthetic block (welcome banner, error, system note).
    System,
}

impl BlockKind {
    fn as_str(self) -> &'static str {
        match self {
            BlockKind::Command => "command",
            BlockKind::Output => "output",
            BlockKind::AiUser => "ai_user",
            BlockKind::AiAssistant => "ai_assistant",
            BlockKind::System => "system",
        }
    }

    fn parse(s: &str) -> Result<Self, AppError> {
        Ok(match s {
            "command" => BlockKind::Command,
            "output" => BlockKind::Output,
            "ai_user" => BlockKind::AiUser,
            "ai_assistant" => BlockKind::AiAssistant,
            "system" => BlockKind::System,
            other => return Err(AppError::other(format!("unknown block kind `{other}`"))),
        })
    }
}

/// A persisted block row.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/ipc/bindings/")]
pub struct Block {
    pub id: String,
    pub session_id: String,
    pub pty_id: Option<String>,
    pub kind: BlockKind,
    pub content: String,
    /// Raw ANSI bytes (escape sequences kept verbatim) – optional, can be
    /// hefty so callers often skip it.
    pub ansi_raw: Option<Vec<u8>>,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<i64>,
    pub created_at: i64,
    pub sequence: i64,
}

/// Parameters for [`append`]. Using a struct keeps the call sites readable.
#[derive(Debug, Clone)]
pub struct AppendBlockParams {
    pub session_id: String,
    pub pty_id: Option<String>,
    pub kind: BlockKind,
    pub content: String,
    pub ansi_raw: Option<Vec<u8>>,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<i64>,
}

impl Block {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let kind_s: String = row.get(3)?;
        let kind = BlockKind::parse(&kind_s).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    e.to_string(),
                )),
            )
        })?;
        Ok(Self {
            id: row.get(0)?,
            session_id: row.get(1)?,
            pty_id: row.get(2)?,
            kind,
            content: row.get(4)?,
            ansi_raw: row.get(5)?,
            exit_code: row.get(6)?,
            duration_ms: row.get(7)?,
            created_at: row.get(8)?,
            sequence: row.get(9)?,
        })
    }
}

/// Append a block, auto-incrementing `sequence` within the session.
///
/// We open a transaction so the `MAX(sequence)+1` read and the subsequent
/// INSERT are serialised. Multiple writers cannot allocate the same sequence.
pub fn append(db: &Db, params: AppendBlockParams) -> Result<Block, AppError> {
    let mut conn = db.conn()?;
    let tx = conn.transaction().map_err(map_sqlite_err)?;

    let next_seq: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM blocks WHERE session_id = ?1",
            [&params.session_id],
            |row| row.get(0),
        )
        .map_err(map_sqlite_err)?;

    let block = Block {
        id: short_id("blk"),
        session_id: params.session_id,
        pty_id: params.pty_id,
        kind: params.kind,
        content: params.content,
        ansi_raw: params.ansi_raw,
        exit_code: params.exit_code,
        duration_ms: params.duration_ms,
        created_at: now_ms(),
        sequence: next_seq,
    };

    tx.execute(
        "INSERT INTO blocks (\
            id, session_id, pty_id, kind, content, ansi_raw,\
            exit_code, duration_ms, created_at, sequence\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            block.id,
            block.session_id,
            block.pty_id,
            block.kind.as_str(),
            block.content,
            block.ansi_raw,
            block.exit_code,
            block.duration_ms,
            block.created_at,
            block.sequence,
        ],
    )
    .map_err(map_sqlite_err)?;

    // Touch the parent session so it bubbles to the top of recent lists.
    tx.execute(
        "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
        rusqlite::params![block.created_at, block.session_id],
    )
    .map_err(map_sqlite_err)?;

    tx.commit().map_err(map_sqlite_err)?;
    Ok(block)
}

/// Return blocks for a session ordered by `sequence ASC`, paginated.
pub fn list_for_session(
    db: &Db,
    session_id: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<Block>, AppError> {
    let limit = limit.max(1);
    let offset = offset.max(0);
    let conn = db.conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, pty_id, kind, content, ansi_raw, exit_code, \
                    duration_ms, created_at, sequence \
             FROM blocks \
             WHERE session_id = ?1 \
             ORDER BY sequence ASC \
             LIMIT ?2 OFFSET ?3",
        )
        .map_err(map_sqlite_err)?;
    let rows = stmt
        .query_map(
            rusqlite::params![session_id, limit, offset],
            Block::from_row,
        )
        .map_err(map_sqlite_err)?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(map_sqlite_err)?);
    }
    Ok(out)
}

/// Count of blocks attached to a session – used for pagination + UI badges.
pub fn count_for_session(db: &Db, session_id: &str) -> Result<i64, AppError> {
    let conn = db.conn()?;
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM blocks WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .map_err(map_sqlite_err)?;
    Ok(count)
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/// Where an image originated from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../src/ipc/bindings/")]
pub enum ImageSource {
    Clipboard,
    Screenshot,
    Drop,
    /// Image produced by the terminal itself (Sixel / iTerm OSC 1337).
    Terminal,
}

impl ImageSource {
    fn as_str(self) -> &'static str {
        match self {
            ImageSource::Clipboard => "clipboard",
            ImageSource::Screenshot => "screenshot",
            ImageSource::Drop => "drop",
            ImageSource::Terminal => "terminal",
        }
    }

    fn parse(s: &str) -> Result<Self, AppError> {
        Ok(match s {
            "clipboard" => ImageSource::Clipboard,
            "screenshot" => ImageSource::Screenshot,
            "drop" => ImageSource::Drop,
            "terminal" => ImageSource::Terminal,
            other => return Err(AppError::other(format!("unknown image source `{other}`"))),
        })
    }
}

/// A persisted image record. Binary payload lives on disk at `path`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/ipc/bindings/")]
pub struct Image {
    /// `img_xxxxxxxxxxxx` – also surfaced inline in the terminal as a badge.
    pub id: String,
    pub sha256: String,
    pub path: String,
    pub mime: String,
    pub width: i64,
    pub height: i64,
    pub bytes: i64,
    pub source: ImageSource,
    pub ocr_text: Option<String>,
    pub created_at: i64,
}

impl Image {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let src_s: String = row.get(7)?;
        let source = ImageSource::parse(&src_s).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(
                7,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    e.to_string(),
                )),
            )
        })?;
        Ok(Self {
            id: row.get(0)?,
            sha256: row.get(1)?,
            path: row.get(2)?,
            mime: row.get(3)?,
            width: row.get(4)?,
            height: row.get(5)?,
            bytes: row.get(6)?,
            source,
            ocr_text: row.get(8)?,
            created_at: row.get(9)?,
        })
    }
}

/// Parameters required to persist a fresh image record. The on-disk file at
/// `path` must already exist – this function only writes the SQL row.
#[derive(Debug, Clone)]
pub struct CreateImageParams {
    pub sha256: String,
    pub path: String,
    pub mime: String,
    pub width: i64,
    pub height: i64,
    pub bytes: i64,
    pub source: ImageSource,
}

/// Insert a new image. If the same `sha256` is already known, returns the
/// existing record instead (dedup by content hash).
pub fn create_image(db: &Db, params: CreateImageParams) -> Result<Image, AppError> {
    let conn = db.conn()?;

    if let Some(existing) = lookup_image_by_sha(&conn, &params.sha256)? {
        return Ok(existing);
    }

    let img = Image {
        id: short_id("img"),
        sha256: params.sha256,
        path: params.path,
        mime: params.mime,
        width: params.width,
        height: params.height,
        bytes: params.bytes,
        source: params.source,
        ocr_text: None,
        created_at: now_ms(),
    };
    conn.execute(
        "INSERT INTO images (\
            id, sha256, path, mime, width, height, bytes, source, ocr_text, created_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            img.id,
            img.sha256,
            img.path,
            img.mime,
            img.width,
            img.height,
            img.bytes,
            img.source.as_str(),
            img.ocr_text,
            img.created_at,
        ],
    )
    .map_err(map_sqlite_err)?;
    Ok(img)
}

fn lookup_image_by_sha(
    conn: &rusqlite::Connection,
    sha256: &str,
) -> Result<Option<Image>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, sha256, path, mime, width, height, bytes, source, ocr_text, created_at \
             FROM images WHERE sha256 = ?1",
        )
        .map_err(map_sqlite_err)?;
    let mut rows = stmt.query([sha256]).map_err(map_sqlite_err)?;
    match rows.next().map_err(map_sqlite_err)? {
        Some(row) => Ok(Some(Image::from_row(row).map_err(map_sqlite_err)?)),
        None => Ok(None),
    }
}

/// Fetch one image by id.
pub fn get_image(db: &Db, id: &str) -> Result<Option<Image>, AppError> {
    let conn = db.conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, sha256, path, mime, width, height, bytes, source, ocr_text, created_at \
             FROM images WHERE id = ?1",
        )
        .map_err(map_sqlite_err)?;
    let mut rows = stmt.query([id]).map_err(map_sqlite_err)?;
    match rows.next().map_err(map_sqlite_err)? {
        Some(row) => Ok(Some(Image::from_row(row).map_err(map_sqlite_err)?)),
        None => Ok(None),
    }
}

/// List recent images (newest first).
pub fn list_images(db: &Db, limit: i64) -> Result<Vec<Image>, AppError> {
    let limit = limit.max(1);
    let conn = db.conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, sha256, path, mime, width, height, bytes, source, ocr_text, created_at \
             FROM images ORDER BY created_at DESC LIMIT ?1",
        )
        .map_err(map_sqlite_err)?;
    let rows = stmt
        .query_map([limit], Image::from_row)
        .map_err(map_sqlite_err)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(map_sqlite_err)?);
    }
    Ok(out)
}

/// Persist the OCR text for an image. Pass `None` to clear it.
/// FTS5 triggers will re-index automatically.
pub fn set_ocr_text(db: &Db, id: &str, text: Option<&str>) -> Result<(), AppError> {
    let conn = db.conn()?;
    conn.execute(
        "UPDATE images SET ocr_text = ?1 WHERE id = ?2",
        rusqlite::params![text, id],
    )
    .map_err(map_sqlite_err)?;
    Ok(())
}

/// Attach an image to a block at a given display position.
pub fn attach_image_to_block(
    db: &Db,
    block_id: &str,
    image_id: &str,
    position: i64,
) -> Result<(), AppError> {
    let conn = db.conn()?;
    conn.execute(
        "INSERT OR REPLACE INTO block_images (block_id, image_id, position) \
         VALUES (?1, ?2, ?3)",
        rusqlite::params![block_id, image_id, position],
    )
    .map_err(map_sqlite_err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// AI conversations / exchanges
// ---------------------------------------------------------------------------

/// Header row for a Claude conversation (tied to a session).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/ipc/bindings/")]
pub struct AiConversation {
    pub id: String,
    pub session_id: String,
    pub title: Option<String>,
    pub model: String,
    pub created_at: i64,
}

impl AiConversation {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            session_id: row.get(1)?,
            title: row.get(2)?,
            model: row.get(3)?,
            created_at: row.get(4)?,
        })
    }
}

/// Create a fresh AI conversation linked to `session_id`.
pub fn create_ai_conversation(
    db: &Db,
    session_id: &str,
    model: &str,
    title: Option<&str>,
) -> Result<AiConversation, AppError> {
    let conv = AiConversation {
        id: short_id("conv"),
        session_id: session_id.to_owned(),
        title: title.map(|s| s.to_owned()),
        model: model.to_owned(),
        created_at: now_ms(),
    };
    let conn = db.conn()?;
    conn.execute(
        "INSERT INTO ai_conversations (id, session_id, title, model, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            conv.id,
            conv.session_id,
            conv.title,
            conv.model,
            conv.created_at,
        ],
    )
    .map_err(map_sqlite_err)?;
    Ok(conv)
}

/// List conversations attached to a session, newest first.
pub fn list_ai_conversations(db: &Db, session_id: &str) -> Result<Vec<AiConversation>, AppError> {
    let conn = db.conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, title, model, created_at \
             FROM ai_conversations WHERE session_id = ?1 ORDER BY created_at DESC",
        )
        .map_err(map_sqlite_err)?;
    let rows = stmt
        .query_map([session_id], AiConversation::from_row)
        .map_err(map_sqlite_err)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(map_sqlite_err)?);
    }
    Ok(out)
}

/// A single AI exchange (one role-tagged message).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/ipc/bindings/")]
pub struct AiExchange {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content_json: String,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub created_at: i64,
    pub sequence: i64,
}

impl AiExchange {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            conversation_id: row.get(1)?,
            role: row.get(2)?,
            content_json: row.get(3)?,
            input_tokens: row.get(4)?,
            output_tokens: row.get(5)?,
            created_at: row.get(6)?,
            sequence: row.get(7)?,
        })
    }
}

/// Parameters for [`append_ai_exchange`].
#[derive(Debug, Clone)]
pub struct AppendAiExchangeParams {
    pub conversation_id: String,
    pub role: String,
    pub content_json: String,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
}

/// Append an exchange to a conversation. Auto-increments `sequence`.
pub fn append_ai_exchange(db: &Db, params: AppendAiExchangeParams) -> Result<AiExchange, AppError> {
    let mut conn = db.conn()?;
    let tx = conn.transaction().map_err(map_sqlite_err)?;

    let next_seq: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM ai_exchanges \
             WHERE conversation_id = ?1",
            [&params.conversation_id],
            |row| row.get(0),
        )
        .map_err(map_sqlite_err)?;

    let ex = AiExchange {
        id: short_id("exch"),
        conversation_id: params.conversation_id,
        role: params.role,
        content_json: params.content_json,
        input_tokens: params.input_tokens,
        output_tokens: params.output_tokens,
        created_at: now_ms(),
        sequence: next_seq,
    };
    tx.execute(
        "INSERT INTO ai_exchanges (\
            id, conversation_id, role, content_json, input_tokens, output_tokens,\
            created_at, sequence\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            ex.id,
            ex.conversation_id,
            ex.role,
            ex.content_json,
            ex.input_tokens,
            ex.output_tokens,
            ex.created_at,
            ex.sequence,
        ],
    )
    .map_err(map_sqlite_err)?;
    tx.commit().map_err(map_sqlite_err)?;
    Ok(ex)
}

/// Fetch all exchanges for a conversation, oldest first.
pub fn list_ai_exchanges(db: &Db, conversation_id: &str) -> Result<Vec<AiExchange>, AppError> {
    let conn = db.conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, conversation_id, role, content_json, input_tokens, output_tokens, \
                    created_at, sequence \
             FROM ai_exchanges WHERE conversation_id = ?1 ORDER BY sequence ASC",
        )
        .map_err(map_sqlite_err)?;
    let rows = stmt
        .query_map([conversation_id], AiExchange::from_row)
        .map_err(map_sqlite_err)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(map_sqlite_err)?);
    }
    Ok(out)
}
