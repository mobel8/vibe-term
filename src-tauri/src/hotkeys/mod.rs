//! OS-level global hotkey registry (Phase 7).
//!
//! Wraps the [`global-hotkey`](https://docs.rs/global-hotkey) crate so the rest of the app
//! can register and unregister application-wide keyboard shortcuts that fire even when
//! `vibe-term` does not have focus. Window-scoped shortcuts (i.e. only when the webview
//! is focused) are handled on the frontend in `Layout.tsx`; this module is strictly for
//! the OS-wide case.
//!
//! # Lifecycle
//!
//! [`HotkeyRegistry::new`] constructs an owned [`GlobalHotKeyManager`] **inside a single
//! background thread** and exposes a request/response channel that the public methods use
//! to talk to it. We do not move the manager across threads because on Windows it owns a
//! raw `HWND` that must stay pinned to the thread that created it — the upstream X11
//! backend uses the same architecture internally. The same thread also pumps
//! [`GlobalHotKeyEvent::receiver`] and re-emits each press as a Tauri event named
//! [`crate::events::HOTKEY_TRIGGERED`] (`"hotkey://triggered"`); only
//! [`HotKeyState::Pressed`] is forwarded — releases are dropped.
//!
//! # Accelerator format
//!
//! Accelerators look like `"Ctrl+Shift+T"`, `"Meta+Space"`, `"Alt+F4"`. The grammar is the
//! one understood by [`global_hotkey::hotkey::HotKey::from_str`], with one local extension:
//! the keyword **`Meta`** is accepted as an alias for the Super / Command modifier (the
//! upstream parser only knows `Command`/`Cmd`/`Super`). This mirrors how the rest of the
//! Tauri ecosystem advertises the key (e.g. `tauri::menu` accelerators).

#![warn(clippy::all, rust_2018_idioms)]

use std::collections::{HashMap, HashSet};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;

use global_hotkey::hotkey::HotKey;
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, Wry};
use tracing::{debug, warn};

use crate::error::AppError;
use crate::events::HOTKEY_TRIGGERED;

/// Payload serialised on `"hotkey://triggered"`. Mirrored on the TypeScript side by hand
/// (no `ts-rs` derive here to avoid forcing a binding regeneration on the parent caller).
#[derive(Debug, Clone, Serialize)]
struct HotkeyTriggeredEvent<'a> {
    action: &'a str,
}

/// One configured chord. `action` is an application-defined identifier (e.g. `"tab.new"`,
/// `"ai.toggle"`) — the frontend listens for [`crate::events::HOTKEY_TRIGGERED`] events and
/// dispatches by matching on `action`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HotkeyBinding {
    /// Stable application identifier — survives chord changes. Persisted to config.
    pub action: String,
    /// Human-typeable accelerator string. See module docs for grammar.
    pub accelerator: String,
}

/// Commands sent from the public API into the dispatch / manager thread.
enum Command {
    /// Try to register `hotkey`. The result is reported back via the embedded `oneshot`
    /// channel. Idempotency, conflict resolution and bookkeeping all happen *inside* the
    /// thread so callers see a single atomic outcome.
    Register {
        binding: HotkeyBinding,
        hotkey: HotKey,
        respond: mpsc::Sender<Result<(), AppError>>,
    },
    /// Drop the chord (if any) bound to `action`. Reports back the OS unregister error, if
    /// it surfaces one — otherwise `Ok(())` even when the action was unknown.
    Unregister {
        action: String,
        respond: mpsc::Sender<Result<(), AppError>>,
    },
    /// Snapshot the live `(action, accelerator)` table.
    List {
        respond: mpsc::Sender<Vec<HotkeyBinding>>,
    },
}

/// OS-level global hotkey registry.
///
/// Construct once at startup (via [`HotkeyRegistry::new`]), share behind an `Arc`. Every
/// method takes `&self` and is cheap (it sends a message and waits on a `oneshot` reply).
///
/// Generic over the Tauri runtime so integration tests can drive the registry with a
/// `MockRuntime` `AppHandle` (mirroring [`crate::images::ImageManager`]).
pub struct HotkeyRegistry<R: Runtime = Wry> {
    /// Sender end of the manager-thread mailbox. We keep this and never close it, so the
    /// thread runs for the lifetime of the registry.
    tx: mpsc::Sender<Command>,
    /// Phantom-ish hold on the Tauri runtime parameter. The dispatch thread already owns
    /// its own [`AppHandle`] clone for emitting events; we keep one here too so callers
    /// can extract it later without re-borrowing global state.
    #[allow(dead_code)]
    app_handle: AppHandle<R>,
}

