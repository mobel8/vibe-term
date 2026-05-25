//! Markdown renderer for the [`crate::export`] module.
//!
//! Produces CommonMark-ish output: a session-name H1, a metadata block,
//! one section per terminal block (fenced shell / text code blocks), and an
//! optional AI-conversation appendix. Image references are emitted at the
//! end of the parent block — either inlined as `data:` URIs when
//! [`ExportOptions::embed_images`] is `true`, or by their `img_xxxxxx`
//! identifier otherwise.

#![warn(clippy::all, rust_2018_idioms)]

use std::fmt::Write as _;

use crate::error::AppError;
use crate::store::blocks::{Block, BlockKind, Image};

use super::{
    block_kind_label, extract_exchange_text, format_iso_ms, pretty_role, read_image_base64, Bundle,
    BlockWithImages, ConversationWithExchanges, ExportOptions,
};

/// Render `bundle` as a Markdown document.
///
/// Never errors in practice — the `Result` is preserved for symmetry with
/// [`crate::export::html::render_html`] and to leave room for future
/// validation (e.g. refusing exports above a size cap).
///
/// Crate-private because the input [`Bundle`] is itself crate-private:
/// external callers should go through
/// [`crate::export::render_session`].
pub(crate) fn render_markdown(bundle: &Bundle, opts: &ExportOptions) -> Result<String, AppError> {
    let mut out = String::with_capacity(2048);

    // Header: H1 + metadata.
    writeln!(out, "# {}", bundle.session.name).ok();
    writeln!(out).ok();
    writeln!(out, "- **Session ID:** `{}`", bundle.session.id).ok();
    writeln!(
        out,
        "- **Created:** {}",
        format_iso_ms(bundle.session.created_at)
    )
    .ok();
    writeln!(
        out,
        "- **Updated:** {}",
        format_iso_ms(bundle.session.updated_at)
    )
    .ok();
    writeln!(out, "- **Blocks:** {}", bundle.blocks.len()).ok();
    if opts.include_ai && !bundle.conversations.is_empty() {
        writeln!(
            out,
            "- **AI conversations:** {}",
            bundle.conversations.len()
        )
        .ok();
    }
    writeln!(out).ok();

    // Body: one section per block.
    if bundle.blocks.is_empty() {
        writeln!(out, "_No blocks recorded in this session._").ok();
        writeln!(out).ok();
    } else {
        writeln!(out, "## Blocks").ok();
        writeln!(out).ok();
        for bwi in &bundle.blocks {
            render_block(&mut out, bwi, opts);
        }
    }

    // Appendix: AI conversations.
    if opts.include_ai && !bundle.conversations.is_empty() {
        writeln!(out, "## AI Conversations").ok();
        writeln!(out).ok();
        for conv in &bundle.conversations {
            render_conversation(&mut out, conv);
        }
    }

    Ok(out)
}

fn render_block(out: &mut String, bwi: &BlockWithImages, opts: &ExportOptions) {
    let b = &bwi.block;
    writeln!(
        out,
        "### #{seq} · {label}",
        seq = b.sequence,
        label = block_kind_label(b.kind),
    )
    .ok();
    writeln!(out, "_{}_", format_iso_ms(b.created_at)).ok();
    writeln!(out).ok();

    match b.kind {
        BlockKind::Command => render_command_block(out, b),
        BlockKind::Output => render_output_block(out, b),
        BlockKind::AiUser | BlockKind::AiAssistant => render_ai_inline_block(out, b),
        BlockKind::System => render_system_block(out, b),
    }

    if !bwi.images.is_empty() {
        writeln!(out).ok();
        for img in &bwi.images {
            render_image(out, img, opts);
        }
    }

    writeln!(out).ok();
}

fn render_command_block(out: &mut String, b: &Block) {
    writeln!(out, "```shell").ok();
    // Prefix each line with `$ ` so the shell semantics are obvious even
    // when the renderer strips the language tag.
    for line in b.content.lines() {
        writeln!(out, "$ {line}").ok();
    }
    if b.content.is_empty() {
        writeln!(out, "$").ok();
    }
    writeln!(out, "```").ok();
    if let Some(code) = b.exit_code {
        writeln!(out).ok();
        writeln!(out, "_Exit code: {code}_").ok();
    }
}

fn render_output_block(out: &mut String, b: &Block) {
    writeln!(out, "```text").ok();
    // The DB stores `content` already stripped of ANSI escapes (the raw
    // bytes live in `ansi_raw`), so we can write it verbatim. We still
    // guard against accidental triple-backtick collisions by suffixing a
    // marker line when needed.
    if b.content.contains("```") {
        // Switch to a 4-backtick fence to safely nest the content.
        // Rewind the opening fence we already wrote.
        let len = out.len();
        out.truncate(len - "```text\n".len());
        writeln!(out, "````text").ok();
        out.push_str(&b.content);
        if !b.content.ends_with('\n') {
            out.push('\n');
        }
        writeln!(out, "````").ok();
    } else {
        out.push_str(&b.content);
        if !b.content.ends_with('\n') {
            out.push('\n');
        }
        writeln!(out, "```").ok();
    }
}

fn render_ai_inline_block(out: &mut String, b: &Block) {
    let role = if matches!(b.kind, BlockKind::AiUser) {
        "User"
    } else {
        "Assistant"
    };
    writeln!(out, "> **{role}**").ok();
    writeln!(out, ">").ok();
    for line in b.content.lines() {
        writeln!(out, "> {line}").ok();
    }
    if b.content.is_empty() {
        writeln!(out, "> _(empty)_").ok();
    }
}

fn render_system_block(out: &mut String, b: &Block) {
    writeln!(out, "```text").ok();
    out.push_str(&b.content);
    if !b.content.ends_with('\n') {
        out.push('\n');
    }
    writeln!(out, "```").ok();
}

fn render_image(out: &mut String, img: &Image, opts: &ExportOptions) {
    if opts.embed_images {
        if let Some(b64) = read_image_base64(img) {
            writeln!(
                out,
                "![{id}](data:{mime};base64,{b64})",
                id = img.id,
                mime = img.mime,
                b64 = b64,
            )
            .ok();
            return;
        }
        // Fall through to the textual reference if the file is missing.
        writeln!(out, "![{id}] _(file unavailable: `{path}`)_", id = img.id, path = img.path).ok();
    } else {
        writeln!(out, "![{id}]", id = img.id).ok();
    }
}

fn render_conversation(out: &mut String, conv: &ConversationWithExchanges) {
    let title = conv
        .conversation
        .title
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("(untitled)");
    writeln!(out, "### {title}").ok();
    writeln!(
        out,
        "_Model: `{model}` · Started: {ts}_",
        model = conv.conversation.model,
        ts = format_iso_ms(conv.conversation.created_at),
    )
    .ok();
    writeln!(out).ok();

    if conv.exchanges.is_empty() {
        writeln!(out, "_No exchanges recorded._").ok();
        writeln!(out).ok();
        return;
    }

    for ex in &conv.exchanges {
        let role = pretty_role(&ex.role);
        let text = extract_exchange_text(&ex.content_json);
        writeln!(out, "**{role}** · _{ts}_", ts = format_iso_ms(ex.created_at)).ok();
        writeln!(out).ok();
        for line in text.lines() {
            writeln!(out, "> {line}").ok();
        }
        if text.is_empty() {
            writeln!(out, "> _(empty)_").ok();
        }
        writeln!(out).ok();
    }
}
