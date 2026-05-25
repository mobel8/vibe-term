//! Standalone-HTML renderer for the [`crate::export`] module.
//!
//! Produces a single-file document with an embedded `<style>` block (no
//! external assets), suitable for dropping into a browser or sharing as an
//! attachment. Every user-supplied string is escaped via a tiny in-module
//! [`escape`] helper — we intentionally avoid pulling in `html-escape` to
//! keep `Cargo.toml` untouched.

#![warn(clippy::all, rust_2018_idioms)]

use std::fmt::Write as _;

use crate::error::AppError;
use crate::store::blocks::{Block, BlockKind, Image};

use super::{
    block_kind_label, extract_exchange_text, format_iso_ms, pretty_role, read_image_base64, Bundle,
    BlockWithImages, ConversationWithExchanges, ExportOptions,
};

/// Minimal terminal-themed stylesheet. Kept ≤ 40 lines per spec.
const STYLE: &str = "\
body{margin:0;padding:24px;background:#0d1117;color:#c9d1d9;\
font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}\
header{border-bottom:1px solid #30363d;padding-bottom:12px;margin-bottom:16px;}\
h1{font-size:1.5rem;margin:0 0 8px;color:#f0f6fc;}\
h2{font-size:1.2rem;margin:24px 0 12px;color:#58a6ff;border-bottom:1px solid #21262d;padding-bottom:4px;}\
h3{font-size:1rem;margin:16px 0 8px;color:#7ee787;}\
ul.meta{list-style:none;padding:0;margin:0;}\
ul.meta li{font-size:0.85rem;color:#8b949e;}\
section.block{margin-bottom:20px;border-left:2px solid #30363d;padding-left:12px;}\
section.block .ts{font-size:0.75rem;color:#6e7681;}\
pre{background:#161b22;border:1px solid #30363d;border-radius:6px;\
padding:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;}\
pre.cmd{color:#79c0ff;} pre.out{color:#c9d1d9;} pre.sys{color:#d2a8ff;}\
blockquote{border-left:3px solid #58a6ff;margin:8px 0;padding:6px 12px;\
background:#161b22;border-radius:0 6px 6px 0;}\
blockquote.assistant{border-left-color:#7ee787;}\
img.embed{max-width:100%;display:block;margin:8px 0;border:1px solid #30363d;border-radius:4px;}\
.img-ref{color:#8b949e;font-style:italic;}\
.exit{display:inline-block;margin-top:4px;font-size:0.8rem;color:#8b949e;}";

/// Render `bundle` as a self-contained HTML document.
///
/// Crate-private because the input [`Bundle`] is itself crate-private:
/// external callers should go through
/// [`crate::export::render_session`].
pub(crate) fn render_html(bundle: &Bundle, opts: &ExportOptions) -> Result<String, AppError> {
    let mut out = String::with_capacity(4096);

    out.push_str("<!DOCTYPE html>\n");
    out.push_str("<html lang=\"en\">\n");
    out.push_str("<head>\n");
    out.push_str("<meta charset=\"utf-8\">\n");
    out.push_str("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n");
    writeln!(
        out,
        "<title>{} — vibe-term export</title>",
        escape(&bundle.session.name)
    )
    .ok();
    writeln!(out, "<style>{STYLE}</style>").ok();
    out.push_str("</head>\n<body>\n");

    // Header.
    out.push_str("<header>\n");
    writeln!(out, "<h1>{}</h1>", escape(&bundle.session.name)).ok();
    out.push_str("<ul class=\"meta\">\n");
    writeln!(
        out,
        "<li><strong>Session ID:</strong> <code>{}</code></li>",
        escape(&bundle.session.id)
    )
    .ok();
    writeln!(
        out,
        "<li><strong>Created:</strong> {}</li>",
        escape(&format_iso_ms(bundle.session.created_at))
    )
    .ok();
    writeln!(
        out,
        "<li><strong>Updated:</strong> {}</li>",
        escape(&format_iso_ms(bundle.session.updated_at))
    )
    .ok();
    writeln!(
        out,
        "<li><strong>Blocks:</strong> {}</li>",
        bundle.blocks.len()
    )
    .ok();
    if opts.include_ai && !bundle.conversations.is_empty() {
        writeln!(
            out,
            "<li><strong>AI conversations:</strong> {}</li>",
            bundle.conversations.len()
        )
        .ok();
    }
    out.push_str("</ul>\n</header>\n");

    // Body.
    if bundle.blocks.is_empty() {
        out.push_str("<p><em>No blocks recorded in this session.</em></p>\n");
    } else {
        out.push_str("<h2>Blocks</h2>\n");
        for bwi in &bundle.blocks {
            render_block(&mut out, bwi, opts);
        }
    }

    // Appendix.
    if opts.include_ai && !bundle.conversations.is_empty() {
        out.push_str("<h2>AI Conversations</h2>\n");
        for conv in &bundle.conversations {
            render_conversation(&mut out, conv);
        }
    }

    out.push_str("</body>\n</html>\n");
    Ok(out)
}

