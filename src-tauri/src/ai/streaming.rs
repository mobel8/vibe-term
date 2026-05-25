//! Anthropic Server-Sent Events stream → frontend deltas.
//!
//! Anthropic's `POST /v1/messages` with `stream: true` returns SSE frames
//! shaped like:
//!
//! ```text
//! event: message_start
//! data: {"type":"message_start","message":{...}}
//!
//! event: content_block_delta
//! data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}
//!
//! event: message_stop
//! data: {"type":"message_stop"}
//! ```
//!
//! Each `text_delta` is accumulated into a small buffer (≤ 64 chars / ≤ 50ms)
//! before being emitted on `ai://delta`, so the frontend gets coalesced
//! progress without React re-rendering on every 2-char chunk.

#![warn(clippy::all, rust_2018_idioms)]

use std::time::Duration;

use eventsource_stream::Eventsource;
use futures::StreamExt;
use reqwest::header::HeaderMap;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

use crate::ai::claude::Usage;
use crate::error::AppError;
use crate::events::{AI_DELTA, AI_ERROR, AI_MESSAGE_COMPLETE};

/// API endpoint. Centralised so tests + mocks can swap it later if needed.
pub const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";

/// Max chars buffered before we force-flush a `ai://delta`. Keeps the UI
/// responsive even when Anthropic streams big chunks in one frame.
const FLUSH_THRESHOLD: usize = 64;
/// Max wall-clock time before we flush a partially-filled delta buffer.
const FLUSH_INTERVAL: Duration = Duration::from_millis(50);

// ---- Event payloads (Rust → frontend) -----------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeltaEvent<'a> {
    pub conv_id: &'a str,
    pub msg_id: &'a str,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteEvent<'a> {
    pub conv_id: &'a str,
    pub msg_id: &'a str,
    pub usage: Usage,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEvent<'a> {
    pub conv_id: &'a str,
    pub msg_id: &'a str,
    pub error: String,
}

// ---- Anthropic SSE payload subset we care about -------------------------

#[derive(Debug, Deserialize)]
struct SseEnvelope {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    delta: Option<SseDelta>,
    #[serde(default)]
    message: Option<SseMessage>,
    #[serde(default)]
    usage: Option<Usage>,
    #[serde(default)]
    error: Option<SseError>,
}

#[derive(Debug, Deserialize)]
struct SseDelta {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct SseMessage {
    #[serde(default)]
    usage: Option<Usage>,
}

#[derive(Debug, Deserialize)]
struct SseError {
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

// ---- Public driver -------------------------------------------------------

/// Drive one Anthropic streaming request from request → terminal event.
///
/// The function consumes a `cancel` receiver: setting the underlying watch
/// to `true` aborts the loop and emits a "Cancelled by user" error on
/// `ai://error` so the frontend can clean up its UI state.
///
/// HTTP 429 is treated as terminal — the caller is expected to perform any
/// retry/backoff because that policy is conversation-specific. HTTP 5xx
/// errors return `Err(AppError::Other(...))` so the caller can wrap them in
/// an exponential-backoff loop.
pub async fn stream_response(
    http: &reqwest::Client,
    payload: serde_json::Value,
    headers: HeaderMap,
    conv_id: String,
    msg_id: String,
    app_handle: AppHandle,
    mut cancel: watch::Receiver<bool>,
) -> Result<(), AppError> {
    let response = http
        .post(ANTHROPIC_URL)
        .headers(headers)
        .json(&payload)
        .send()
        .await
        .map_err(|e| AppError::other(format!("anthropic request failed: {e}")))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let snippet = body.chars().take(512).collect::<String>();
        let msg = format!("anthropic HTTP {status}: {snippet}");
        emit_error(&app_handle, &conv_id, &msg_id, &msg);
        // 5xx → bubble up so caller can retry; 4xx → terminal.
        if status.is_server_error() {
            return Err(AppError::other(msg));
        }
        return Ok(());
    }