impl<R: Runtime> HotkeyRegistry<R> {
    /// Build the registry: spawn the manager / dispatch thread and synchronously wait for
    /// it to confirm whether [`GlobalHotKeyManager::new`] succeeded. Returns the original
    /// OS error on failure (typically "no display server" on headless Linux CI).
    pub fn new(app_handle: AppHandle<R>) -> Result<Self, AppError> {
        let (cmd_tx, cmd_rx) = mpsc::channel::<Command>();
        let (init_tx, init_rx) = mpsc::channel::<Result<(), AppError>>();

        let app_for_thread = app_handle.clone();
        thread::Builder::new()
            .name("vibe-term-hotkey-mgr".into())
            .spawn(move || {
                run_manager_thread(app_for_thread, cmd_rx, init_tx);
            })
            .map_err(|e| AppError::other(format!("hotkeys: spawn manager thread: {e}")))?;

        match init_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                tx: cmd_tx,
                app_handle,
            }),
            Ok(Err(err)) => Err(err),
            Err(err) => Err(AppError::other(format!(
                "hotkeys: manager thread died before reporting init: {err}"
            ))),
        }
    }

    /// Register `binding`. Idempotent on identical `(action, accelerator)` pairs. If the
    /// same `action` was previously bound to a different accelerator, the old chord is
    /// released before the new one is installed.
    ///
    /// Errors:
    /// * [`AppError::InvalidInput`] when the accelerator cannot be parsed.
    /// * [`AppError::Other`] when the OS rejects the chord (already grabbed by another
    ///   process, unsupported platform, …) or another action already owns it.
    pub fn register(&self, binding: HotkeyBinding) -> Result<(), AppError> {
        let hotkey = parse_accelerator(&binding.accelerator)?;
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(Command::Register {
                binding,
                hotkey,
                respond: tx,
            })
            .map_err(|_| AppError::other("hotkeys: manager thread is gone"))?;
        rx.recv()
            .map_err(|_| AppError::other("hotkeys: manager thread dropped response"))?
    }

    /// Drop the chord bound to `action`. Silently succeeds if the action was never
    /// registered — this lets callers `unregister` before `register` without checking.
    pub fn unregister(&self, action: &str) -> Result<(), AppError> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(Command::Unregister {
                action: action.to_string(),
                respond: tx,
            })
            .map_err(|_| AppError::other("hotkeys: manager thread is gone"))?;
        rx.recv()
            .map_err(|_| AppError::other("hotkeys: manager thread dropped response"))?
    }

    /// Atomically replace the full set of bindings. Anything currently active that is
    /// **not** in `bindings` is unregistered first; new bindings are then installed.
    /// Per-binding errors are collected into the returned `Vec` (same order as the input)
    /// so the caller can report partial failures without losing the chords that *did*
    /// succeed.
    pub fn replace_all(&self, bindings: Vec<HotkeyBinding>) -> Vec<Result<(), AppError>> {
        let target_actions: HashSet<String> = bindings.iter().map(|b| b.action.clone()).collect();

        // 1. Prune stale actions first. We snapshot, then unregister outside the snapshot
        //    lock — `list()` already takes a fresh lock under the hood.
        let snapshot = self.list();
        for existing in snapshot {
            if !target_actions.contains(&existing.action) {
                if let Err(err) = self.unregister(&existing.action) {
                    warn!(
                        target: "vibe_term::hotkeys",
                        action = %existing.action,
                        "replace_all: failed to unregister stale action: {err}"
                    );
                }
            }
        }

        // 2. Install / refresh each desired binding. `register` is idempotent, so
        //    unchanged entries are cheap no-ops and changed accelerators are swapped in
        //    place. We capture the per-binding outcome so callers can report partial
        //    failures upstream.
        bindings.into_iter().map(|b| self.register(b)).collect()
    }

    /// Snapshot of every currently-active `(action, accelerator)` pair. Output ordering
    /// is unspecified — callers that need determinism should sort by `action`.
    pub fn list(&self) -> Vec<HotkeyBinding> {
        let (tx, rx) = mpsc::channel();
        if self.tx.send(Command::List { respond: tx }).is_err() {
            return Vec::new();
        }
        rx.recv().unwrap_or_default()
    }
}

/// Bookkeeping kept inside the manager thread. The `accelerator` is stored verbatim so
/// [`HotkeyRegistry::list`] can echo it back in the original casing.
struct ActiveBinding {
    hotkey: HotKey,
    accelerator: String,
}

