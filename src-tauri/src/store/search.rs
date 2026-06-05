//! FTS5 search helpers.
//!
//! We expose two thin wrappers over the `blocks_fts` and `images_fts` virtual
//! tables, both joined back to the canonical row to surface metadata (session
//! id, image id, …) alongside the highlighted snippet.
//!
//! Queries from the user are wrapped as an FTS5 *phrase* (with each
//! whitespace-separated term double-quoted and a trailing `*` for prefix
//! match). This avoids surprising operator parsing on user-typed strings
//! while preserving FTS5 injection safety – we never interpolate user text
//! into the SQL itself, only into a parameter passed to `MATCH`.

#![warn(clippy::all, rust_2018_idioms)]

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::AppError;

use super::{map_sqlite_err, Db};

/// One hit returned by [`search_blocks`].
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/ipc/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// `blocks.id` of the matching row.
    pub block_id: String,
    /// `blocks.session_id` of the matching row.
    pub session_id: String,
    /// HTML snippet with `<mark>…</mark>` wrappers around matched terms.
    pub snippet: String,
    /// FTS5 `bm25` score (lower = better match).
    pub rank: f64,
}

/// Search block content. Optionally restrict to a single session.
///
/// `query` is the raw user input (e.g. `git push`). Returns up to `limit`
/// rows sorted by relevance.
pub fn search_blocks(
    db: &Db,
    query: &str,
    session: Option<&str>,
    limit: i64,
) -> Result<Vec<SearchHit>, AppError> {
    let limit = limit.max(1);
    let fts_query = build_fts_query(query)?;

    let conn = db.conn()?;

    // We build the SQL up-front to keep the two branches (with/without a
    // session filter) statically analysable by the SQLite query planner.
    let sql = if session.is_some() {
        "SELECT b.id, b.session_id, \
                snippet(blocks_fts, 0, '<mark>', '</mark>', '…', 24), \
                bm25(blocks_fts) AS rank \
         FROM blocks_fts \
         JOIN blocks b ON b.rowid = blocks_fts.rowid \
         WHERE blocks_fts MATCH ?1 AND b.session_id = ?2 \
         ORDER BY rank LIMIT ?3"
    } else {
        "SELECT b.id, b.session_id, \
                snippet(blocks_fts, 0, '<mark>', '</mark>', '…', 24), \
                bm25(blocks_fts) AS rank \
         FROM blocks_fts \
         JOIN blocks b ON b.rowid = blocks_fts.rowid \
         WHERE blocks_fts MATCH ?1 \
         ORDER BY rank LIMIT ?2"
    };

    let mut stmt = conn.prepare(sql).map_err(map_sqlite_err)?;

    let row_to_hit = |row: &rusqlite::Row<'_>| -> rusqlite::Result<SearchHit> {
        Ok(SearchHit {
            block_id: row.get(0)?,
            session_id: row.get(1)?,
            snippet: row.get(2)?,
            rank: row.get(3)?,
        })
    };

    let mut out = Vec::new();
    if let Some(session_id) = session {
        let rows = stmt
            .query_map(rusqlite::params![fts_query, session_id, limit], row_to_hit)
            .map_err(map_sqlite_err)?;
        for r in rows {
            out.push(r.map_err(map_sqlite_err)?);
        }
    } else {
        let rows = stmt
            .query_map(rusqlite::params![fts_query, limit], row_to_hit)
            .map_err(map_sqlite_err)?;
        for r in rows {
            out.push(r.map_err(map_sqlite_err)?);
        }
    }
    Ok(out)
}

/// Image-OCR search hit.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/ipc/bindings/")]
pub struct ImageSearchHit {
    pub image_id: String,
    pub snippet: String,
    pub rank: f64,
}

/// Search OCR text across all images.
pub fn search_images(db: &Db, query: &str, limit: i64) -> Result<Vec<ImageSearchHit>, AppError> {
    let limit = limit.max(1);
    let fts_query = build_fts_query(query)?;

    let conn = db.conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT i.id, \
                    snippet(images_fts, 0, '<mark>', '</mark>', '…', 24), \
                    bm25(images_fts) AS rank \
             FROM images_fts \
             JOIN images i ON i.rowid = images_fts.rowid \
             WHERE images_fts MATCH ?1 \
             ORDER BY rank LIMIT ?2",
        )
        .map_err(map_sqlite_err)?;

    let rows = stmt
        .query_map(rusqlite::params![fts_query, limit], |row| {
            Ok(ImageSearchHit {
                image_id: row.get(0)?,
                snippet: row.get(1)?,
                rank: row.get(2)?,
            })
        })
        .map_err(map_sqlite_err)?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(map_sqlite_err)?);
    }
    Ok(out)
}

/// Turn a raw user query into a safe FTS5 MATCH expression.
///
/// Strategy: split on whitespace, drop empty tokens, escape embedded
/// double-quotes per FTS5 grammar (`""`), wrap each token in `"…"`, then
/// append `*` for prefix matching. The result is e.g.:
///
/// ```text
/// "git"* "push"*
/// ```
///
/// FTS5 treats this as a phrase-and-prefix query, which is the natural
/// "as-you-type" search behaviour. We refuse empty queries up front.
fn build_fts_query(raw: &str) -> Result<String, AppError> {
    let mut tokens: Vec<String> = raw
        .split_whitespace()
        // Strip control characters (notably embedded NUL, which would
        // truncate the bound C string in SQLite and break the MATCH with
        // an "unterminated string" error) before quoting.
        .map(|t| t.chars().filter(|c| !c.is_control()).collect::<String>())
        .filter(|t| !t.is_empty())
        .map(|t| {
            // Per FTS5 syntax: double-quote a string and escape internal
            // double-quotes by doubling them.
            let escaped = t.replace('"', "\"\"");
            format!("\"{escaped}\"*")
        })
        .collect();

    if tokens.is_empty() {
        return Err(AppError::InvalidInput("search query is empty".into()));
    }

    // Cap to a sane number of tokens to keep query planning fast.
    tokens.truncate(16);
    Ok(tokens.join(" "))
}

#[cfg(test)]
mod tests {
    use super::build_fts_query;

    #[test]
    fn builds_prefix_phrase_query() {
        let q = build_fts_query("git push").unwrap();
        assert_eq!(q, "\"git\"* \"push\"*");
    }

    #[test]
    fn escapes_double_quotes() {
        let q = build_fts_query(r#"say "hi""#).unwrap();
        assert_eq!(q, "\"say\"* \"\"\"hi\"\"\"*");
    }

    #[test]
    fn rejects_empty_query() {
        assert!(build_fts_query("   ").is_err());
    }
}