    let mut stream = response.bytes_stream().eventsource();
    let mut buffer = String::new();
    let mut last_flush = tokio::time::Instant::now();
    let mut final_usage = Usage::default();

    loop {
        // Race the next SSE frame against the cancel signal and a flush tick.
        let flush_deadline = tokio::time::sleep_until(last_flush + FLUSH_INTERVAL);
        tokio::pin!(flush_deadline);

        tokio::select! {
            biased;

            // Cancellation: fire once when the value flips to true.
            changed = cancel.changed() => {
                if changed.is_ok() && *cancel.borrow() {
                    emit_error(&app_handle, &conv_id, &msg_id, "Cancelled by user");
                    return Ok(());
                }
            }

            // SSE next frame.
            next = stream.next() => {
                match next {
                    Some(Ok(event)) => {
                        if event.data.trim().is_empty() {
                            continue;
                        }
                        match handle_event(
                            &event.event,
                            &event.data,
                            &mut buffer,
                            &mut final_usage,
                        ) {
                            EventOutcome::Continue => {}
                            EventOutcome::Stop => {
                                flush(&app_handle, &conv_id, &msg_id, &mut buffer);
                                emit_complete(&app_handle, &conv_id, &msg_id, &final_usage);
                                return Ok(());
                            }
                            EventOutcome::Error(msg) => {
                                flush(&app_handle, &conv_id, &msg_id, &mut buffer);
                                emit_error(&app_handle, &conv_id, &msg_id, &msg);
                                return Ok(());
                            }
                        }
                        if buffer.chars().count() >= FLUSH_THRESHOLD {
                            flush(&app_handle, &conv_id, &msg_id, &mut buffer);
                            last_flush = tokio::time::Instant::now();
                        }
                    }
                    Some(Err(err)) => {
                        let msg = format!("SSE parse error: {err}");
                        flush(&app_handle, &conv_id, &msg_id, &mut buffer);
                        emit_error(&app_handle, &conv_id, &msg_id, &msg);
                        return Err(AppError::other(msg));
                    }
                    None => {
                        // Stream closed without explicit `message_stop`.
                        flush(&app_handle, &conv_id, &msg_id, &mut buffer);
                        emit_complete(&app_handle, &conv_id, &msg_id, &final_usage);
                        return Ok(());
                    }
                }
            }

            // Time-based flush — keep typing-effect smooth even on lulls.
            _ = &mut flush_deadline => {
                if !buffer.is_empty() {
                    flush(&app_handle, &conv_id, &msg_id, &mut buffer);
                }
                last_flush = tokio::time::Instant::now();
            }
        }
    }
}

// ---- SSE event dispatching ----------------------------------------------

enum EventOutcome {
    Continue,
    Stop,
    Error(String),
}

fn handle_event(
    event_name: &str,
    data: &str,
    buffer: &mut String,
    final_usage: &mut Usage,
) -> EventOutcome {
    // Anthropic always sets both `event:` line and a `type` field in the
    // JSON. Some intermediaries strip the `event:` line so we fall back on
    // the JSON type when the SSE name is empty or "message".
    let envelope: SseEnvelope = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(err) => {
            return EventOutcome::Error(format!("invalid JSON in SSE frame: {err}"));
        }
    };

    let kind = if event_name.is_empty() || event_name == "message" {
        envelope.kind.as_str()
    } else {
        event_name
    };

