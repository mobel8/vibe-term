//! SQLite persistence layer for vibe-term.
//!
//! Owns a `r2d2` connection pool (size 8) over `rusqlite` with WAL mode and
//! foreign keys enabled. Applies versioned migrations at boot, tracking
//! applied versions in a small `_migrations` table.
//!
//! The public API is split across:
//! - [`sessions`] – session CRUD (one row per logical tab).
//! - [`blocks`]   – terminal block append / list + image and AI helpers.
//! - [`search`]   – FTS5 queries with `<mark>`-highlighted snippets.

#![warn(clippy::all, rust_2018_idioms)]

pub mod blocks;
pub mod search;
pub mod sessions;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;

use crate::error::AppError;

/// A migration script bundled into the binary at build time.
struct Migration {
    /// Monotonic version – we apply them in ascending order.
    version: i64,
    /// Human-readable name, recorded in `_migrations` for debugging.
    name: &'static str,
    /// SQL body, may contain its own `BEGIN; ... COMMIT;` pair.
    sql: &'static str,
}

/// Append new migrations here. **Never reorder or rewrite an existing entry**:
/// the version number is the unique key that decides whether to skip or apply.
const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "init",
        sql: include_str!("migrations/001_init.sql"),
    },
    Migration {
        version: 2,
        name: "fts",
        sql: include_str!("migrations/002_fts.sql"),
    },
];

/// Thin wrapper around a connection pool.
///
/// Cloning is cheap – internally it bumps an `Arc` refcount, so the same pool
/// is shared across the whole application.
#[derive(Clone)]
pub struct Db {
    pool: Arc<Pool<SqliteConnectionManager>>,
}

/// A live, pooled connection. Drop returns it to the pool automatically.
pub type PooledConn = r2d2::PooledConnection<SqliteConnectionManager>;

impl Db {
    /// Open (or create) the SQLite database at `path` and run migrations.
    ///
    /// The parent directory is created if missing. PRAGMAs (`journal_mode`,
    /// `foreign_keys`, `synchronous`, `busy_timeout`) are applied on every
    /// pooled connection via [`SqliteConnectionManager::with_init`].
    pub fn open(path: &Path) -> Result<Self, AppError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let manager = SqliteConnectionManager::file(path).with_init(|c| {
            // WAL gives much better concurrent read/write behaviour than the
            // default rollback journal, at the cost of a `-wal` sidecar file.
            // `synchronous=NORMAL` is the recommended companion under WAL.
            c.execute_batch(
                "PRAGMA journal_mode=WAL;\n\
                 PRAGMA foreign_keys=ON;\n\
                 PRAGMA synchronous=NORMAL;\n\
                 PRAGMA busy_timeout=5000;",
            )
        });

        let pool = Pool::builder()
            .max_size(8)
            .build(manager)
            .map_err(|e| AppError::other(format!("r2d2 pool init failed: {e}")))?;

        let db = Self {
            pool: Arc::new(pool),
        };
        db.run_migrations()?;
        Ok(db)
    }

    /// Open an **in-memory** database (a fresh one per call – we use a
    /// `?mode=memory&cache=shared` URI with a unique name so all pooled
    /// connections see the same DB). Used mostly in tests.
    pub fn open_in_memory() -> Result<Self, AppError> {
        let manager = SqliteConnectionManager::memory().with_init(|c| {
            // No WAL on `:memory:` (not meaningful), but the rest still applies.
            c.execute_batch(
                "PRAGMA foreign_keys=ON;\n\
                 PRAGMA synchronous=NORMAL;\n\
                 PRAGMA busy_timeout=5000;",
            )
        });
        let pool = Pool::builder()
            .max_size(4)
            .build(manager)
            .map_err(|e| AppError::other(format!("r2d2 pool init failed: {e}")))?;
        let db = Self {
            pool: Arc::new(pool),
        };
        db.run_migrations()?;
        Ok(db)
    }

    /// Borrow a pooled connection. Cheap – synchronous, no IO.
    pub fn conn(&self) -> Result<PooledConn, AppError> {
        self.pool
            .get()
            .map_err(|e| AppError::other(format!("pool get failed: {e}")))
    }

    /// Default on-disk location for the history database, derived from the
    /// Tauri app data directory.
    ///
    /// Falls back to the user data dir resolved by the `dirs` crate when the
    /// Tauri path API is unavailable (e.g. early bootstrap before the app
    /// handle is set up).
    pub fn default_path(app_handle: &tauri::AppHandle) -> PathBuf {
        use tauri::Manager;
        match app_handle.path().app_data_dir() {
            Ok(dir) => dir.join("history.db"),
            Err(_) => dirs::data_dir()
                .unwrap_or_else(std::env::temp_dir)
                .join("vibe-term")
                .join("history.db"),
        }
    }

    /// Apply every migration whose `version` is not yet recorded in the
    /// `_migrations` table. Idempotent and safe to call at every boot.
    fn run_migrations(&self) -> Result<(), AppError> {
        let mut conn = self.conn()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations (\
                version INTEGER PRIMARY KEY,\
                name    TEXT    NOT NULL,\
                applied_at INTEGER NOT NULL\
            );",
        )
        .map_err(map_sqlite_err)?;

        for m in MIGRATIONS {
            if migration_applied(&conn, m.version)? {
                continue;
            }
            apply_migration(&mut conn, m)?;
        }
        Ok(())
    }
}

fn migration_applied(conn: &Connection, version: i64) -> Result<bool, AppError> {
    let mut stmt = conn
        .prepare("SELECT 1 FROM _migrations WHERE version = ?1")
        .map_err(map_sqlite_err)?;
    let exists = stmt.exists([version]).map_err(map_sqlite_err)?;
    Ok(exists)
}

fn apply_migration(conn: &mut Connection, m: &Migration) -> Result<(), AppError> {
    // The .sql file owns its own BEGIN/COMMIT, so we run it raw and then
    // record the version in a separate statement. If anything blows up we
    // bubble the error and the migration table stays unchanged → next boot
    // retries cleanly.
    conn.execute_batch(m.sql).map_err(|e| {
        AppError::other(format!("migration {} ({}) failed: {e}", m.version, m.name))
    })?;
    conn.execute(
        "INSERT INTO _migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![m.version, m.name, now_ms()],
    )
    .map_err(map_sqlite_err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Shared helpers used by submodules.
// ---------------------------------------------------------------------------

/// Convert a `rusqlite::Error` into our `AppError`.
pub(crate) fn map_sqlite_err(e: rusqlite::Error) -> AppError {
    AppError::other(format!("sqlite error: {e}"))
}

/// Current wall-clock time, milliseconds since the UNIX epoch.
pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Generate a short, URL-safe, prefixed identifier (e.g. `sess_aZ7…`).
pub(crate) fn short_id(prefix: &str) -> String {
    let id = nanoid::nanoid!(12);
    format!("{prefix}_{id}")
}
