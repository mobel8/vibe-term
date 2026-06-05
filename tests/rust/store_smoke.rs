//! End-to-end smoke test for the SQLite store layer.
//!
//! Covers the happy path used by the Tauri commands: open a fresh on-disk
//! DB, run migrations, create a session, append blocks, list them, count
//! them, and search them through FTS5.

use std::path::PathBuf;

use vibe_term_lib::store::{
    blocks::{self, AppendBlockParams, BlockKind, CreateImageParams, ImageSource},
    search, sessions, Db,
};

/// Build a unique tempfile path under the OS temp dir.
fn temp_db_path() -> PathBuf {
    let mut p = std::env::temp_dir();
    let suffix = nanoid::nanoid!(10);
    p.push(format!("vibe-term-smoke-{suffix}.db"));
    p
}

struct DbGuard {
    path: PathBuf,
    db: Db,
}

impl DbGuard {
    fn open() -> Self {
        let path = temp_db_path();
        let db = Db::open(&path).expect("open db");
        Self { path, db }
    }
}

impl Drop for DbGuard {
    fn drop(&mut self) {
        // Best-effort cleanup of the main DB file plus the WAL sidecars.
        let _ = std::fs::remove_file(&self.path);
        let wal = self.path.with_extension("db-wal");
        let shm = self.path.with_extension("db-shm");
        let _ = std::fs::remove_file(wal);
        let _ = std::fs::remove_file(shm);
    }
}

#[test]
fn migrations_create_expected_tables() {
    let g = DbGuard::open();
    let conn = g.db.conn().unwrap();
    // All baseline tables and FTS virtual tables should exist.
    for name in [
        "sessions",
        "blocks",
        "images",
        "block_images",
        "ai_conversations",
        "ai_exchanges",
        "blocks_fts",
        "images_fts",
        "_migrations",
    ] {
        let found: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
                [name],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            found > 0,
            "expected table `{name}` to exist after migrations"
        );
    }

    // Migrations should be recorded.
    let applied: i64 = conn
        .query_row("SELECT COUNT(*) FROM _migrations", [], |row| row.get(0))
        .unwrap();
    assert_eq!(applied, 3, "three migrations expected");
}

#[test]
fn idempotent_migrations() {
    // Opening the same path twice must not re-apply migrations.
    let path = temp_db_path();
    {
        let _db = Db::open(&path).unwrap();
    }
    let db = Db::open(&path).unwrap();
    let conn = db.conn().unwrap();
    let applied: i64 = conn
        .query_row("SELECT COUNT(*) FROM _migrations", [], |row| row.get(0))
        .unwrap();
    assert_eq!(applied, 3);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
}

#[test]
fn session_block_search_round_trip() {
    let g = DbGuard::open();
    let db = &g.db;

    // 1. Create session.
    let session = sessions::create(db, "smoke session").unwrap();
    assert!(session.id.starts_with("sess_"));
    assert_eq!(session.name, "smoke session");

    // 2. Append 3 blocks: 1 command + 2 outputs.
    let cmd = blocks::append(
        db,
        AppendBlockParams {
            session_id: session.id.clone(),
            pty_id: Some("pty-1".into()),
            kind: BlockKind::Command,
            content: "ls -la /tmp".into(),
            ansi_raw: None,
            exit_code: None,
            duration_ms: None,
        },
    )
    .unwrap();
    assert_eq!(cmd.sequence, 1);
    assert_eq!(cmd.kind, BlockKind::Command);

    let out1 = blocks::append(
        db,
        AppendBlockParams {
            session_id: session.id.clone(),
            pty_id: Some("pty-1".into()),
            kind: BlockKind::Output,
            content: "total 0\ndrwxrwxrwt 12 root root 4096 May 25 08:00 .".into(),
            ansi_raw: None,
            exit_code: Some(0),
            duration_ms: Some(12),
        },
    )
    .unwrap();
    assert_eq!(out1.sequence, 2);

    let out2 = blocks::append(
        db,
        AppendBlockParams {
            session_id: session.id.clone(),
            pty_id: Some("pty-1".into()),
            kind: BlockKind::Output,
            content: "drwxr-xr-x 22 root root 4096 May 25 06:00 ..".into(),
            ansi_raw: None,
            exit_code: Some(0),
            duration_ms: Some(8),
        },
    )
    .unwrap();
    assert_eq!(out2.sequence, 3);

    // 3. List blocks.
    let listed = blocks::list_for_session(db, &session.id, 100, 0).unwrap();
    assert_eq!(listed.len(), 3);
    assert_eq!(listed[0].id, cmd.id);
    assert_eq!(listed[1].id, out1.id);
    assert_eq!(listed[2].id, out2.id);

    // 4. Count.
    let n = blocks::count_for_session(db, &session.id).unwrap();
    assert_eq!(n, 3);

    // 5. FTS search: "ls" should match the command block only.
    let hits = search::search_blocks(db, "ls", None, 10).unwrap();
    assert!(!hits.is_empty(), "expected at least one match for `ls`");
    assert!(
        hits.iter().any(|h| h.block_id == cmd.id),
        "command block should be among the matches"
    );
    // The snippet must contain a <mark> wrapper around the match.
    let mark_hit = hits.iter().find(|h| h.block_id == cmd.id).unwrap();
    assert!(
        mark_hit.snippet.contains("<mark>"),
        "snippet should contain <mark> tags, got `{}`",
        mark_hit.snippet
    );

    // 6. FTS search restricted by session: same result, no leak.
    let hits_in_session = search::search_blocks(db, "ls", Some(&session.id), 10).unwrap();
    assert_eq!(hits_in_session.len(), hits.len());

    // 7. Output-specific term should only hit output blocks.
    let drw_hits = search::search_blocks(db, "drwxr", None, 10).unwrap();
    assert!(!drw_hits.is_empty());
    assert!(drw_hits.iter().all(|h| h.block_id != cmd.id));

    // 8. Touch + rename keep the row in shape.
    sessions::touch(db, &session.id).unwrap();
    sessions::rename(db, &session.id, "renamed").unwrap();
    let after = sessions::get(db, &session.id).unwrap().unwrap();
    assert_eq!(after.name, "renamed");

    // 9. list returns the freshly-touched session.
    let ls = sessions::list(db, 10).unwrap();
    assert!(ls.iter().any(|s| s.id == session.id));
}

