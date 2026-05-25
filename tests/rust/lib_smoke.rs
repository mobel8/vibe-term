//! Smoke test for the public surface of `vibe_term_lib`.
//!
//! Ensures the items we expose from `src-tauri/src/lib.rs` continue to be
//! reachable from a downstream crate. This catches accidental `pub` →
//! private regressions that the unit tests inside `src-tauri/` would not
//! notice (because they live in the same crate as the items they test).
//!
//! Wire it into the cargo test runner via:
//!
//! ```toml
//! [[test]]
//! name = "lib_smoke"
//! path = "../tests/rust/lib_smoke.rs"
//! ```

#![warn(clippy::all, rust_2018_idioms)]

use vibe_term_lib::AppError;

/// Constructing `AppError::other(...)` from the outside compiles only if the
/// type is re-exported at the crate root and its `other` constructor is `pub`.
#[test]
fn app_error_other_constructor_is_public() {
    let err = AppError::other("test");
    let msg = format!("{err}");
    assert!(
        msg.contains("test"),
        "AppError::other should surface its payload via Display, got {msg:?}"
    );
}

/// `AppError` carries a `Serialize` impl so it can ride across the IPC bridge.
/// We assert the on-wire shape (a plain string) here so a refactor that
/// switches to `#[serde(tag = ...)]` (which would break the frontend) fails
/// loudly.
#[test]
fn app_error_serialises_as_string() {
    let err = AppError::other("payload");
    let json = serde_json::to_string(&err).expect("serialise AppError");
    // `AppError::Other` carries the canonical thiserror prefix from `error.rs`
    // (`"unknown error: {0}"`). What matters for the frontend is that the
    // wire shape is a plain string and the original message is preserved.
    assert!(
        json.starts_with('"') && json.ends_with('"'),
        "AppError must serialise as a plain JSON string, got {json}"
    );
    assert!(
        json.contains("payload"),
        "AppError JSON must preserve the inner message, got {json}"
    );
}

/// The conversion impls used inside the `#[tauri::command]` glue must keep
/// compiling — if any of them disappear, the command surface breaks at the
/// call site rather than here, so we lock them down explicitly.
#[test]
fn app_error_conversions_compile() {
    let io_err: AppError = std::io::Error::other("io").into();
    assert!(format!("{io_err}").contains("io"));

    let serde_err: AppError = serde_json::from_str::<serde_json::Value>("not json")
        .expect_err("invalid json should fail to parse")
        .into();
    assert!(
        format!("{serde_err}")
            .to_lowercase()
            .contains("serialisation")
            || format!("{serde_err}")
                .to_lowercase()
                .contains("serialization")
            || format!("{serde_err}").to_lowercase().contains("expected")
    );

    let any_err: AppError = anyhow::anyhow!("boom").into();
    assert!(format!("{any_err}").contains("boom"));
}