/// Body of the manager thread:
///
/// 1. Build a [`GlobalHotKeyManager`] on this thread (mandatory on Windows / macOS).
/// 2. Report success / failure on `init_tx` so [`HotkeyRegistry::new`] can return the
///    error to the caller verbatim.
/// 3. Spawn a sibling dispatch thread for the event receiver — this keeps command
///    processing low-latency even when the receiver is firing rapidly.
/// 4. Service `Command`s from `cmd_rx` until the registry is dropped.
fn run_manager_thread<R: Runtime>(
    app_handle: AppHandle<R>,
    cmd_rx: mpsc::Receiver<Command>,
    init_tx: mpsc::Sender<Result<(), AppError>>,
) {
    let manager = match GlobalHotKeyManager::new() {
        Ok(m) => m,
        Err(err) => {
            let _ = init_tx.send(Err(AppError::other(format!(
                "hotkeys: manager init failed: {err}"
            ))));
            return;
        }
    };
    // Bookkeeping is shared between the command loop (writers) and the dispatch thread
    // (reader). Both live on threads we own, so `Arc<Mutex<…>>` is fine.
    let by_action: Arc<Mutex<HashMap<String, ActiveBinding>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let by_id: Arc<Mutex<HashMap<u32, String>>> = Arc::new(Mutex::new(HashMap::new()));

    // Tell the caller we're ready *before* spawning the dispatch helper, so a failure to
    // spawn it does not block `HotkeyRegistry::new` indefinitely.
    if init_tx.send(Ok(())).is_err() {
        // Registry was dropped between `new()` and us reporting back — nothing to do.
        return;
    }

    spawn_dispatch_thread(app_handle, Arc::clone(&by_id));

    while let Ok(cmd) = cmd_rx.recv() {
        match cmd {
            Command::Register {
                binding,
                hotkey,
                respond,
            } => {
                let result = handle_register(&manager, &by_action, &by_id, binding, hotkey);
                let _ = respond.send(result);
            }
            Command::Unregister { action, respond } => {
                let result = handle_unregister(&manager, &by_action, &by_id, &action);
                let _ = respond.send(result);
            }
            Command::List { respond } => {
                let map = by_action.lock();
                let snapshot = map
                    .iter()
                    .map(|(action, binding)| HotkeyBinding {
                        action: action.clone(),
                        accelerator: binding.accelerator.clone(),
                    })
                    .collect();
                let _ = respond.send(snapshot);
            }
        }
    }

    debug!(
        target: "vibe_term::hotkeys",
        "manager thread: command channel closed; exiting"
    );
}

fn handle_register(
    manager: &GlobalHotKeyManager,
    by_action: &Mutex<HashMap<String, ActiveBinding>>,
    by_id: &Mutex<HashMap<u32, String>>,
    binding: HotkeyBinding,
    hotkey: HotKey,
) -> Result<(), AppError> {
    {
        let actions = by_action.lock();
        if let Some(existing) = actions.get(&binding.action) {
            if existing.hotkey.id() == hotkey.id() {
                debug!(
                    target: "vibe_term::hotkeys",
                    action = %binding.action,
                    accelerator = %binding.accelerator,
                    "register: no-op (idempotent)"
                );
                return Ok(());
            }
        }
    }

    // Different chord for the same action ⇒ free the old slot first so we never leave
    // stale OS entries lying around.
    let previous: Option<HotKey> = {
        let actions = by_action.lock();
        actions.get(&binding.action).map(|b| b.hotkey)
    };
    if let Some(prev) = previous {
        if let Err(err) = manager.unregister(prev) {
            warn!(
                target: "vibe_term::hotkeys",
                action = %binding.action,
                "register: failed to unregister previous chord ({err}); continuing"
            );
        }
        by_id.lock().remove(&prev.id());
        by_action.lock().remove(&binding.action);
    }

    // Refuse to clobber another action that already owns the same chord — the dispatch
    // thread maps by id, so two actions cannot share one slot.
    if let Some(conflicting_action) = by_id.lock().get(&hotkey.id()).cloned() {
        return Err(AppError::other(format!(
            "hotkey {} already bound to action {}",
            binding.accelerator, conflicting_action
        )));
    }

    manager.register(hotkey).map_err(|err| {
        AppError::other(format!(
            "OS rejected hotkey {}: {err}",
            binding.accelerator
        ))
    })?;

    by_id.lock().insert(hotkey.id(), binding.action.clone());
    by_action.lock().insert(
        binding.action.clone(),
        ActiveBinding {
            hotkey,
            accelerator: binding.accelerator.clone(),
        },
    );
    debug!(
        target: "vibe_term::hotkeys",
        action = %binding.action,
        accelerator = %binding.accelerator,
        "register: ok"
    );
    Ok(())
}

fn handle_unregister(
    manager: &GlobalHotKeyManager,
    by_action: &Mutex<HashMap<String, ActiveBinding>>,
    by_id: &Mutex<HashMap<u32, String>>,
    action: &str,
) -> Result<(), AppError> {
    let removed = by_action.lock().remove(action);
    let Some(binding) = removed else {
        debug!(
            target: "vibe_term::hotkeys",
            action = %action,
            "unregister: no-op (unknown action)"
        );
        return Ok(());
    };
    by_id.lock().remove(&binding.hotkey.id());
    if let Err(err) = manager.unregister(binding.hotkey) {
        // Bookkeeping is already gone; surface the OS error but do not roll back — the
        // caller's intent was to remove the chord.
        return Err(AppError::other(format!(
            "OS failed to unregister hotkey for {action}: {err}"
        )));
    }
    debug!(target: "vibe_term::hotkeys", action = %action, "unregister: ok");
    Ok(())
}

