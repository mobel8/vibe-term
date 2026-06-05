//! Anthropic Claude integration (Phase 6).
//!
//! This module owns the HTTP client and the orchestration of streaming
//! conversations:
//!
//! * [`claude`]      — request / response types and JSON payload builder.
//! * [`keystore`]    — secure storage of the user's API key.
//! * [`streaming`]   — SSE → `ai://delta` / `ai://message_complete` pipeline.
//!
//! [`AiClient`] is the single public type. The frontend invokes
//! `commands::ai_send` which resolves the API key, fills it into the
//! [`claude::SendRequest`], and calls [`AiClient::send`]. The client spawns
//! the request in a background task so the IPC call returns immediately —
//! all progress arrives via Tauri events.

#![warn(clippy::all, rust_2018_idioms)]

pub mod claude;
pub mod keystore;
pub mod streaming;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use tauri::AppHandle;
use tokio::sync::watch;

pub use claude::{
    build_anthropic_payload, build_openai_payload, provider_catalogue, AiProvider, ClaudeModel,
    ContentBlock, ImageSource, Message, ProviderModels, Role, SendRequest, Usage,
};

use crate::error::AppError;

/// Anthropic API version pinned for the lifetime of this binary.
/// Bumping requires re-validating the SSE event shapes in `streaming.rs`.
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Number of streaming attempts on transient HTTP 5xx failures (initial try
/// + retries). Backoff: 250ms, 500ms, 1s.
const STREAM_ATTEMPTS: u32 = 3;

/// Connect timeout. We do **not** set a request timeout because SSE
/// responses are long-lived by design and rely on cancellation instead.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(60);

/// `conv_id → (dispatch token, cancel sender)` map shared between the public
/// API and the background streaming tasks. The token disambiguates which
/// dispatch owns the entry so a finishing task can't evict a newer one.
type ActiveMap = Arc<Mutex<HashMap<String, (u64, watch::Sender<bool>)>>>;

/// Streaming Anthropic client + per-conversation cancellation registry.
pub struct AiClient {
    http: reqwest::Client,
    app_handle: AppHandle,
    active: ActiveMap,
    /// Monotonic dispatch counter — each `send()` claims a unique token.
    next_token: AtomicU64,
}

impl AiClient {
    /// Build the client. Uses `rustls-tls`, gzip-decode, no global timeout
    /// (SSE is long), 60s connect timeout.
    pub fn new(app_handle: AppHandle) -> Result<Self, AppError> {
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .gzip(true)
            .user_agent(concat!("vibe-term/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| AppError::other(format!("ai: build http client: {e}")))?;
        Ok(Self {
            http,
            app_handle,
            active: Arc::new(Mutex::new(HashMap::new())),
            next_token: AtomicU64::new(0),
        })
    }

    /// Start a streaming request in the background. Returns immediately;
    /// the actual progress arrives via `ai://delta`, `ai://message_complete`,
    /// and `ai://error` events.
    ///
    /// `req.api_key` MUST be populated by the caller before invoking — the
    /// keystore lookup happens in `commands::ai_send` so the same key can be
    /// shared across many calls without re-reading the OS keychain.
    pub async fn send(&self, mut req: SendRequest) -> Result<(), AppError> {
        if req.api_key.is_empty() {
            return Err(AppError::InvalidInput("missing api key".into()));
        }
        if req.conversation_id.is_empty() {
            return Err(AppError::InvalidInput("missing conversation id".into()));
        }
        if req.message_id.is_empty() {
            return Err(AppError::InvalidInput("missing message id".into()));
        }
        if req.max_tokens == 0 {
            req.max_tokens = 4096;
        }

        let (cancel_tx, mut cancel_rx) = watch::channel(false);
        let my_token = self.next_token.fetch_add(1, Ordering::Relaxed);
        // Replace any in-flight request for the same conversation; the old
        // sender is dropped so its receiver hangs up gracefully.
        {
            let mut active = self.active.lock();
            if let Some((_, prev)) =
                active.insert(req.conversation_id.clone(), (my_token, cancel_tx))
            {
                let _ = prev.send(true);
            }
        }

        let http = self.http.clone();
        let app_handle = self.app_handle.clone();
        let active = self.active.clone();
        let conv_id = req.conversation_id.clone();
        let msg_id = req.message_id.clone();
        let api_key_preview = keystore::redact_key(&req.api_key);

        tracing::info!(
            "ai: dispatching conv={} msg={} provider={:?} model={} key={}",
            conv_id,
            msg_id,
            req.provider,
            req.model,
            api_key_preview
        );

        tokio::spawn(async move {
            let provider = req.provider;
            let headers_result = if provider.is_anthropic() {
                build_headers(&req.api_key)
            } else {
                build_openai_headers(&req.api_key)
            };
            let headers = match headers_result {
                Ok(h) => h,
                Err(err) => {
                    tracing::warn!("ai: failed to build headers: {err}");
                    streaming::emit_error_event(
                        &app_handle,
                        &conv_id,
                        &msg_id,
                        &format!("invalid api key header: {err}"),
                    );
                    deregister(&active, &conv_id, my_token);
                    return;
                }
            };
            let payload = if provider.is_anthropic() {
                build_anthropic_payload(&req)
            } else {
                build_openai_payload(&req)
            };
            // OpenAI-compatible endpoint (unused for Anthropic).
            let openai_url = format!("{}/chat/completions", provider.base_url());

            let mut delay = Duration::from_millis(250);
            let mut last_err: Option<AppError> = None;
            // Set when Stop is observed HERE (between attempts / during backoff),
            // i.e. before the streaming fn runs — so the streaming fn never emits
            // its own "Cancelled by user" terminal event and we must emit one
            // below, or the frontend's `streamingMessageId` is never cleared and
            // the conversation is stuck "streaming" forever.
            let mut cancelled = false;
            for attempt in 1..=STREAM_ATTEMPTS {
                // If the user already hit Stop (observed during a prior attempt's
                // stream), don't (re)issue a request or report a failure.
                if *cancel_rx.borrow() {
                    cancelled = true;
                    last_err = None;
                    break;
                }
                let result = if provider.is_anthropic() {
                    streaming::stream_response(
                        &http,
                        payload.clone(),
                        headers.clone(),
                        conv_id.clone(),
                        msg_id.clone(),
                        app_handle.clone(),
                        cancel_rx.clone(),
                    )
                    .await
                } else {
                    streaming::stream_openai_compatible(
                        &http,
                        openai_url.clone(),
                        payload.clone(),
                        headers.clone(),
                        conv_id.clone(),
                        msg_id.clone(),
                        app_handle.clone(),
                        cancel_rx.clone(),
                    )
                    .await
                };
                match result {
                    Ok(()) => {
                        last_err = None;
                        break;
                    }
                    Err(err) => {
                        tracing::warn!(
                            "ai: stream attempt {attempt}/{STREAM_ATTEMPTS} failed: {err}"
                        );
                        last_err = Some(err);
                        if attempt < STREAM_ATTEMPTS {
                            // Race the backoff against cancellation: Stop during a
                            // retry sleep must abort immediately, not fire another
                            // request + a spurious post-cancel "failed" error.
                            tokio::select! {
                                _ = tokio::time::sleep(delay) => {}
                                _ = cancel_rx.changed() => {}
                            }
                            if *cancel_rx.borrow() {
                                cancelled = true;
                                last_err = None;
                                break;
                            }
                            delay = delay.saturating_mul(2);
                        }
                    }
                }
            }
            if cancelled {
                // Mirror the streaming fn's mid-stream cancel so the frontend
                // clears its streaming state exactly as it would otherwise.
                streaming::emit_error_event(&app_handle, &conv_id, &msg_id, "Cancelled by user");
            } else if let Some(err) = last_err {
                streaming::emit_error_event(
                    &app_handle,
                    &conv_id,
                    &msg_id,
                    &format!("AI stream failed after retries: {err}"),
                );
            }
            deregister(&active, &conv_id, my_token);
        });

        Ok(())
    }

    /// Signal an in-flight conversation to stop. No-op if `conversation_id`
    /// is unknown.
    pub fn stop(&self, conversation_id: &str) {
        let mut active = self.active.lock();
        if let Some((_, tx)) = active.remove(conversation_id) {
            let _ = tx.send(true);
            tracing::info!("ai: stop signalled for conv={conversation_id}");
        }
    }
}

fn deregister(active: &ActiveMap, conv_id: &str, token: u64) {
    // Only evict OUR entry — a newer send() for the same conversation may have
    // already replaced it; removing that would orphan the new task's canceller
    // (leaving the resent stream uncancellable / hung).
    let mut map = active.lock();
    if map.get(conv_id).map(|(t, _)| *t) == Some(token) {
        map.remove(conv_id);
    }
}

/// Build the Anthropic request headers. The API key value never appears in
/// any error message produced here.
fn build_headers(api_key: &str) -> Result<HeaderMap, AppError> {
    let mut headers = HeaderMap::with_capacity(4);
    let mut key_value = HeaderValue::from_str(api_key)
        .map_err(|_| AppError::InvalidInput("api key contains invalid header bytes".into()))?;
    key_value.set_sensitive(true);
    headers.insert(HeaderName::from_static("x-api-key"), key_value);
    headers.insert(
        HeaderName::from_static("anthropic-version"),
        HeaderValue::from_static(ANTHROPIC_VERSION),
    );
    headers.insert(
        reqwest::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(
        reqwest::header::ACCEPT,
        HeaderValue::from_static("text/event-stream"),
    );
    Ok(headers)
}

/// OpenAI-compatible auth headers (Groq / Mistral / Cerebras / DeepSeek):
/// `Authorization: Bearer <key>` plus JSON request / SSE response negotiation.
fn build_openai_headers(api_key: &str) -> Result<HeaderMap, AppError> {
    let mut headers = HeaderMap::with_capacity(3);
    let mut auth = HeaderValue::from_str(&format!("Bearer {api_key}"))
        .map_err(|_| AppError::InvalidInput("api key contains invalid header bytes".into()))?;
    auth.set_sensitive(true);
    headers.insert(reqwest::header::AUTHORIZATION, auth);
    headers.insert(
        reqwest::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(
        reqwest::header::ACCEPT,
        HeaderValue::from_static("text/event-stream"),
    );
    Ok(headers)
}
