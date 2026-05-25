//! Session → Markdown / HTML exporter (Phase 5 deliverable).
//!
//! Serialises an entire SQLite session — the [`Session`] row, its ordered
//! [`Block`]s, every linked [`Image`], and (optionally) its
//! [`AiConversation`] history — into a renderable document. Targets the user
//! flow "Export session as Markdown / HTML — both renderable in a browser"
//! from `v1-acceptance.md` § E.
//!
//! The module is storage-agnostic: image bytes are read straight from
//! [`Image::path`] via [`std::fs::read`] when embedding is requested, so it
//! works regardless of how the [`crate::images::ImageManager`] organises its
//! on-disk layout. Missing image files are tolerated and surfaced inline as
//! plain text so a stale DB never blocks an export.
//!
//! The public API is intentionally tiny:
//! - [`render_session`] returns the document as a [`String`].
//! - [`export_session_to_file`] writes that string to disk (creating parent
//!   dirs as needed).
//!
//! Both entry points dispatch on [`ExportFormat`]; the per-format work lives
//! in [`markdown`] and [`html`].

#![warn(clippy::all, rust_2018_idioms)]

pub mod html;
pub mod markdown;

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::store::blocks::{
    self, AiConversation, AiExchange, Block, BlockKind, Image,
};
use crate::store::{sessions, Db};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Which output format [`render_session`] / [`export_session_to_file`] emit.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    /// CommonMark-ish Markdown with fenced code blocks. Renderable as-is by
    /// GitHub, GitLab, VS Code, etc.
    Markdown,
    /// Standalone HTML document with a small embedded stylesheet. Drop the
    /// file into a browser; no external assets required.
    Html,
}

/// Knobs callers can flip when invoking [`render_session`].
///
/// Defaults are tuned for the "share with a teammate" use case: embed every
/// image inline so the resulting document is a single self-contained file,
/// and include the AI conversation appendix if the session has one.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportOptions {
    /// When `true`, images are inlined as `data:` URIs (Markdown) or
    /// base64-encoded `<img>` tags (HTML). When `false`, only the
    /// `img_xxxxxx` identifier is referenced — useful when the export is
    /// going to live next to a separate image folder.
    #[serde(default = "default_embed_images")]
    pub embed_images: bool,
    /// When `true`, every [`AiConversation`] tied to the session is appended
    /// to the document at the end, in creation order, with its full exchange
    /// history.
    #[serde(default = "default_include_ai")]
    pub include_ai: bool,
}

fn default_embed_images() -> bool {
    true
}

fn default_include_ai() -> bool {
    true
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            embed_images: default_embed_images(),
            include_ai: default_include_ai(),
        }
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Render `session_id` to `format` and return the document as a [`String`].
///
/// Returns an [`AppError::InvalidInput`] when the session does not exist;
/// other failures (SQL, IO when embedding an image) bubble up via
/// [`AppError`] as-is.
pub fn render_session(
    db: &Db,
    session_id: &str,
    format: ExportFormat,
    opts: &ExportOptions,
) -> Result<String, AppError> {
    let bundle = load_bundle(db, session_id, opts)?;
    match format {
        ExportFormat::Markdown => markdown::render_markdown(&bundle, opts),
        ExportFormat::Html => html::render_html(&bundle, opts),
    }
}