    match kind {
        "message_start" => {
            if let Some(msg) = &envelope.message {
                if let Some(usage) = &msg.usage {
                    *final_usage = usage.clone();
                }
            }
            EventOutcome::Continue
        }
        "content_block_start" | "content_block_stop" | "ping" => EventOutcome::Continue,
        "content_block_delta" => {
            if let Some(delta) = envelope.delta {
                if delta.kind == "text_delta" {
                    if let Some(text) = delta.text {
                        buffer.push_str(&text);
                    }
                }
            }
            EventOutcome::Continue
        }
        "message_delta" => {
            if let Some(usage) = envelope.usage {
                // Anthropic sends incremental output token counts here;
                // adopt the latest values rather than summing.
                final_usage.output_tokens = usage.output_tokens;
                if usage.cache_read_input_tokens.is_some() {
                    final_usage.cache_read_input_tokens = usage.cache_read_input_tokens;
                }
                if usage.cache_creation_input_tokens.is_some() {
                    final_usage.cache_creation_input_tokens = usage.cache_creation_input_tokens;
                }
            }
            EventOutcome::Continue
        }
        "message_stop" => EventOutcome::Stop,
        "error" => {
            let msg = envelope
                .error
                .and_then(|e| e.message.or(e.kind))
                .unwrap_or_else(|| "anthropic error".into());
            EventOutcome::Error(msg)
        }
        _ => {
            tracing::debug!("ai: ignoring unknown SSE event '{kind}'");
            EventOutcome::Continue
        }
    }
}

// ---- Emitter helpers -----------------------------------------------------

fn flush(app: &AppHandle, conv_id: &str, msg_id: &str, buffer: &mut String) {
    if buffer.is_empty() {
        return;
    }
    let payload = DeltaEvent {
        conv_id,
        msg_id,
        text: std::mem::take(buffer),
    };
    if let Err(err) = app.emit(AI_DELTA, &payload) {
        tracing::warn!("ai: failed to emit delta: {err}");
    }
}

fn emit_complete(app: &AppHandle, conv_id: &str, msg_id: &str, usage: &Usage) {
    let payload = CompleteEvent {
        conv_id,
        msg_id,
        usage: usage.clone(),
    };
    if let Err(err) = app.emit(AI_MESSAGE_COMPLETE, &payload) {
        tracing::warn!("ai: failed to emit complete: {err}");
    }
}

fn emit_error(app: &AppHandle, conv_id: &str, msg_id: &str, message: &str) {
    emit_error_event(app, conv_id, msg_id, message);
}

/// Public version of [`emit_error`] used by the top-level [`crate::ai::AiClient`]
/// to surface failures that happen before the SSE loop is even entered
/// (header build failure, retry loop exhaustion, etc.).
pub fn emit_error_event(app: &AppHandle, conv_id: &str, msg_id: &str, message: &str) {
    let payload = ErrorEvent {
        conv_id,
        msg_id,
        error: message.to_string(),
    };
    if let Err(err) = app.emit(AI_ERROR, &payload) {
        tracing::warn!("ai: failed to emit error: {err}");
    }
}

// ---- Unit tests for the SSE dispatcher (no Tauri runtime) ---------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delta_accumulates_text_into_buffer() {
        let mut buf = String::new();
        let mut usage = Usage::default();
        let data =
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}"#;
        let outcome = handle_event("content_block_delta", data, &mut buf, &mut usage);
        assert!(matches!(outcome, EventOutcome::Continue));
        assert_eq!(buf, "Hi");
    }

    #[test]
    fn message_stop_triggers_stop() {
        let mut buf = String::new();
        let mut usage = Usage::default();
        let data = r#"{"type":"message_stop"}"#;
        let outcome = handle_event("message_stop", data, &mut buf, &mut usage);
        assert!(matches!(outcome, EventOutcome::Stop));
    }

    #[test]
    fn error_event_propagates_message() {
        let mut buf = String::new();
        let mut usage = Usage::default();
        let data = r#"{"type":"error","error":{"type":"overloaded_error","message":"slow down"}}"#;
        let outcome = handle_event("error", data, &mut buf, &mut usage);
        match outcome {
            EventOutcome::Error(msg) => assert!(msg.contains("slow down")),
            _ => panic!("expected error outcome"),
        }
    }

    #[test]
    fn message_delta_updates_usage() {
        let mut buf = String::new();
        let mut usage = Usage::default();
        let data = r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}"#;
        let outcome = handle_event("message_delta", data, &mut buf, &mut usage);
        assert!(matches!(outcome, EventOutcome::Continue));
        assert_eq!(usage.output_tokens, 42);
    }
}
