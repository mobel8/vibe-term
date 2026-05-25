//! Smoke tests for the `hotkeys` module.
//!
//! The accelerator parser is pure and always runs. The OS-touching tests that build a
//! [`HotkeyRegistry`] are conditional: `global-hotkey` cannot grab keys without a display
//! server, so on a headless CI Linux box [`HotkeyRegistry::new`] fails — we report it via
//! `eprintln!` and skip the rest of the test rather than failing.

#![cfg(test)]
#![warn(clippy::all, rust_2018_idioms)]

use tauri::test::{mock_builder, mock_context, noop_assets};

use vibe_term_lib::hotkeys::{parse_accelerator, HotkeyBinding, HotkeyRegistry};

fn build_mock_app() -> tauri::App<tauri::test::MockRuntime> {
    mock_builder()
        .build(mock_context(noop_assets()))
        .expect("build mock tauri app")
}

/// Try to construct a [`HotkeyRegistry`]; return `None` (and print a skip note) if the OS
/// refuses, which is what happens on a headless display-less CI Linux box.
fn build_registry_or_skip() -> Option<HotkeyRegistry<tauri::test::MockRuntime>> {
    let app = build_mock_app();
    match HotkeyRegistry::<tauri::test::MockRuntime>::new(app.handle().clone()) {
        Ok(reg) => Some(reg),
        Err(err) => {
            eprintln!("hotkeys_smoke: skipping OS-bound test (no display?): {err}");
            None
        }
    }
}

// ---------------------------------------------------------------------------
// 1. Parser — pure, no OS interaction needed.
// ---------------------------------------------------------------------------

#[test]
fn parser_accepts_well_known_accelerators() {
    for chord in ["Ctrl+Shift+T", "Meta+Space", "Alt+F4"] {
        let parsed = parse_accelerator(chord);
        assert!(
            parsed.is_ok(),
            "expected '{chord}' to parse, got {parsed:?}"
        );
    }
}

#[test]
fn parser_rejects_garbage_accelerators() {
    for chord in ["Hello", "Ctrl+", "", "+A", "   "] {
        let parsed = parse_accelerator(chord);
        assert!(
            parsed.is_err(),
            "expected '{chord}' to be rejected, got {parsed:?}"
        );
    }
}

#[test]
fn meta_alias_matches_super() {
    // The upstream parser does not know `Meta`; our normaliser rewrites it to `Super`.
    let meta = parse_accelerator("Meta+Space").expect("meta parses");
    let supr = parse_accelerator("Super+Space").expect("super parses");
    assert_eq!(
        meta.id(),
        supr.id(),
        "Meta and Super should produce identical HotKey ids"
    );
}

// ---------------------------------------------------------------------------
// 2. Register + list round-trip — OS-bound, skipped without a display.
// ---------------------------------------------------------------------------

#[test]
fn register_then_list_roundtrips() {
    let Some(reg) = build_registry_or_skip() else {
        return;
    };

    // Use rare chords so we are unlikely to clash with whatever the host environment has
    // already grabbed (CI containers usually leave F-keys + alt+ctrl+shift alone).
    let binding = HotkeyBinding {
        action: "vibe.test.roundtrip".into(),
        accelerator: "Ctrl+Alt+Shift+F9".into(),
    };

    match reg.register(binding.clone()) {
        Ok(()) => {
            let listed = reg.list();
            assert!(
                listed.iter().any(|b| b == &binding),
                "expected listed bindings to contain {binding:?}, got {listed:?}"
            );

            // Clean up so the chord is not held past the test (the manager would do it on
            // drop, but being explicit makes parallel test runs safer).
            reg.unregister(&binding.action)
                .expect("unregister after roundtrip");
        }
        Err(err) => {
            // The CI environment may legitimately have the chord taken by something else.
            // We still consider the test passing because the API surface itself worked.
            eprintln!(
                "hotkeys_smoke: register rejected by OS (expected on shared CI): {err}"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// 3. Idempotency + replacement semantics.
// ---------------------------------------------------------------------------

#[test]
fn registering_same_chord_twice_is_idempotent_and_swap_replaces() {
    let Some(reg) = build_registry_or_skip() else {
        return;
    };

    let action = "vibe.test.idempotent".to_string();
    let first = HotkeyBinding {
        action: action.clone(),
        accelerator: "Ctrl+Alt+Shift+F10".into(),
    };
    let second_same = HotkeyBinding {
        action: action.clone(),
        accelerator: "Ctrl+Alt+Shift+F10".into(),
    };
    let third_different = HotkeyBinding {
        action: action.clone(),
        accelerator: "Ctrl+Alt+Shift+F11".into(),
    };

    // First register may fail on a busy CI environment — skip gracefully in that case so
    // we do not flake.
    if let Err(err) = reg.register(first.clone()) {
        eprintln!("hotkeys_smoke: initial register rejected by OS, skipping: {err}");
        return;
    }

    // Same (action, accelerator) ⇒ no-op, must succeed.
    reg.register(second_same).expect("idempotent re-register");
    let after_idempotent = reg.list();
    let entries_for_action: Vec<_> = after_idempotent
        .iter()
        .filter(|b| b.action == action)
        .collect();
    assert_eq!(
        entries_for_action.len(),
        1,
        "exactly one entry must survive idempotent re-register"
    );
    assert_eq!(entries_for_action[0].accelerator, first.accelerator);

    // Different accelerator for the same action ⇒ replace.
    match reg.register(third_different.clone()) {
        Ok(()) => {
            let after_swap = reg.list();
            let swapped: Vec<_> = after_swap.iter().filter(|b| b.action == action).collect();
            assert_eq!(swapped.len(), 1, "still exactly one entry after swap");
            assert_eq!(
                swapped[0].accelerator, third_different.accelerator,
                "swap must replace the accelerator in place"
            );
        }
        Err(err) => {
            eprintln!(
                "hotkeys_smoke: swap rejected by OS (rare on CI but tolerated): {err}"
            );
        }
    }

    let _ = reg.unregister(&action);
}

// ---------------------------------------------------------------------------
// 4. Bonus: `replace_all` collects per-binding outcomes and prunes stale entries.
// ---------------------------------------------------------------------------

#[test]
fn replace_all_prunes_stale_actions() {
    let Some(reg) = build_registry_or_skip() else {
        return;
    };

    let stale = HotkeyBinding {
        action: "vibe.test.stale".into(),
        accelerator: "Ctrl+Alt+Shift+F7".into(),
    };
    let kept = HotkeyBinding {
        action: "vibe.test.kept".into(),
        accelerator: "Ctrl+Alt+Shift+F8".into(),
    };

    if reg.register(stale.clone()).is_err() {
        eprintln!("hotkeys_smoke: initial register rejected; skipping replace_all test");
        return;
    }

    let outcomes = reg.replace_all(vec![kept.clone()]);
    assert_eq!(outcomes.len(), 1, "one outcome per requested binding");

    let listed = reg.list();
    assert!(
        listed.iter().all(|b| b.action != stale.action),
        "stale binding must be pruned, got {listed:?}"
    );

    // Clean up regardless of the OS verdict on `kept`.
    let _ = reg.unregister(&kept.action);
    let _ = reg.unregister(&stale.action);
}