fn render_block(out: &mut String, bwi: &BlockWithImages, opts: &ExportOptions) {
    let b = &bwi.block;
    out.push_str("<section class=\"block\">\n");
    writeln!(
        out,
        "<h3>#{seq} · {label}</h3>",
        seq = b.sequence,
        label = escape(block_kind_label(b.kind)),
    )
    .ok();
    writeln!(
        out,
        "<div class=\"ts\">{}</div>",
        escape(&format_iso_ms(b.created_at))
    )
    .ok();

    match b.kind {
        BlockKind::Command => render_command_block(out, b),
        BlockKind::Output => render_output_block(out, b),
        BlockKind::AiUser | BlockKind::AiAssistant => render_ai_inline_block(out, b),
        BlockKind::System => render_system_block(out, b),
    }

    for img in &bwi.images {
        render_image(out, img, opts);
    }

    out.push_str("</section>\n");
}

fn render_command_block(out: &mut String, b: &Block) {
    out.push_str("<pre class=\"cmd\">");
    let lines: Vec<&str> = if b.content.is_empty() {
        vec![""]
    } else {
        b.content.lines().collect()
    };
    for line in lines {
        out.push_str("$ ");
        out.push_str(&escape(line));
        out.push('\n');
    }
    out.push_str("</pre>\n");
    if let Some(code) = b.exit_code {
        writeln!(out, "<div class=\"exit\">Exit code: {code}</div>").ok();
    }
}

fn render_output_block(out: &mut String, b: &Block) {
    out.push_str("<pre class=\"out\">");
    out.push_str(&escape(&b.content));
    out.push_str("</pre>\n");
}

fn render_ai_inline_block(out: &mut String, b: &Block) {
    let (role, class) = if matches!(b.kind, BlockKind::AiUser) {
        ("User", "user")
    } else {
        ("Assistant", "assistant")
    };
    writeln!(
        out,
        "<blockquote class=\"{class}\"><strong>{role}</strong><br>{body}</blockquote>",
        class = class,
        role = role,
        body = escape(&b.content).replace('\n', "<br>"),
    )
    .ok();
}

fn render_system_block(out: &mut String, b: &Block) {
    out.push_str("<pre class=\"sys\">");
    out.push_str(&escape(&b.content));
    out.push_str("</pre>\n");
}

fn render_image(out: &mut String, img: &Image, opts: &ExportOptions) {
    if opts.embed_images {
        if let Some(b64) = read_image_base64(img) {
            writeln!(
                out,
                "<img class=\"embed\" alt=\"{alt}\" src=\"data:{mime};base64,{b64}\">",
                alt = escape(&img.id),
                mime = escape(&img.mime),
                b64 = b64,
            )
            .ok();
            return;
        }
        writeln!(
            out,
            "<div class=\"img-ref\">{id} (file unavailable: <code>{path}</code>)</div>",
            id = escape(&img.id),
            path = escape(&img.path),
        )
        .ok();
    } else {
        writeln!(
            out,
            "<div class=\"img-ref\">{id}</div>",
            id = escape(&img.id)
        )
        .ok();
    }
}

fn render_conversation(out: &mut String, conv: &ConversationWithExchanges) {
    let title = conv
        .conversation
        .title
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("(untitled)");
    writeln!(out, "<h3>{}</h3>", escape(title)).ok();
    writeln!(
        out,
        "<div class=\"ts\">Model: <code>{model}</code> · Started: {ts}</div>",
        model = escape(&conv.conversation.model),
        ts = escape(&format_iso_ms(conv.conversation.created_at)),
    )
    .ok();

    if conv.exchanges.is_empty() {
        out.push_str("<p><em>No exchanges recorded.</em></p>\n");
        return;
    }

    for ex in &conv.exchanges {
        let role = pretty_role(&ex.role);
        let class = match ex.role.as_str() {
            "assistant" => "assistant",
            _ => "user",
        };
        let text = extract_exchange_text(&ex.content_json);
        writeln!(
            out,
            "<blockquote class=\"{class}\"><strong>{role}</strong> · <span class=\"ts\">{ts}</span><br>{body}</blockquote>",
            class = class,
            role = escape(role),
            ts = escape(&format_iso_ms(ex.created_at)),
            body = escape(&text).replace('\n', "<br>"),
        )
        .ok();
    }
}

/// Hand-rolled HTML escaper. Replaces the five characters that are unsafe
/// in element text and double-quoted attribute values:
/// `&`, `<`, `>`, `"`, `'`.
///
/// The implementation walks the input once and writes into a pre-sized
/// `String` to avoid the small allocations a naive `.replace()` chain
/// would produce.
pub(crate) fn escape(s: &str) -> String {
    // Fast path: nothing to escape → cheap clone.
    if !s.bytes().any(|b| matches!(b, b'&' | b'<' | b'>' | b'"' | b'\'')) {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len() + 16);
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_handles_all_five() {
        assert_eq!(escape("a&b"), "a&amp;b");
        assert_eq!(escape("<x>"), "&lt;x&gt;");
        assert_eq!(escape("\"q\""), "&quot;q&quot;");
        assert_eq!(escape("'s'"), "&#39;s&#39;");
    }

    #[test]
    fn escape_fast_path_returns_clone() {
        assert_eq!(escape("hello world"), "hello world");
        assert_eq!(escape(""), "");
    }

    #[test]
    fn escape_round_trip_on_script_tag() {
        let attack = "<script>alert(1)</script>";
        let escaped = escape(attack);
        assert!(!escaped.contains('<'));
        assert!(escaped.contains("&lt;script&gt;"));
    }
}