#[test]
fn image_dedup_by_sha256_and_ocr_search() {
    let g = DbGuard::open();
    let db = &g.db;

    // Two distinct create_image calls with the same sha must collapse.
    let img1 = blocks::create_image(
        db,
        CreateImageParams {
            sha256: "deadbeef".into(),
            path: "/tmp/a.png".into(),
            mime: "image/png".into(),
            width: 800,
            height: 600,
            bytes: 1234,
            source: ImageSource::Clipboard,
        },
    )
    .unwrap();
    let img2 = blocks::create_image(
        db,
        CreateImageParams {
            sha256: "deadbeef".into(),
            path: "/tmp/b.png".into(), // ignored because the row already exists
            mime: "image/png".into(),
            width: 800,
            height: 600,
            bytes: 1234,
            source: ImageSource::Clipboard,
        },
    )
    .unwrap();
    assert_eq!(img1.id, img2.id);
    assert_eq!(img1.path, img2.path);

    // OCR text triggers FTS5 indexing via the AFTER UPDATE trigger.
    blocks::set_ocr_text(db, &img1.id, Some("Hello rusqlite world")).unwrap();
    let hits = search::search_images(db, "rusqlite", 10).unwrap();
    assert!(
        hits.iter().any(|h| h.image_id == img1.id),
        "image should be found by OCR text after update"
    );

    // Clearing the OCR text removes it from the FTS index.
    blocks::set_ocr_text(db, &img1.id, None).unwrap();
    let cleared = search::search_images(db, "rusqlite", 10).unwrap();
    assert!(
        cleared.iter().all(|h| h.image_id != img1.id),
        "image should no longer match after OCR cleared"
    );
}

#[test]
fn ai_helpers_round_trip() {
    let g = DbGuard::open();
    let db = &g.db;

    let session = sessions::create(db, "ai session").unwrap();
    let conv = blocks::create_ai_conversation(
        db,
        &session.id,
        "claude-opus-4-7",
        "anthropic",
        Some("first convo"),
    )
    .unwrap();
    assert_eq!(conv.session_id, session.id);
    assert_eq!(conv.provider, "anthropic");

    let convs = blocks::list_ai_conversations(db, &session.id).unwrap();
    assert_eq!(convs.len(), 1);
    assert_eq!(convs[0].id, conv.id);
    assert_eq!(convs[0].provider, "anthropic");

    let user_msg = blocks::append_ai_exchange(
        db,
        blocks::AppendAiExchangeParams {
            conversation_id: conv.id.clone(),
            role: "user".into(),
            content_json: r#"{"type":"text","text":"hi"}"#.into(),
            input_tokens: Some(10),
            output_tokens: None,
        },
    )
    .unwrap();
    assert_eq!(user_msg.sequence, 1);

    let assistant_msg = blocks::append_ai_exchange(
        db,
        blocks::AppendAiExchangeParams {
            conversation_id: conv.id.clone(),
            role: "assistant".into(),
            content_json: r#"{"type":"text","text":"hello!"}"#.into(),
            input_tokens: None,
            output_tokens: Some(8),
        },
    )
    .unwrap();
    assert_eq!(assistant_msg.sequence, 2);

    let history = blocks::list_ai_exchanges(db, &conv.id).unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].role, "user");
    assert_eq!(history[1].role, "assistant");
}

#[test]
fn in_memory_db_supports_full_round_trip() {
    let db = Db::open_in_memory().unwrap();
    let session = sessions::create(&db, "mem").unwrap();
    let block = blocks::append(
        &db,
        AppendBlockParams {
            session_id: session.id.clone(),
            pty_id: None,
            kind: BlockKind::System,
            content: "boot complete".into(),
            ansi_raw: None,
            exit_code: None,
            duration_ms: None,
        },
    )
    .unwrap();
    let hits = search::search_blocks(&db, "boot", None, 5).unwrap();
    assert!(hits.iter().any(|h| h.block_id == block.id));
}
