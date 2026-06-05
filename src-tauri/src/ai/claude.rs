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
    /// Which API to route to (Anthropic, or an OpenAI-compatible provider).
    /// Determines the endpoint URL, auth header, payload, and SSE format.
    #[serde(default)]
    pub provider: AiProvider,
    /// Provider-specific model id, sent verbatim as the wire `model` (e.g.
    /// `"claude-opus-4-7"`, `"llama-3.3-70b-versatile"`, `"deepseek-chat"`).
    pub model: String,
    /// `max_tokens` limit. Default 4096; some models accept 8192.
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
    //
    // `alias` lets serde ALSO accept the bare variant identifier the frontend
    // sends over IPC ("Opus47") in addition to the canonical wire slug. Without
    // it, deserialising the `model` field of every ai_send request failed
    // ("unknown variant `Opus47`"), so the whole command errored before running
    // and the AI panel was dead for all models. Serialisation still emits the
    // slug; ClaudeModel is never serialised back to the frontend (rows store a
    // plain String), so this is regression-free.
    #[serde(rename = "opus-4-7", alias = "Opus47")]
    Opus47,
    /// Claude Sonnet 4.6 — 1M context, balanced quality/cost.
    #[serde(rename = "sonnet-4-6", alias = "Sonnet46")]
    Sonnet46,
    /// Claude Haiku 4.5 — fast/cheap, smaller context.
    #[serde(rename = "haiku-4-5", alias = "Haiku45")]
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

/// AI provider a request is routed to. `Anthropic` uses the native Messages
/// API; the rest are OpenAI-compatible (`POST {base}/chat/completions` with
/// OpenAI-style SSE). One stored API key per provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum AiProvider {
    #[default]
    Anthropic,
    Groq,
    Mistral,
    Cerebras,
    Deepseek,
}

impl AiProvider {
    /// True for the native Anthropic Messages API; false ⇒ OpenAI-compatible.
    pub fn is_anthropic(self) -> bool {
        matches!(self, AiProvider::Anthropic)
    }

    /// Endpoint base. Anthropic is the full Messages URL; OpenAI-compatible
    /// providers return the API base that `/chat/completions` is appended to.
    pub fn base_url(self) -> &'static str {
        match self {
            AiProvider::Anthropic => "https://api.anthropic.com/v1/messages",
            AiProvider::Groq => "https://api.groq.com/openai/v1",
            AiProvider::Mistral => "https://api.mistral.ai/v1",
            AiProvider::Cerebras => "https://api.cerebras.ai/v1",
            AiProvider::Deepseek => "https://api.deepseek.com/v1",
        }
    }

    /// OS-keystore account name — one stored key per provider.
    pub fn keystore_account(self) -> &'static str {
        match self {
            AiProvider::Anthropic => "anthropic_api_key",
            AiProvider::Groq => "groq_api_key",
            AiProvider::Mistral => "mistral_api_key",
            AiProvider::Cerebras => "cerebras_api_key",
            AiProvider::Deepseek => "deepseek_api_key",
        }
    }
}

/// One provider's selectable model lineup, surfaced to the frontend via
/// `ai_list_models` so the wire `model` strings have a single source of truth.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ProviderModels {
    pub provider: AiProvider,
    pub label: String,
    pub models: Vec<String>,
}

