//! End-to-end smoke test for the session exporter.
//!
//! Mirrors the style of `store_smoke.rs`: spin up an in-memory [`Db`], seed
//! sessions / blocks / images / AI exchanges through the public store API,
//! then assert on the output of [`vibe_term_lib::export::render_session`] and
//! [`vibe_term_lib::export::export_session_to_file`].

use std::path::PathBuf;

use vibe_term_lib::export::{
    self, export_session_to_file, render_session, ExportFormat, ExportOptions,
};
use vibe_term_lib::store::{
    blocks::{
        self, AppendBlockParams, BlockKind, CreateImageParams, ImageSource,
    },
    sessions, Db,
};

fn fresh_db() -> Db {
    Db::open_in_memory().expect("open in-memory db")
}

fn temp_path(name: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    let suffix = nanoid::nanoid!(10);
    p.push(format!("vibe-term-export-{name}-{suffix}"));
    p
}

#[test]
fn render_empty_session_to_both_formats() {
    let db = fresh_db();
    let session = sessions::create(&db, "empty session").unwrap();

    let opts = ExportOptions::default();

    let md = render_session(&db, &session.id, ExportFormat::Markdown, &opts).unwrap();
    assert!(
        md.starts_with("# empty session"),
        "markdown should start with the session name as H1, got: {md}"
    );
    assert!(
        md.contains("_No blocks recorded in this session._"),
        "empty session should advertise that no blocks were recorded"
    );

    let html = render_session(&db, &session.id, ExportFormat::Html, &opts).unwrap();
    assert!(
        html.starts_with("<!DOCTYPE html>"),
        "html should start with a doctype, got: {html}"
    );
    assert!(html.contains("<title>empty session"));
    assert!(
        html.trim_end().ends_with("</html>"),
        "html document should close with </html>"
    );
}

#[test]
fn render_three_blocks_in_sequence_order() {
    let db = fresh_db();
    let session = sessions::create(&db, "round-trip").unwrap();

    blocks::append(
        &db,
        AppendBlockParams {
            session_id: session.id.clone(),
            pty_id: None,
            kind: BlockKind::Command,
            content: "echo hello".into(),
            ansi_raw: None,
            exit_code: Some(0),
            duration_ms: None,
        },
    )
    .unwrap();
    blocks::append(
        &db,
        AppendBlockParams {
            session_id: session.id.clone(),
            pty_id: None,
            kind: BlockKind::Output,
            content: "hello".into(),
            ansi_raw: None,
            exit_code: None,
            duration_ms: None,
        },
    )
    .unwrap();
    blocks::append(
        &db,
        AppendBlockParams {
            session_id: session.id.clone(),
            pty_id: None,
            kind: BlockKind::AiAssistant,
            content: "great, it worked".into(),
            ansi_raw: None,
            exit_code: None,
            duration_ms: None,
        },
    )
    .unwrap();

    let md = render_session(
        &db,
        &session.id,
        ExportFormat::Markdown,
        &ExportOptions::default(),
    )
    .unwrap();

    // All three contents present.
    assert!(md.contains("echo hello"), "command content missing: {md}");
    assert!(md.contains("hello"), "output content missing");
    assert!(
        md.contains("great, it worked"),
        "ai assistant content missing"
    );

    // Order: command before output before ai-assistant.
    let pos_cmd = md.find("echo hello").expect("command pos");
    let pos_out = md.find("```text").expect("output fence pos");
    let pos_ai = md.find("great, it worked").expect("ai pos");
    assert!(pos_cmd < pos_out, "command must come before output");
    assert!(pos_out < pos_ai, "output must come before ai");

    // Section count: three "### #" headers.
    let section_count = md.matches("### #").count();
    assert_eq!(section_count, 3, "expected 3 block sections, got {section_count}");
}

#[test]
fn embed_images_false_emits_id_only() {
    let db = fresh_db();
    let session = sessions::create(&db, "image session").unwrap();

    let block = blocks::append(
        &db,
        AppendBlockParams {
            session_id: session.id.clone(),
            pty_id: None,
            kind: BlockKind::Output,
            content: "screenshot taken".into(),
            ansi_raw: None,
            exit_code: None,
            duration_ms: None,
        },
    )
    .unwrap();

    let image = blocks::create_image(
        &db,
        CreateImageParams {
            sha256: "abc123".into(),
            path: "/does/not/exist.png".into(),
            mime: "image/png".into(),
            width: 100,
            height: 100,
            bytes: 0,
            source: ImageSource::Clipboard,
        },
    )
    .unwrap();
    blocks::attach_image_to_block(&db, &block.id, &image.id, 0).unwrap();

    let opts = ExportOptions {
        embed_images: false,
        include_ai: true,
    };
    let md = render_session(&db, &session.id, ExportFormat::Markdown, &opts).unwrap();

    let id_ref = format!("![{}]", image.id);
    assert!(
        md.contains(&id_ref),
        "expected `{id_ref}` in markdown output: {md}"
    );
    assert!(
        !md.contains("data:image/png;base64"),
        "embed_images=false must not emit a data URI: {md}"
    );

    let html = render_session(&db, &session.id, ExportFormat::Html, &opts).unwrap();
    assert!(
        html.contains(&image.id),
        "html should reference the image id"
    );
    assert!(
        !html.contains("data:image/png;base64"),
        "embed_images=false must not emit a data URI in html"
    );
}