/// Spawn the OS dispatch thread. It blocks on [`GlobalHotKeyEvent::receiver`], looks up
/// the action mapped to each fired hotkey id, and emits a Tauri event.
///
/// The thread terminates only if the upstream channel closes (the receiver is a static
/// crossbeam channel that never disconnects in practice). We do not own a shutdown handle
/// because global hotkeys are themselves process-global resources.
fn spawn_dispatch_thread<R: Runtime>(
    app_handle: AppHandle<R>,
    by_id: Arc<Mutex<HashMap<u32, String>>>,
) {
    thread::Builder::new()
        .name("vibe-term-hotkey-dispatch".into())
        .spawn(move || {
            let recv = GlobalHotKeyEvent::receiver();
            // Blocking `recv()` parks the thread — zero CPU cost while idle. The loop
            // exits only when the channel closes (`Err`).
            while let Ok(event) = recv.recv() {
                if event.state != HotKeyState::Pressed {
                    continue;
                }
                let action_opt = by_id.lock().get(&event.id).cloned();
                let Some(action) = action_opt else {
                    // Hotkey fired but no action mapped — could be a chord we just
                    // swapped, or a binding owned by another consumer of the same
                    // global-hotkey crate. Not an error.
                    debug!(
                        target: "vibe_term::hotkeys",
                        id = event.id,
                        "dispatch: no action mapped for fired hotkey id"
                    );
                    continue;
                };
                if let Err(err) = app_handle.emit(
                    HOTKEY_TRIGGERED,
                    HotkeyTriggeredEvent { action: &action },
                ) {
                    warn!(
                        target: "vibe_term::hotkeys",
                        action = %action,
                        "dispatch: failed to emit hotkey://triggered: {err}"
                    );
                }
            }
            warn!(
                target: "vibe_term::hotkeys",
                "dispatch: global hotkey channel closed; thread exiting"
            );
        })
        .expect("hotkeys: failed to spawn dispatch thread");
}

/// Parse an accelerator string into a [`HotKey`]. Public so tests can exercise the parser
/// without standing up an OS registry (the parser is pure and works on CI without a
/// display server, unlike [`GlobalHotKeyManager::new`]).
///
/// On top of the upstream grammar this normalises **`Meta`** to **`Super`** so callers can
/// use the modifier name Tauri menus and the rest of the Tauri ecosystem use.
pub fn parse_accelerator(input: &str) -> Result<HotKey, AppError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput(
            "hotkey accelerator is empty".into(),
        ));
    }
    if trimmed.ends_with('+') || trimmed.starts_with('+') {
        return Err(AppError::InvalidInput(format!(
            "invalid accelerator '{input}': dangling '+'"
        )));
    }
    // The upstream parser does not recognise `Meta` — rewrite it to `Super` token-wise so
    // every other normalisation (case-insensitivity, `CmdOrCtrl`, …) keeps working.
    let normalised = trimmed
        .split('+')
        .map(|tok| {
            let t = tok.trim();
            if t.eq_ignore_ascii_case("meta") {
                "Super"
            } else {
                t
            }
        })
        .collect::<Vec<_>>()
        .join("+");

    normalised
        .parse::<HotKey>()
        .map_err(|err| AppError::InvalidInput(format!("invalid accelerator '{input}': {err}")))
}

// ---------------------------------------------------------------------------
// Unit tests — pure, no OS interaction. Integration tests that *do* poke the
// OS live in `tests/rust/hotkeys_smoke.rs`.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_accepts_common_accelerators() {
        for ok in ["Ctrl+Shift+T", "Meta+Space", "Alt+F4", "CmdOrCtrl+K", "F12"] {
            assert!(
                parse_accelerator(ok).is_ok(),
                "expected '{ok}' to parse"
            );
        }
    }

    #[test]
    fn parser_rejects_garbage() {
        for bad in ["", "   ", "Hello", "Ctrl+", "+A", "Ctrl++A"] {
            assert!(
                parse_accelerator(bad).is_err(),
                "expected '{bad}' to be rejected"
            );
        }
    }

    #[test]
    fn meta_alias_normalises_to_super() {
        // Equivalent to using `Super` directly (which the upstream parser accepts).
        let with_meta = parse_accelerator("Meta+Space").unwrap();
        let with_super = parse_accelerator("Super+Space").unwrap();
        assert_eq!(with_meta.id(), with_super.id());
    }
}