/// Render and write to `output_path`. Parent directories are created if
/// missing. The file is overwritten if it already exists.
pub fn export_session_to_file(
    db: &Db,
    session_id: &str,
    output_path: &Path,
    format: ExportFormat,
    opts: &ExportOptions,
) -> Result<(), AppError> {
    let body = render_session(db, session_id, format, opts)?;
    if let Some(parent) = output_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    std::fs::write(output_path, body)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Shared internals — exposed to sibling modules only.
// ---------------------------------------------------------------------------

/// In-memory snapshot of everything an exporter needs for one session.
///
/// Hydrating once up-front avoids both renderers re-issuing the same SQL
/// queries and keeps the formatter functions pure (`&Bundle -> String`),
/// which in turn makes them trivial to unit-test.
pub(crate) struct Bundle {
    pub(crate) session: sessions::Session,
    /// Blocks ordered by `sequence ASC`.
    pub(crate) blocks: Vec<BlockWithImages>,
    /// Empty when [`ExportOptions::include_ai`] is `false`.
    pub(crate) conversations: Vec<ConversationWithExchanges>,
}

/// A [`Block`] paired with every image attached to it (in `position ASC`
/// order). Images are not part of the [`Block`] struct in the store layer,
/// so we hydrate them once here.
pub(crate) struct BlockWithImages {
    pub(crate) block: Block,
    pub(crate) images: Vec<Image>,
}

/// An [`AiConversation`] paired with its full exchange history.
pub(crate) struct ConversationWithExchanges {
    pub(crate) conversation: AiConversation,
    pub(crate) exchanges: Vec<AiExchange>,
}

/// Load every row the renderers need in one pass.
fn load_bundle(db: &Db, session_id: &str, opts: &ExportOptions) -> Result<Bundle, AppError> {
    let session = sessions::get(db, session_id)?.ok_or_else(|| {
        AppError::InvalidInput(format!("session `{session_id}` does not exist"))
    })?;

    // We page through the blocks in chunks rather than asking for an
    // unbounded LIMIT — the underlying helper enforces `limit >= 1` so we
    // cannot pass `i64::MAX` safely without splitting the call.
    const PAGE: i64 = 500;
    let mut blocks_raw: Vec<Block> = Vec::new();
    let mut offset: i64 = 0;
    loop {
        let page = blocks::list_for_session(db, session_id, PAGE, offset)?;
        if page.is_empty() {
            break;
        }
        let got = page.len() as i64;
        blocks_raw.extend(page);
        if got < PAGE {
            break;
        }
        offset += got;
    }

    let mut blocks_out = Vec::with_capacity(blocks_raw.len());
    for b in blocks_raw {
        let images = list_images_for_block(db, &b.id)?;
        blocks_out.push(BlockWithImages { block: b, images });
    }

    let conversations = if opts.include_ai {
        load_conversations(db, session_id)?
    } else {
        Vec::new()
    };

    Ok(Bundle {
        session,
        blocks: blocks_out,
        conversations,
    })
}

/// Read every image attached to `block_id` via the `block_images` join, in
/// `position ASC` order. We inline this query here because the `blocks`
/// module does not (yet) ship a dedicated helper.
fn list_images_for_block(db: &Db, block_id: &str) -> Result<Vec<Image>, AppError> {
    let conn = db.conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT i.id, i.sha256, i.path, i.mime, i.width, i.height, i.bytes, \
                    i.source, i.ocr_text, i.created_at \
             FROM images i \
             JOIN block_images bi ON bi.image_id = i.id \
             WHERE bi.block_id = ?1 \
             ORDER BY bi.position ASC",
        )
        .map_err(map_sqlite_err)?;
    let rows = stmt
        .query_map([block_id], image_from_row)
        .map_err(map_sqlite_err)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(map_sqlite_err)?);
    }
    Ok(out)
}

/// Hydrate every conversation tied to `session_id` along with its full
/// exchange history. Conversations are returned oldest-first so the
/// appendix reads chronologically — the store helper sorts them
/// `created_at DESC`, so we reverse the slice in place.
fn load_conversations(
    db: &Db,
    session_id: &str,
) -> Result<Vec<ConversationWithExchanges>, AppError> {
    let mut convs = blocks::list_ai_conversations(db, session_id)?;
    convs.reverse();
    let mut out = Vec::with_capacity(convs.len());
    for c in convs {
        let exchanges = blocks::list_ai_exchanges(db, &c.id)?;
        out.push(ConversationWithExchanges {
            conversation: c,
            exchanges,
        });
    }
    Ok(out)
}

