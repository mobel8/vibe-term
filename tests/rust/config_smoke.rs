//! Smoke tests for the `config` subsystem.
//!
//! These run against the `vibe_term_lib` crate as a regular library consumer,
//! so they exercise the public surface (`Settings::from_toml_str`, default
//! hotkeys, JSON patching) without touching Tauri runtime bits.
//!
//! Lives outside the `src-tauri` crate to keep config-specific integration
//! coverage isolated from Tauri's AppHandle plumbing. To wire it into the
//! cargo test runner, add the following entry to `src-tauri/Cargo.toml`
//! (handled by the main agent, not Agent C):
//!
//! ```toml
//! [[test]]
//! name = "config_smoke"
//! path = "../tests/rust/config_smoke.rs"
//! ```
//!
//! The full hot-reload path (notify watcher + Tauri event emit) is covered by
//! the integration loop on a live `pnpm tauri dev` session — wiring a Tauri
//! `AppHandle` from a unit test requires a full `tauri::test::mock_app()`
//! setup, which is out of scope here.
//!
//! Note: `config` must be re-exported as `pub mod config;` from
//! `src-tauri/src/lib.rs` for these tests to compile (also handled by the
//! main agent).

#![warn(clippy::all, rust_2018_idioms)]

use std::io::Write;
use std::path::PathBuf;

use vibe_term_lib::config::{default_hotkeys, AiProvider, CursorStyle, Settings};

/// Build a unique tempfile path under the OS temp dir.
fn temp_toml_path() -> PathBuf {
    let mut p = std::env::temp_dir();
    let suffix = nanoid::nanoid!(10);
    p.push(format!("vibe-term-config-smoke-{suffix}.toml"));
    p
}

#[test]
fn parses_minimal_toml_with_defaults_filling_holes() {
    // Only one section provided; everything else must fall back to defaults.
    let toml = r#"
        [appearance]
        theme = "dracula"
        font_size = 16
    "#;

    let parsed = Settings::from_toml_str(toml).expect("minimal TOML should parse");
    assert_eq!(parsed.appearance.theme, "dracula");
    assert_eq!(parsed.appearance.font_size, 16);
    // Default fields preserved.
    assert_eq!(parsed.appearance.font_family, "JetBrains Mono");
    assert_eq!(parsed.appearance.cursor_style, CursorStyle::Block);
    assert_eq!(parsed.general.scrollback_lines, 10_000);
    assert_eq!(parsed.ai.provider, AiProvider::Anthropic);
}

#[test]
fn default_contains_all_canonical_hotkeys() {
    let settings = Settings::default();
    let defaults = default_hotkeys();
    assert_eq!(settings.hotkeys.len(), defaults.len());
    for (k, v) in defaults {
        assert_eq!(settings.hotkeys.get(&k), Some(&v));
    }
    // Spot-check a few of the well-known bindings.
    assert_eq!(settings.hotkeys.get("new_tab"), Some(&"Ctrl+T".to_string()));
    assert_eq!(
        settings.hotkeys.get("command_palette"),
        Some(&"Ctrl+K".to_string())
    );
}

#[test]
fn apply_patch_merges_and_validates() {
    let base = Settings::default();
    let patch = serde_json::json!({
        "appearance": { "theme": "nord", "font_size": 14 },
        "ai": { "model": "claude-sonnet-4-6" },
        "hotkeys": { "new_tab": "Ctrl+N" }
    });
    let next = base.apply_patch(patch).expect("valid patch must apply");
    assert_eq!(next.appearance.theme, "nord");
    assert_eq!(next.appearance.font_size, 14);
    // Untouched scalar preserved.
    assert_eq!(next.appearance.line_height, 1.4);
    assert_eq!(next.ai.model, "claude-sonnet-4-6");
    assert_eq!(next.ai.provider, AiProvider::Anthropic);
    // Hotkeys map merged at the key level.
    assert_eq!(next.hotkeys.get("new_tab"), Some(&"Ctrl+N".to_string()));
    assert_eq!(
        next.hotkeys.get("toggle_ai_panel"),
        Some(&"Ctrl+I".to_string())
    );
}

#[test]
fn apply_patch_rejects_invalid_types() {
    let base = Settings::default();
    let patch = serde_json::json!({
        "appearance": { "font_size": "huge" } // wrong type
    });
    assert!(base.apply_patch(patch).is_err());
}

#[test]
fn round_trip_through_disk_preserves_settings() {
    let original = Settings::default();
    let serialised = original.to_toml_string().expect("serialise default");

    let path = temp_toml_path();
    {
        let mut file = std::fs::File::create(&path).expect("create tempfile");
        file.write_all(serialised.as_bytes()).expect("write toml");
    }
    let raw = std::fs::read_to_string(&path).expect("read back");
    let _ = std::fs::remove_file(&path); // best-effort cleanup

    let parsed = Settings::from_toml_str(&raw).expect("re-parse");
    assert_eq!(parsed, original);
}
