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
    pub conversation_id: &'a str,
    pub message_id: &'a str,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteEvent<'a> {
    pub conversation_id: &'a str,
    pub message_id: &'a str,
    pub usage: Usage,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEvent<'a> {
    pub conversation_id: &'a str,
    pub message_id: &'a str,
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

#[derive(Debug, Default, Deserialize)]
struct SseDelta {
    // Optional because Anthropic's `message_delta` event has a delta object
    // with `stop_reason` / `stop_sequence` but no `type` field, whereas
    // `content_block_delta` always carries `type: "text_delta"`.
    #[serde(default, rename = "type")]
    kind: Option<String>,
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

// ---- OpenAI-compatible SSE subset (Groq / Mistral / Cerebras / DeepSeek) --

#[derive(Debug, Deserialize)]
struct OpenAiChunk {
    #[serde(default)]
    choices: Vec<OpenAiChoice>,
    #[serde(default)]
    usage: Option<OpenAiUsage>,
    #[serde(default)]
    error: Option<serde_json::Value>,
}

#[derive(Debug, Default, Deserialize)]
struct OpenAiChoice {
    #[serde(default)]
    delta: OpenAiDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct OpenAiDelta {
    #[serde(default)]
    content: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct OpenAiUsage {
    #[serde(default)]
    prompt_tokens: u32,
    #[serde(default)]
    completion_tokens: u32,
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
    // Race the initial connect/send against cancellation. Without this a Stop
    // pressed while the TCP connect is stalling is ignored until send()
    // resolves (up to the 60s connect timeout). Treat both a flip to `true`
    // and all senders being dropped (changed() == Err, only happens after the
    // owning task is torn down post-cancel) as cancellation.
    let send_fut = http.post(ANTHROPIC_URL).headers(headers).json(&payload).send();
    tokio::pin!(send_fut);
    let response = loop {
        tokio::select! {
            biased;

            changed = cancel.changed() => {
                if changed.is_err() || *cancel.borrow() {
                    emit_error(&app_handle, &conv_id, &msg_id, "Cancelled by user");
                    return Ok(());
                }
                // Spurious wakeup with the value still false and senders alive:
                // keep awaiting the in-flight send on the next loop iteration.
            }
            sent = &mut send_fut => {
                break sent
                    .map_err(|e| AppError::other(format!("anthropic request failed: {e}")))?;
            }
        }
    };

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let snippet = body.chars().take(512).collect::<String>();
        let msg = format!("anthropic HTTP {status}: {snippet}");
        if status.is_server_error() {
            // 5xx → retryable. Do NOT emit ai://error here: the caller's retry
            // loop emits exactly ONE terminal error only if every attempt fails,
            // so a recovered retry no longer flashes a spurious error block. No
            // deltas were emitted yet, so re-streaming is duplication-free.
            return Err(AppError::other(msg));
        }
        // 4xx → terminal: this pre-body branch is the only place to surface it.
        emit_error(&app_handle, &conv_id, &msg_id, &msg);
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
                        // Mid-stream transport/parse error, AFTER deltas may have
                        // already been emitted. Treat as TERMINAL: emit once and
                        // return Ok so the caller does NOT retry — a retry would
                        // re-stream from scratch and the frontend would concatenate
                        // it onto the partial text already shown (duplication).
                        let msg = format!("SSE parse error: {err}");
                        flush(&app_handle, &conv_id, &msg_id, &mut buffer);
                        emit_error(&app_handle, &conv_id, &msg_id, &msg);
                        return Ok(());
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

/// Drive one OpenAI-compatible streaming request (Groq / Mistral / Cerebras /
/// DeepSeek). `url` is the full `/chat/completions` endpoint. Mirrors
/// [`stream_response`]'s cancellation + coalescing behaviour, but parses
/// OpenAI-style SSE chunks (`choices[].delta.content`, terminated by a
/// `finish_reason` or a `data: [DONE]` sentinel).
#[allow(clippy::too_many_arguments)]
pub async fn stream_openai_compatible(
    http: &reqwest::Client,
    url: String,
    payload: serde_json::Value,
    headers: HeaderMap,
    conv_id: String,
    msg_id: String,
    app_handle: AppHandle,
    mut cancel: watch::Receiver<bool>,
) -> Result<(), AppError> {
    let send_fut = http.post(&url).headers(headers).json(&payload).send();
    tokio::pin!(send_fut);
    let response = loop {
        tokio::select! {
            biased;
            changed = cancel.changed() => {
                if changed.is_err() || *cancel.borrow() {
                    emit_error(&app_handle, &conv_id, &msg_id, "Cancelled by user");
                    return Ok(());
                }
            }
            sent = &mut send_fut => {
                break sent.map_err(|e| AppError::other(format!("request failed: {e}")))?;
            }
        }
    };

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let snippet = body.chars().take(512).collect::<String>();
        let msg = format!("HTTP {status}: {snippet}");
        if status.is_server_error() {
            return Err(AppError::other(msg)); // retryable; caller's loop emits once
        }
        emit_error(&app_handle, &conv_id, &msg_id, &msg);
        return Ok(());
    }

    let mut stream = response.bytes_stream().eventsource();
    let mut buffer = String::new();
    let mut last_flush = tokio::time::Instant::now();
    let mut final_usage = Usage::default();
    // Track whether the stream ever yielded assistant text. Some OpenAI-compatible
    // gateways answer HTTP 200 then deliver an error/HTML body (or a JSON error
    // not shaped as `{"error":{...}}`), which deserializes to a content-less chunk
    // or is skipped as unparsable. Without this, the terminal `None` arm would
    // finalize an empty buffer as a successful, blank reply.
    let mut produced = false;
    let mut last_unparsed: Option<String> = None;

    loop {
        let flush_deadline = tokio::time::sleep_until(last_flush + FLUSH_INTERVAL);
        tokio::pin!(flush_deadline);

        tokio::select! {
            biased;

            changed = cancel.changed() => {
                if changed.is_ok() && *cancel.borrow() {
                    emit_error(&app_handle, &conv_id, &msg_id, "Cancelled by user");
                    return Ok(());
                }
            }

            next = stream.next() => {
                match next {
                    Some(Ok(event)) => {
                        let data = event.data.trim();
                        if data.is_empty() {
                            continue;
                        }
                        if data == "[DONE]" {
                            flush(&app_handle, &conv_id, &msg_id, &mut buffer);
                            emit_complete(&app_handle, &conv_id, &msg_id, &final_usage);
                            return Ok(());
                        }
                        match serde_json::from_str::<OpenAiChunk>(data) {
                            Ok(chunk) => {
                                if let Some(err) = chunk.error {
                                    let m = err
                                        .get("message")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("provider error")
                                        .to_string();
                                    flush(&app_handle, &conv_id, &msg_id, &mut buffer);
                                    emit_error(&app_handle, &conv_id, &msg_id, &m);
                                    return Ok(());
                                }
                                if let Some(u) = chunk.usage {
                                    final_usage.input_tokens = u.prompt_tokens;
                                    final_usage.output_tokens = u.completion_tokens;
                                }
                                if let Some(choice) = chunk.choices.into_iter().next() {
                                    if let Some(c) = choice.delta.content {
                                        if !c.is_empty() {
                                            produced = true;
                                        }
                                        buffer.push_str(&c);
                                    }
                                    if choice.finish_reason.is_some() {
                                        flush(&app_handle, &conv_id, &msg_id, &mut buffer);
                                        emit_complete(&app_handle, &conv_id, &msg_id, &final_usage);
                                        return Ok(());
                                    }
                                }
                            }
                            Err(err) => {
                                tracing::debug!("ai(openai): skipping unparsable SSE data: {err}");
                                if last_unparsed.is_none() {
                                    last_unparsed = Some(data.chars().take(200).collect());
                                }
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
                        return Ok(());
                    }
                    None => {
                        // Stream closed without a `[DONE]`/`finish_reason`. If we
                        // never produced any text, this is almost certainly an
                        // error delivered under HTTP 200 — surface it instead of
                        // finalizing a blank "successful" reply.
                        if !produced && buffer.is_empty() {
                            let detail = last_unparsed
                                .map(|s| format!("provider returned an unreadable response: {s}"))
                                .unwrap_or_else(|| {
                                    "provider closed the stream without returning a response"
                                        .to_string()
                                });
                            emit_error(&app_handle, &conv_id, &msg_id, &detail);
                            return Ok(());
                        }
                        flush(&app_handle, &conv_id, &msg_id, &mut buffer);
                        emit_complete(&app_handle, &conv_id, &msg_id, &final_usage);
                        return Ok(());
                    }
                }
            }

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
                if delta.kind.as_deref() == Some("text_delta") {
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
        conversation_id: conv_id,
        message_id: msg_id,
        text: std::mem::take(buffer),
    };
    if let Err(err) = app.emit(AI_DELTA, &payload) {
        tracing::warn!("ai: failed to emit delta: {err}");
    }
}

fn emit_complete(app: &AppHandle, conv_id: &str, msg_id: &str, usage: &Usage) {
    let payload = CompleteEvent {
        conversation_id: conv_id,
        message_id: msg_id,
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
        conversation_id: conv_id,
        message_id: msg_id,
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