// `Image::from_row` is private to the store module, so we re-implement the
// minimal projection we need here. Kept colocated so the two stay in sync
// if the schema grows.
fn image_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Image> {
    use crate::store::blocks::ImageSource;
    let src_s: String = row.get(7)?;
    let source = match src_s.as_str() {
        "clipboard" => ImageSource::Clipboard,
        "screenshot" => ImageSource::Screenshot,
        "drop" => ImageSource::Drop,
        "terminal" => ImageSource::Terminal,
        other => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                7,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("unknown image source `{other}`"),
                )),
            ));
        }
    };
    Ok(Image {
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

fn map_sqlite_err(e: rusqlite::Error) -> AppError {
    AppError::other(format!("sqlite error: {e}"))
}

/// Format a millisecond UNIX timestamp as ISO 8601 / RFC 3339 in UTC.
/// Shared between the markdown and html renderers.
pub(crate) fn format_iso_ms(ms: i64) -> String {
    use chrono::TimeZone;
    chrono::Utc
        .timestamp_millis_opt(ms)
        .single()
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_else(|| format!("{ms}ms"))
}

/// Read an image's bytes from disk and base64-encode them. Returns `None`
/// when the file is unreadable so the renderers can fall back to a textual
/// reference instead of failing the whole export.
pub(crate) fn read_image_base64(image: &Image) -> Option<String> {
    use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
    use base64::Engine as _;

    let bytes = std::fs::read(&image.path).ok()?;
    Some(BASE64_STANDARD.encode(bytes))
}

/// Short, human-friendly tag for an AI exchange role. Roles are stored as
/// free-form text on disk (`"user"` / `"assistant"` from the API), so we
/// title-case the common cases and pass anything else through verbatim.
pub(crate) fn pretty_role(role: &str) -> &str {
    match role {
        "user" => "User",
        "assistant" => "Assistant",
        "system" => "System",
        other => other,
    }
}

/// Heuristically extract a plain-text snippet from an `ai_exchanges` row's
/// `content_json`. The schema stores either:
/// - a raw string (`"hello"`),
/// - a single content block (`{"type":"text","text":"hi"}`),
/// - or an array of content blocks (the Anthropic SDK shape).
///
/// We try each in turn and fall back to the raw JSON when nothing matches,
/// so the export never silently drops text.
pub(crate) fn extract_exchange_text(content_json: &str) -> String {
    if let Ok(serde_json::Value::String(s)) = serde_json::from_str::<serde_json::Value>(content_json) {
        return s;
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(content_json) {
        if let Some(text) = v.get("text").and_then(|t| t.as_str()) {
            return text.to_owned();
        }
        if let Some(arr) = v.as_array() {
            let mut buf = String::new();
            for part in arr {
                if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(t);
                }
            }
            if !buf.is_empty() {
                return buf;
            }
        }
    }
    content_json.to_owned()
}

/// Short human label for a block kind. Used in section headers.
pub(crate) fn block_kind_label(kind: BlockKind) -> &'static str {
    match kind {
        BlockKind::Command => "Command",
        BlockKind::Output => "Output",
        BlockKind::AiUser => "AI · User",
        BlockKind::AiAssistant => "AI · Assistant",
        BlockKind::System => "System",
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_default_embeds_and_includes_ai() {
        let opts = ExportOptions::default();
        assert!(opts.embed_images);
        assert!(opts.include_ai);
    }

    #[test]
    fn options_deserialise_with_missing_fields() {
        // Both fields are `#[serde(default = …)]`, so an empty object must
        // round-trip into the defaults.
        let opts: ExportOptions = serde_json::from_str("{}").unwrap();
        assert!(opts.embed_images);
        assert!(opts.include_ai);
    }

    #[test]
    fn format_serialises_lowercase() {
        let md = serde_json::to_string(&ExportFormat::Markdown).unwrap();
        let html = serde_json::to_string(&ExportFormat::Html).unwrap();
        assert_eq!(md, "\"markdown\"");
        assert_eq!(html, "\"html\"");
    }

    #[test]
    fn format_iso_ms_emits_rfc3339() {
        // 0ms since epoch is `1970-01-01T00:00:00Z`.
        let s = format_iso_ms(0);
        assert_eq!(s, "1970-01-01T00:00:00Z");
    }

    #[test]
    fn extract_text_from_raw_string() {
        assert_eq!(extract_exchange_text("\"hello world\""), "hello world");
    }

    #[test]
    fn extract_text_from_object() {
        let s = r#"{"type":"text","text":"hi there"}"#;
        assert_eq!(extract_exchange_text(s), "hi there");
    }

    #[test]
    fn extract_text_from_array() {
        let s = r#"[{"type":"text","text":"line 1"},{"type":"text","text":"line 2"}]"#;
        assert_eq!(extract_exchange_text(s), "line 1\nline 2");
    }

    #[test]
    fn extract_text_falls_back_to_raw() {
        let s = "not-json-at-all";
        assert_eq!(extract_exchange_text(s), "not-json-at-all");
    }

    #[test]
    fn pretty_role_maps_known_values() {
        assert_eq!(pretty_role("user"), "User");
        assert_eq!(pretty_role("assistant"), "Assistant");
        assert_eq!(pretty_role("tool"), "tool");
    }
}