/// Practical, current model catalogue per provider. Lineups evolve over time;
/// the user can still type any model id the provider accepts.
pub fn provider_catalogue() -> Vec<ProviderModels> {
    fn p(provider: AiProvider, label: &str, models: &[&str]) -> ProviderModels {
        ProviderModels {
            provider,
            label: label.to_string(),
            models: models.iter().map(|m| m.to_string()).collect(),
        }
    }
    vec![
        p(
            AiProvider::Anthropic,
            "Anthropic",
            &[
                "claude-opus-4-7",
                "claude-sonnet-4-6",
                "claude-haiku-4-5-20251001",
            ],
        ),
        p(
            AiProvider::Groq,
            "Groq",
            &[
                "llama-3.3-70b-versatile",
                "llama-3.1-8b-instant",
                "meta-llama/llama-4-scout-17b-16e-instruct",
                "meta-llama/llama-4-maverick-17b-128e-instruct",
                "openai/gpt-oss-120b",
                "openai/gpt-oss-20b",
                "moonshotai/kimi-k2-instruct",
                "qwen-2.5-32b",
                "deepseek-r1-distill-llama-70b",
                "gemma2-9b-it",
            ],
        ),
        p(
            AiProvider::Mistral,
            "Mistral",
            &[
                "mistral-large-latest",
                "mistral-medium-latest",
                "mistral-small-latest",
                "magistral-medium-latest",
                "magistral-small-latest",
                "codestral-latest",
                "devstral-medium-latest",
                "ministral-8b-latest",
                "ministral-3b-latest",
                "pixtral-large-latest",
                "open-mistral-nemo",
            ],
        ),
        p(
            AiProvider::Cerebras,
            "Cerebras",
            &[
                "llama-3.3-70b",
                "llama3.1-8b",
                "llama-4-scout-17b-16e-instruct",
                "qwen-3-32b",
                "qwen-3-235b-a22b-instruct-2507",
                "gpt-oss-120b",
                "deepseek-r1-distill-llama-70b",
            ],
        ),
        p(
            AiProvider::Deepseek,
            "DeepSeek",
            &["deepseek-chat", "deepseek-reasoner"],
        ),
    ]
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
fn base64_source_kind() -> String {
    "base64".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub struct ImageSource {
    /// Anthropic requires `"type": "base64"` on every image source. The old
    /// struct emitted neither this field NOR a snake_case `media_type` (it
    /// renamed to camelCase `mediaType`), so every outbound image block was
    /// rejected by the API. We default `kind` on input — the frontend omits it
    /// over IPC — and always emit it as `"type"` for Anthropic.
    #[serde(rename = "type", default = "base64_source_kind")]
    pub kind: String,
    /// e.g. `"image/png"`, `"image/jpeg"`, `"image/webp"`, `"image/gif"`.
    /// `alias` accepts the frontend's camelCase `mediaType` on the IPC inbound
    /// path while serialising the snake_case `media_type` Anthropic expects.
    #[serde(alias = "mediaType")]
    pub media_type: String,
    /// Base64-encoded image bytes, no `data:image/...;base64,` prefix.
    pub data: String,
}

/// Token usage reported by Anthropic on `message_start` / `message_delta`.
/// Fields are optional because cache-related counters only appear when the
/// `cache_control` block is in play.
///
/// Anthropic emits the fields in `snake_case` over the wire, while our
/// frontend expects `camelCase` payloads — rename only on serialise so the
/// SSE parser can deserialise the API form unchanged.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(rename_all(serialize = "camelCase"))]
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
/// This function is pure: no I/O, no globals. Its on-wire shape is locked by
/// the `payload_includes_required_fields` test in this module's `tests` block.
pub fn build_anthropic_payload(req: &SendRequest) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "model": req.model,
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

/// Build an OpenAI-compatible `POST /chat/completions` body for Groq, Mistral,
/// Cerebras and DeepSeek. The system prompt becomes a leading `system` message.
/// Multimodal content is flattened to plain text: these providers' default
/// models are text-only, so emitting OpenAI `image_url` parts would error —
/// images are noted with a `[image]` marker instead of dropped silently.
pub fn build_openai_payload(req: &SendRequest) -> serde_json::Value {
    let mut messages: Vec<serde_json::Value> = Vec::with_capacity(req.messages.len() + 1);
    if let Some(prompt) = req.system_prompt.as_deref().filter(|s| !s.is_empty()) {
        messages.push(serde_json::json!({ "role": "system", "content": prompt }));
    }
    for m in &req.messages {
        let mut text = String::new();
        let mut had_image = false;
        for block in &m.content {
            match block {
                ContentBlock::Text { text: t } => {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(t);
                }
                ContentBlock::Image { .. } => had_image = true,
            }
        }
        if had_image {
            text.push_str(if text.is_empty() {
                "[image]"
            } else {
                "\n[image attached]"
            });
        }
        let role = match m.role {
            Role::User => "user",
            Role::Assistant => "assistant",
        };
        messages.push(serde_json::json!({ "role": role, "content": text }));
    }
    let mut payload = serde_json::json!({
        "model": req.model,
        "stream": true,
        "max_tokens": req.max_tokens,
        "messages": messages,
        // Opt into usage accounting: OpenAI-compatible streams only emit a
        // `usage` object on the terminal chunk when this is set. Without it
        // Groq/Mistral/Cerebras/DeepSeek report 0 input/output tokens (and $0
        // cost) in the UI. All four providers accept this field.
        "stream_options": { "include_usage": true },
    });
    if let Some(temp) = req.temperature {
        payload["temperature"] = serde_json::json!(temp);
    }
    payload
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_req(provider: AiProvider, model: &str) -> SendRequest {
        SendRequest {
            conversation_id: "conv1".into(),
            message_id: "msg1".into(),
            provider,
            model: model.into(),
            max_tokens: 1024,
            system_prompt: Some("You are helpful.".into()),
            messages: vec![Message {
                role: Role::User,
                content: vec![ContentBlock::Text { text: "Hi".into() }],
            }],
            api_key: "ignored".into(),
            temperature: Some(0.5),
        }
    }

    #[test]
    fn payload_includes_required_fields() {
        let req = sample_req(AiProvider::Anthropic, "claude-sonnet-4-6");
        let payload = build_anthropic_payload(&req);
        assert_eq!(payload["model"], "claude-sonnet-4-6");
        assert_eq!(payload["max_tokens"], 1024);
        assert_eq!(payload["stream"], true);
        assert_eq!(payload["temperature"], 0.5);
        assert_eq!(payload["system"][0]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn openai_payload_shape() {
        let req = sample_req(AiProvider::Groq, "llama-3.3-70b-versatile");
        let payload = build_openai_payload(&req);
        // Model is sent verbatim, stream + usage opt-in are present.
        assert_eq!(payload["model"], "llama-3.3-70b-versatile");
        assert_eq!(payload["stream"], true);
        assert_eq!(payload["stream_options"]["include_usage"], true);
        // System prompt becomes a leading `system` message, then the user turn.
        assert_eq!(payload["messages"][0]["role"], "system");
        assert_eq!(payload["messages"][0]["content"], "You are helpful.");
        assert_eq!(payload["messages"][1]["role"], "user");
        assert_eq!(payload["messages"][1]["content"], "Hi");
    }

    #[test]
    fn model_api_ids() {
        assert_eq!(ClaudeModel::Opus47.api_id(), "claude-opus-4-7");
        assert_eq!(ClaudeModel::Sonnet46.api_id(), "claude-sonnet-4-6");
        assert_eq!(ClaudeModel::Haiku45.api_id(), "claude-haiku-4-5-20251001");
    }
}
