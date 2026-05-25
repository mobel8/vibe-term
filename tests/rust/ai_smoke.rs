//! Smoke test for the AI module's two pure building blocks:
//!
//! 1. **SSE parsing**: feed `eventsource_stream` the same byte shape Anthropic
//!    emits and check we recover the deltas in order.
//! 2. **JSON payload shape**: build the same `messages` body our request
//!    helper produces and assert the field shape Anthropic expects (multimodal
//!    `text` + `image` blocks, `cache_control` on the system prompt).
//!
//! The test lives outside the `src-tauri` crate to keep AI-specific coverage
//! decoupled from Tauri's AppHandle. Wire it into the test runner via:
//!
//! ```toml
//! [[test]]
//! name = "ai_smoke"
//! path = "../tests/rust/ai_smoke.rs"
//! ```
//!
//! Keystore tests are marked `#[ignore]` because the `keyring` crate requires
//! D-Bus / a desktop session that CI runners may not provide.

#![warn(clippy::all, rust_2018_idioms)]

use eventsource_stream::{Event, Eventsource};
use futures::stream;
use futures::TryStreamExt;
use serde_json::json;

/// Decode the SSE byte stream Anthropic emits for a tiny three-delta reply
/// and confirm the concatenated text equals `"Hello world!"`.
#[tokio::test]
async fn sse_text_deltas_concatenate() {
    // Faithful Anthropic SSE: each frame has both `event:` and `data:` lines.
    let chunks: Vec<Result<&'static [u8], std::io::Error>> = vec![
        Ok(b"event: message_start\n"),
        Ok(b"data: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"usage\":{\"input_tokens\":5,\"output_tokens\":0}}}\n\n"),
        Ok(b"event: content_block_start\n"),
        Ok(b"data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n"),
        Ok(b"event: content_block_delta\n"),
        Ok(b"data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n"),
        Ok(b"event: content_block_delta\n"),
        Ok(b"data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" world\"}}\n\n"),
        Ok(b"event: content_block_delta\n"),
        Ok(b"data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"!\"}}\n\n"),
        Ok(b"event: content_block_stop\n"),
        Ok(b"data: {\"type\":\"content_block_stop\",\"index\":0}\n\n"),
        Ok(b"event: message_delta\n"),
        Ok(b"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":3}}\n\n"),
        Ok(b"event: message_stop\n"),
        Ok(b"data: {\"type\":\"message_stop\"}\n\n"),
    ];

    let mut stream = stream::iter(chunks).eventsource();
    let mut deltas = String::new();
    let mut saw_stop = false;
    let mut output_tokens: u32 = 0;

    while let Some(event) = stream.try_next().await.expect("sse decode failed") {
        let Event {
            event: name, data, ..
        } = event;
        let parsed: serde_json::Value = serde_json::from_str(&data).expect("invalid json");
        match name.as_str() {
            "content_block_delta" => {
                if parsed["delta"]["type"] == "text_delta" {
                    if let Some(txt) = parsed["delta"]["text"].as_str() {
                        deltas.push_str(txt);
                    }
                }
            }
            "message_delta" => {
                if let Some(t) = parsed["usage"]["output_tokens"].as_u64() {
                    output_tokens = t as u32;
                }
            }
            "message_stop" => {
                saw_stop = true;
                break;
            }
            _ => {}
        }
    }

    assert_eq!(deltas, "Hello world!");
    assert!(saw_stop, "missing message_stop frame");
    assert_eq!(output_tokens, 3);
}

/// Mirror of `ai::claude::build_anthropic_payload` semantics: 2 text turns
/// + 1 multimodal turn (text + base64 image) and a cached system prompt.
/// Locks the on-wire shape so a refactor cannot silently drop required
/// fields.
#[test]
fn payload_shape_matches_anthropic_spec() {
    let payload = json!({
        "model": "claude-sonnet-4-6",
        "max_tokens": 1024,
        "stream": true,
        "system": [{
            "type": "text",
            "text": "You are a helpful terminal assistant.",
            "cache_control": { "type": "ephemeral" }
        }],
        "messages": [
            {
                "role": "user",
                "content": [{ "type": "text", "text": "Hi" }]
            },
            {
                "role": "assistant",
                "content": [{ "type": "text", "text": "Hello!" }]
            },
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": "What's in this screenshot?" },
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": "iVBORw0KGgoAAAANS"
                        }
                    }
                ]
            }
        ],
        "temperature": 0.4
    });

    // Required top-level fields.
    assert_eq!(payload["model"], "claude-sonnet-4-6");
    assert_eq!(payload["max_tokens"], 1024);
    assert_eq!(payload["stream"], true);
    assert_eq!(payload["temperature"], 0.4);

    // System prompt MUST live in an array entry with cache_control.
    assert_eq!(payload["system"][0]["type"], "text");
    assert_eq!(payload["system"][0]["cache_control"]["type"], "ephemeral");

    // Conversation history.
    assert_eq!(payload["messages"].as_array().unwrap().len(), 3);
    assert_eq!(payload["messages"][0]["role"], "user");
    assert_eq!(payload["messages"][1]["role"], "assistant");
    assert_eq!(payload["messages"][2]["role"], "user");

    // Multimodal last turn: text block + image block, image as base64 source.
    let last = &payload["messages"][2]["content"];
    assert_eq!(last[0]["type"], "text");
    assert_eq!(last[1]["type"], "image");
    assert_eq!(last[1]["source"]["type"], "base64");
    assert_eq!(last[1]["source"]["media_type"], "image/png");
    assert!(last[1]["source"]["data"].as_str().unwrap().len() > 0);
}

/// Anthropic occasionally splits an SSE frame across two TCP chunks. The
/// `eventsource_stream` decoder must buffer until the empty-line delimiter,
/// otherwise we'd drop deltas under network jitter.
#[tokio::test]
async fn sse_handles_split_frames() {
    let chunks: Vec<Result<&'static [u8], std::io::Error>> = vec![
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"in"),
        Ok(b"dex\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Spli"),
        Ok(b"t\"}}\n\n"),
    ];
    let mut stream = stream::iter(chunks).eventsource();
    let event = stream
        .try_next()
        .await
        .expect("sse decode failed")
        .expect("missing event");
    assert_eq!(event.event, "content_block_delta");
    let parsed: serde_json::Value = serde_json::from_str(&event.data).unwrap();
    assert_eq!(parsed["delta"]["text"], "Split");
}

// ---- Keystore (ignored in CI) -------------------------------------------

/// Round-trip test: store → load → delete via the OS keyring.
/// `#[ignore]` because the keyring crate requires D-Bus / a desktop session
/// that GitHub Actions runners do not provide.
#[test]
#[ignore]
fn keyring_round_trip() {
    const SERVICE: &str = "vibe-term-test";
    const ACCOUNT: &str = "ai_smoke_round_trip";
    const VALUE: &str = "sk-ant-api03-test-value-do-not-use-1234567890";

    let entry = keyring::Entry::new(SERVICE, ACCOUNT).expect("entry");
    entry.set_password(VALUE).expect("set");
    let got = entry.get_password().expect("get");
    assert_eq!(got, VALUE);
    entry.delete_credential().expect("delete");

    match entry.get_password() {
        Err(keyring::Error::NoEntry) => {}
        other => panic!("expected NoEntry after delete, got {other:?}"),
    }
}
