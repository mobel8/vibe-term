//! Serialisable settings tree — the source of truth for every user-facing
//! preference exposed by vibe-term.
//!
//! The root [`Settings`] struct round-trips between TOML on disk and JSON across
//! the IPC boundary. Every field carries `#[serde(default)]` so partial configs
//! never break startup; missing sections are populated from the built-in
//! defaults instead. The same struct is exported to TypeScript via `ts-rs` so
//! the frontend speaks the same shape.
//!
//! Defaults live in `Default` impls (not duplicated in `default_config.toml`):
//! the TOML file is purely a friendly bootstrap document for the user.
//!
//! Hot-reload semantics: when the watcher detects a change, the entire struct
//! is re-parsed and atomically swapped under a `RwLock`, then broadcast on the
//! `config://changed` event with the full payload.

#![warn(clippy::all, rust_2018_idioms)]

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::AppError;

/// Root configuration node. Every section is optional in TOML/JSON and falls
/// back to its `Default` implementation when missing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub general: GeneralSettings,
    pub appearance: AppearanceSettings,
    pub hotkeys: HashMap<String, String>,
    pub ai: AiSettings,
    pub terminal: TerminalSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            general: GeneralSettings::default(),
            appearance: AppearanceSettings::default(),
            hotkeys: default_hotkeys(),
            ai: AiSettings::default(),
            terminal: TerminalSettings::default(),
        }
    }
}

impl Settings {
    /// Parse from a TOML document. Returns an [`AppError::InvalidInput`] when
    /// the document is malformed.
    pub fn from_toml_str(input: &str) -> Result<Self, AppError> {
        toml::from_str::<Self>(input)
            .map_err(|e| AppError::InvalidInput(format!("invalid TOML config: {e}")))
    }

    /// Serialise back to a pretty TOML document suitable for writing to disk
    /// (preserves section order, indentation, etc.).
    pub fn to_toml_string(&self) -> Result<String, AppError> {
        toml::to_string_pretty(self)
            .map_err(|e| AppError::Other(format!("failed to serialise config to TOML: {e}")))
    }

    /// Apply a JSON patch on top of the current settings. The patch is merged
    /// field-by-field via `serde_json::Value::merge_into`, then re-validated by
    /// round-tripping through the typed struct.
    pub fn apply_patch(&self, patch: serde_json::Value) -> Result<Self, AppError> {
        let mut current = serde_json::to_value(self)?;
        merge_json(&mut current, patch);
        let merged: Self = serde_json::from_value(current)
            .map_err(|e| AppError::InvalidInput(format!("invalid config patch: {e}")))?;
        Ok(merged)
    }
}

