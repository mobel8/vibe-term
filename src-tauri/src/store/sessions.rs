//! Session CRUD.
//!
//! A "session" is a logical workspace (typically one tab). It owns blocks,
//! images (via `block_images`), and AI conversations through foreign keys –
//! deleting a session cascades to all dependents.

#![warn(clippy::all, rust_2018_idioms)]

use rusqlite::Row;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::AppError;

use super::{map_sqlite_err, now_ms, short_id, Db};

/// A persisted session row.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/ipc/bindings/")]
pub struct Session {
    /// `sess_xxxxxxxxxxxx` – stable, URL-safe.
    pub id: String,
    /// User-visible title (defaults to the shell name on creation).
    pub name: String,
    /// Milliseconds since UNIX epoch.
    pub created_at: i64,
    /// Updated on every `touch` / structural mutation.
    pub updated_at: i64,
    /// Arbitrary opaque JSON for UI metadata (icon, color, …).
    pub metadata_json: Option<String>,
}

impl Session {
    /// Parse a row of `SELECT id, name, created_at, updated_at, metadata_json …`.
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            name: row.get(1)?,
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
            metadata_json: row.get(4)?,
        })
    }
}

/// Insert a new session and return it (id, timestamps populated).
pub fn create(db: &Db, name: &str) -> Result<Session, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidInput("session name is empty".into()));
    }

    let session = Session {
        id: short_id("sess"),
        name: name.to_owned(),
        created_at: now_ms(),
        updated_at: now_ms(),
        metadata_json: None,
    };

    let conn = db.conn()?;
    conn.execute(
        "INSERT INTO sessions (id, name, created_at, updated_at, metadata_json) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            session.id,
            session.name,
            session.created_at,
            session.updated_at,
            session.metadata_json,
        ],
    )
    .map_err(map_sqlite_err)?;

    Ok(session)
}

/// List sessions ordered by `updated_at DESC` (most recent first).
pub fn list(db: &Db, limit: i64) -> Result<Vec<Session>, AppError> {
    let limit = limit.max(1);
    let conn = db.conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, created_at, updated_at, metadata_json \
             FROM sessions ORDER BY updated_at DESC LIMIT ?1",
        )
        .map_err(map_sqlite_err)?;
    let rows = stmt
        .query_map([limit], Session::from_row)
        .map_err(map_sqlite_err)?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(map_sqlite_err)?);
    }
    Ok(out)
}

/// Fetch a single session by id. Returns `Ok(None)` if it does not exist.
pub fn get(db: &Db, id: &str) -> Result<Option<Session>, AppError> {
    let conn = db.conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, created_at, updated_at, metadata_json \
             FROM sessions WHERE id = ?1",
        )
        .map_err(map_sqlite_err)?;
    let mut rows = stmt.query([id]).map_err(map_sqlite_err)?;
    match rows.next().map_err(map_sqlite_err)? {
        Some(row) => Ok(Some(Session::from_row(row).map_err(map_sqlite_err)?)),
        None => Ok(None),
    }
}

/// Bump `updated_at` to "now". No-op if the session does not exist.
pub fn touch(db: &Db, id: &str) -> Result<(), AppError> {
    let conn = db.conn()?;
    conn.execute(
        "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now_ms(), id],
    )
    .map_err(map_sqlite_err)?;
    Ok(())
}

/// Delete a session and (via `ON DELETE CASCADE`) all its blocks / AI rows.
pub fn delete(db: &Db, id: &str) -> Result<(), AppError> {
    let conn = db.conn()?;
    conn.execute("DELETE FROM sessions WHERE id = ?1", [id])
        .map_err(map_sqlite_err)?;
    Ok(())
}

/// Patch the user-visible name. Trims whitespace and rejects empty values.
pub fn rename(db: &Db, id: &str, new_name: &str) -> Result<(), AppError> {
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err(AppError::InvalidInput("session name is empty".into()));
    }
    let conn = db.conn()?;
    conn.execute(
        "UPDATE sessions SET name = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![new_name, now_ms(), id],
    )
    .map_err(map_sqlite_err)?;
    Ok(())
}
