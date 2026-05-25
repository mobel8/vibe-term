//! Anthropic Messages API request types and payload builder.
//!
//! Constructs the JSON body for `POST /v1/messages` from a [`SendRequest`].
//! Multimodal content (text + base64 images) is supported via [`ContentBlock`].
//! When a `system_prompt` is provided we wrap it in a single block with
//! `cache_control: {"type": "ephemeral"}` so Anthropic caches the prefix and
//! re-uses it across follow-up turns of the same conversation — the per-turn
//! cost drops from a full prompt re-encode to a `cache_read_input_tokens` line
//! in the usage object.

#![warn(clippy::all, rust_2018_idioms)]

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// User-facing request envelope sent from the frontend to `ai_send`.
///
/// `api_key` is injected by the command layer from the keystore — the frontend
/// only ever sees the redacted preview (`sk-ant-...••••`) and never the raw
/// secret.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    /// Routing key for `ai://*` events, scopes deltas to one conversation.
    pub conversation_id: String,
    /// Identifier of the assistant message being streamed (frontend assigns).
    pub message_id: String,
    pub model: ClaudeModel,
    /// `max_tokens` Anthropic limit. Default 4096; some models accept 8192.
    pub max_tokens: u32,
    /// Optional system prompt — cached on the Anthropic side when present.
    #[serde(default)]
    pub system_prompt: Option<String>,
    pub messages: Vec<Message>,
    /// Raw API key; injected by `commands::ai_send` from the keystore. Empty
    /// string means "use the stored key" so the frontend never transmits it.
    #[serde(default)]
    pub api_key: String,
    /// Sampling temperature, 0.0..=1.0. None => Anthropic default.
    #[serde(default)]
    pub temperature: Option<f32>,
}

/// Public-facing model IDs. The wire representation is the Anthropic model
/// slug (see [`ClaudeModel::api_id`]).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
pub enum ClaudeModel {
    /// Claude Opus 4.7 — vision, 2576px max image edge, 1M context.
    #[serde(rename = "opus-4-7")]
    Opus47,
    /// Claude Sonnet 4.6 — 1M context, balanced quality/cost.
    #[serde(rename = "sonnet-4-6")]
    Sonnet46,
    /// Claude Haiku 4.5 — fast/cheap, smaller context.
    #[serde(rename = "haiku-4-5")]
    Haiku45,
}

impl ClaudeModel {
    /// Anthropic model slug for `model` field in `POST /v1/messages`.
    pub fn api_id(self) -> &'static str {
        match self {
            ClaudeModel::Opus47 => "claude-opus-4-7",
            ClaudeModel::Sonnet46 => "claude-sonnet-4-6",
            ClaudeModel::Haiku45 => "claude-haiku-4-5-20251001",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: Role,
    pub content: Vec<ContentBlock>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

/// One content block inside a [`Message`]. Anthropic's API expects an
/// array of objects with a discriminating `type` field, which serde produces
/// natively via `#[serde(tag = "type", rename_all = "snake_case")]`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text { text: String },
    Image { source: ImageSource },
}

/// Anthropic only accepts `type = "base64"` image sources today (URLs require
/// the Files API beta). The data must be plain base64 without the `data:`
/// scheme prefix.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ImageSource {
    /// e.g. `"image/png"`, `"image/jpeg"`, `"image/webp"`, `"image/gif"`.
    pub media_type: String,
    /// Base64-encoded image bytes, no `data:image/...;base64,` prefix.
    pub data: String,
}

/// Token usage reported by Anthropic on `message_start` / `message_delta`.
/// Fields are optional because cache-related counters only appear when the
/// `cache_control` block is in play.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: u32,
    #[serde(default)]
    pub output_tokens: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u32>,
}

/// Build the JSON body for `POST /v1/messages`.
///
/// This function is pure: no I/O, no globals. It is exercised by
/// `tests/rust/ai_smoke.rs` to lock the on-wire shape.
pub fn build_anthropic_payload(req: &SendRequest) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "model": req.model.api_id(),
        "max_tokens": req.max_tokens,
        "stream": true,
        "messages": req.messages,
    });

    // Cache the system prompt with `ephemeral` TTL: subsequent turns within
    // ~5 minutes that re-use the same prefix get billed as cache reads.
    if let Some(prompt) = req.system_prompt.as_deref().filter(|s| !s.is_empty()) {
        payload["system"] = serde_json::json!([{
            "type": "text",
            "text": prompt,
            "cache_control": { "type": "ephemeral" },
        }]);
    }

    if let Some(temp) = req.temperature {
        payload["temperature"] = serde_json::json!(temp);
    }

    payload
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_includes_required_fields() {
        let req = SendRequest {
            conversation_id: "conv1".into(),
            message_id: "msg1".into(),
            model: ClaudeModel::Sonnet46,
            max_tokens: 1024,
            system_prompt: Some("You are helpful.".into()),
            messages: vec![Message {
                role: Role::User,
                content: vec![ContentBlock::Text { text: "Hi".into() }],
            }],
            api_key: "ignored".into(),
            temperature: Some(0.5),
        };
        let payload = build_anthropic_payload(&req);
        assert_eq!(payload["model"], "claude-sonnet-4-6");
        assert_eq!(payload["max_tokens"], 1024);
        assert_eq!(payload["stream"], true);
        assert_eq!(payload["temperature"], 0.5);
        assert_eq!(payload["system"][0]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn model_api_ids() {
        assert_eq!(ClaudeModel::Opus47.api_id(), "claude-opus-4-7");
        assert_eq!(ClaudeModel::Sonnet46.api_id(), "claude-sonnet-4-6");
        assert_eq!(ClaudeModel::Haiku45.api_id(), "claude-haiku-4-5-20251001");
    }
}