#[test]
fn html_escapes_user_supplied_content() {
    let db = fresh_db();
    let session = sessions::create(&db, "xss <session>").unwrap();
    blocks::append(
        &db,
        AppendBlockParams {
            session_id: session.id.clone(),
            pty_id: None,
            kind: BlockKind::Output,
            content: "<script>alert(1)</script>".into(),
            ansi_raw: None,
            exit_code: None,
            duration_ms: None,
        },
    )
    .unwrap();

    let html = render_session(
        &db,
        &session.id,
        ExportFormat::Html,
        &ExportOptions::default(),
    )
    .unwrap();

    // Document structure.
    assert!(html.starts_with("<!DOCTYPE html>"));
    assert!(html.trim_end().ends_with("</html>"));

    // The escaped form is present.
    assert!(
        html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"),
        "expected escaped <script> tag in html, got: {html}"
    );
    // The raw form must not be present inside the body. The doctype contains
    // valid `<` characters from our markup, so we look for the dangerous
    // user-injected payload specifically.
    assert!(
        !html.contains("<script>alert(1)</script>"),
        "raw <script>alert(1)</script> must never appear in escaped html"
    );

    // The session name's `<` was also escaped.
    assert!(
        html.contains("xss &lt;session&gt;"),
        "session name should be escaped in the title/h1"
    );
}

#[test]
fn export_to_file_matches_render_output() {
    let db = fresh_db();
    let session = sessions::create(&db, "file export").unwrap();
    blocks::append(
        &db,
        AppendBlockParams {
            session_id: session.id.clone(),
            pty_id: None,
            kind: BlockKind::Command,
            content: "ls".into(),
            ansi_raw: None,
            exit_code: Some(0),
            duration_ms: None,
        },
    )
    .unwrap();

    let dir = temp_path("file");
    let path = dir.join("nested/sub").join("out.md");
    assert!(!path.exists(), "test file should not pre-exist: {path:?}");

    let opts = ExportOptions::default();
    export_session_to_file(&db, &session.id, &path, ExportFormat::Markdown, &opts)
        .expect("export to file");

    let from_disk = std::fs::read_to_string(&path).expect("read exported file");
    let from_memory = render_session(&db, &session.id, ExportFormat::Markdown, &opts).unwrap();
    assert_eq!(
        from_disk, from_memory,
        "file content must match render_session output"
    );

    // Cleanup best-effort.
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn missing_session_returns_invalid_input() {
    let db = fresh_db();
    let err = render_session(
        &db,
        "sess_does_not_exist",
        ExportFormat::Markdown,
        &ExportOptions::default(),
    )
    .expect_err("nonexistent session must error");
    let msg = err.to_string();
    assert!(
        msg.contains("sess_does_not_exist"),
        "error should mention the missing id, got: {msg}"
    );
}

#[test]
fn ai_appendix_included_when_opted_in() {
    let db = fresh_db();
    let session = sessions::create(&db, "with-ai").unwrap();
    let conv =
        blocks::create_ai_conversation(&db, &session.id, "claude-opus-4-7", "anthropic", Some("Q&A"))
            .unwrap();
    blocks::append_ai_exchange(
        &db,
        blocks::AppendAiExchangeParams {
            conversation_id: conv.id.clone(),
            role: "user".into(),
            content_json: r#"{"type":"text","text":"What is 2+2?"}"#.into(),
            input_tokens: Some(5),
            output_tokens: None,
        },
    )
    .unwrap();
    blocks::append_ai_exchange(
        &db,
        blocks::AppendAiExchangeParams {
            conversation_id: conv.id,
            role: "assistant".into(),
            content_json: r#"{"type":"text","text":"4"}"#.into(),
            input_tokens: None,
            output_tokens: Some(1),
        },
    )
    .unwrap();

    let with_ai = ExportOptions {
        embed_images: true,
        include_ai: true,
    };
    let md = render_session(&db, &session.id, ExportFormat::Markdown, &with_ai).unwrap();
    assert!(md.contains("## AI Conversations"), "appendix header missing");
    assert!(md.contains("What is 2+2?"), "user message missing");
    assert!(md.contains("> 4"), "assistant reply missing");

    // And the appendix disappears when include_ai is false.
    let without_ai = ExportOptions {
        embed_images: true,
        include_ai: false,
    };
    let md2 = render_session(&db, &session.id, ExportFormat::Markdown, &without_ai).unwrap();
    assert!(
        !md2.contains("## AI Conversations"),
        "appendix should be hidden when include_ai=false"
    );
}

#[test]
fn format_enum_serde_round_trip() {
    // Make sure callers can flip between the two formats via JSON without
    // surprise (used by the IPC layer the parent caller will wire up).
    let md_json = serde_json::to_string(&ExportFormat::Markdown).unwrap();
    assert_eq!(md_json, "\"markdown\"");
    let parsed: ExportFormat = serde_json::from_str("\"html\"").unwrap();
    assert_eq!(parsed, ExportFormat::Html);

    // Defaults survive a tiny JSON document.
    let opts: ExportOptions = serde_json::from_str("{}").unwrap();
    let _: &dyn std::fmt::Debug = &opts; // silence unused if assertions get removed
    assert!(opts.embed_images);
    assert!(opts.include_ai);

    // Touch the public module path so future renames are caught at compile time.
    let _ = export::ExportFormat::Markdown;
}