/// Recursive JSON merge following RFC 7396 *merge patch* semantics:
/// - two objects: merge depth-first, `null` patch entries delete the field;
/// - anything else: the patch value replaces the destination wholesale.
fn merge_json(dst: &mut serde_json::Value, patch: serde_json::Value) {
    match (dst, patch) {
        (serde_json::Value::Object(dst_map), serde_json::Value::Object(patch_map)) => {
            for (k, v) in patch_map {
                if v.is_null() {
                    dst_map.remove(&k);
                } else {
                    merge_json(dst_map.entry(k).or_insert(serde_json::Value::Null), v);
                }
            }
        }
        (dst_slot, other) => {
            *dst_slot = other;
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(default, rename_all = "camelCase")]
pub struct GeneralSettings {
    /// Absolute path to a shell binary. `None` means: detect at runtime.
    pub default_shell: Option<String>,
    /// Working directory for newly spawned shells. `None` means `$HOME`.
    pub working_directory: Option<String>,
    /// Scrollback buffer length per terminal pane (xterm.js cap).
    pub scrollback_lines: u32,
    /// Ask before closing a tab/window with a live process.
    pub confirm_on_close: bool,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            default_shell: None,
            working_directory: None,
            scrollback_lines: 10_000,
            confirm_on_close: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(default, rename_all = "camelCase")]
pub struct AppearanceSettings {
    /// Theme name. Must match one of the bundled themes
    /// (`"dark" | "light" | "dracula" | "nord" | "tokyo-night"`).
    pub theme: String,
    pub font_family: String,
    pub font_size: u16,
    pub line_height: f32,
    pub cursor_style: CursorStyle,
    pub cursor_blink: bool,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
            font_family: "JetBrains Mono".to_string(),
            font_size: 13,
            line_height: 1.4,
            cursor_style: CursorStyle::Block,
            cursor_blink: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum CursorStyle {
    #[default]
    Block,
    Bar,
    Underline,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(default, rename_all = "camelCase")]
pub struct AiSettings {
    pub provider: AiProvider,
    /// Model identifier passed verbatim to the provider SDK.
    pub model: String,
    /// How many terminal blocks to auto-attach as context per AI message.
    pub max_context_blocks: u32,
    /// Token count over which the conversation triggers an auto-summarisation pass.
    pub auto_summarize_threshold_tokens: u32,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            provider: AiProvider::Anthropic,
            model: "claude-opus-4-7".to_string(),
            max_context_blocks: 5,
            auto_summarize_threshold_tokens: 150_000,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum AiProvider {
    // `alias = "openai"` migrates configs written by older builds whose enum
    // had an `OpenAI` variant. Without it, a present-but-unknown provider value
    // is a hard deserialize error that makes the WHOLE config fall back to
    // defaults (and the next save overwrites the user's real config on disk).
    #[default]
    #[serde(alias = "openai")]
    Anthropic,
    // OpenAI-compatible providers. snake_case yields the exact wire values the
    // frontend sends ("groq", "mistral", "cerebras", "deepseek"), so persisting
    // a provider choice round-trips cleanly through `config_update`. Kept in
    // sync with the send-path `crate::ai::AiProvider` enum.
    Groq,
    Mistral,
    Cerebras,
    Deepseek,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(default, rename_all = "camelCase")]
pub struct TerminalSettings {
    pub bell: bool,
    pub copy_on_select: bool,
    pub right_click_paste: bool,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            bell: true,
            copy_on_select: false,
            right_click_paste: true,
        }
    }
}

/// Built-in hotkey map. Kept as a free function so it can be reused by both
/// `Default::default` and tests that introspect the canonical bindings.
pub fn default_hotkeys() -> HashMap<String, String> {
    [
        ("new_tab", "Ctrl+T"),
        ("close_tab", "Ctrl+W"),
        ("split_horizontal", "Ctrl+Shift+E"),
        ("split_vertical", "Ctrl+Shift+D"),
        ("toggle_ai_panel", "Ctrl+I"),
        ("search_history", "Ctrl+R"),
        ("screenshot_region", "Ctrl+Alt+S"),
        ("screenshot_full", "Ctrl+Alt+F"),
        ("command_palette", "Ctrl+K"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_contain_canonical_hotkeys() {
        let settings = Settings::default();
        assert_eq!(settings.hotkeys.get("new_tab"), Some(&"Ctrl+T".to_string()));
        assert_eq!(
            settings.hotkeys.get("toggle_ai_panel"),
            Some(&"Ctrl+I".to_string())
        );
        assert_eq!(settings.hotkeys.len(), 9);
    }

    #[test]
    fn round_trip_via_toml() {
        let original = Settings::default();
        let serialised = original.to_toml_string().unwrap();
        let parsed = Settings::from_toml_str(&serialised).unwrap();
        assert_eq!(parsed, original);
    }

    #[test]
    fn apply_patch_merges_nested_fields() {
        let base = Settings::default();
        let patch = serde_json::json!({
            "appearance": { "theme": "dracula", "font_size": 15 },
            "general": { "scrollback_lines": 5000 }
        });
        let next = base.apply_patch(patch).unwrap();
        assert_eq!(next.appearance.theme, "dracula");
        assert_eq!(next.appearance.font_size, 15);
        // Untouched field preserved.
        assert_eq!(next.appearance.font_family, "JetBrains Mono");
        assert_eq!(next.general.scrollback_lines, 5000);
    }
}
