# Changelog

All notable changes to `vibe-term` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Cross-platform documentation set under `docs/`:
  [ARCHITECTURE.md](./docs/ARCHITECTURE.md),
  [BUILD.md](./docs/BUILD.md),
  [CONFIG.md](./docs/CONFIG.md),
  [HOTKEYS.md](./docs/HOTKEYS.md),
  [PROTOCOLS.md](./docs/PROTOCOLS.md),
  [TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md).
- `CONTRIBUTING.md` with the Conventional Commits flow and the test runbook.
- **OS-level hotkey registry** (`src-tauri/src/hotkeys/`) wrapping the
  `global-hotkey` crate behind a dedicated manager thread. Replays the
  bindings stored in `config.hotkeys` at boot; exposes
  `hotkey_register / hotkey_unregister / hotkey_replace_all / hotkey_list`
  commands and emits `hotkey://triggered` on every press.
- **Session exporter** (`src-tauri/src/export/`) renders an entire session
  (blocks + attached images + AI history) to either Markdown or a
  self-contained HTML document. Images embed as `data:` URIs by default;
  exposed via `export_session` and `export_session_to_file`.
- **Search dialog** (Ctrl+R) backed by the existing FTS5 index, with
  debounced queries and server-side snippet highlighting.
- **Terminal bell** is now config-driven: ~80 ms Web Audio sine pulse +
  a 150 ms body-level visual flash, gated on `settings.terminal.bell`.
- **Advanced settings → Data paths** surfaces the live config / DB /
  images / OCR-models directories via the new `data_paths` IPC.
- **AI conversation history** is rehydrated from the SQLite store the
  first time the sidebar binds to a real session id, with tokens and
  per-message metadata preserved.
- Typed wrappers in `src/ipc/invoke.ts` for the ~18 backend commands
  that were registered but unreachable from the frontend
  (`session_rename`, `default_shell`, `image_from_path/bytes`,
  `db_image_*`, `ai_delete_api_key`, `ai_api_key_preview`,
  `ai_conversation_*`, `ai_exchange_*`, `search_images_fts`,
  `data_paths`, and the new `hotkeys.*` / `exportSession.*` surfaces).

### Fixed
- `tracing-subscriber` default features collided with `tauri-plugin-log`
  on a global `log::set_logger` call; scoped the features so both
  subsystems initialise cleanly.
- `r2d2` pool race on the first `PRAGMA journal_mode=WAL` was emitting a
  transient `[ERROR] database is locked` at every boot; `min_idle(Some(1))`
  now sequentialises the WAL switch.
- Frontend `invoke()` strings drifted from the registered backend command
  names (`pty_list_shells`, `image_paste_from_clipboard`,
  `image_capture_screen`, `image_get_base64`, `ai_has_key`); aligned the
  five callsites + their test mocks.

### Tests
- `cargo test --all-features` now runs the new `hotkeys_smoke` and
  `export_smoke` integration suites alongside the existing
  `lib_smoke / pty_smoke / store_smoke / config_smoke / images_smoke /
  ai_smoke / cross_module_integration` matrix.
- `vitest` `testTimeout` bumped to 15 s so the xterm.js-heavy
  TerminalView specs stop flaking under parallel CPU load.

## [0.1.0] - TBD

First bootstrap release. No public binaries yet; this milestone tracks the
end of the "Phase 0 + 1" engineering sweep (project scaffolding, CI matrix,
typed IPC surface, PTY backend, persistent store, image manager, Anthropic
client skeleton, config loader, OCR engine wiring).

### Added

- Tauri 2 + React 19 + Vite 6 + TypeScript 5.7 project skeleton (Phase 0).
- pnpm 11 workspace with strict ESLint (`--max-warnings=0`), Prettier,
  Vitest, and `tsc --noEmit` baseline.
- GitHub Actions CI matrix (`build.yml`, `test.yml`, `release.yml`) targeting
  `ubuntu-24.04`, `macos-14`, `macos-13`, `windows-2022`.
- Cross-platform PTY backend (`portable-pty`) with reader threads,
  graceful kill, and `pty://data` / `pty://exit` events.
- Shell detection for Unix (`/etc/shells` + `$SHELL`) and Windows
  (`pwsh`/`powershell`/`cmd` + WSL distros via `wsl.exe -l -q`).
- SQLite persistence (`rusqlite` + FTS5) with `r2d2` connection pool,
  versioned migrations, sessions / blocks / search modules.
- Image manager: clipboard intake (`arboard` + Wayland `wl-paste` fallback),
  screenshot via `xcap`, sha256 dedup, LRU cache, lossless PNG canonicalisation,
  `image://added` events.
- Lazy OCR (`ocrs` + `rten`) with model download script
  (`scripts/fetch-ocr-models.sh`).
- Anthropic Claude streaming client (SSE via `eventsource-stream`) with
  per-conversation cancellation, exponential retry on 5xx, and
  `ai://delta` / `ai://message_complete` / `ai://error` events.
- API key keystore: OS keychain via `keyring` (Keychain / Credential Manager
  / libsecret) with `age`-encrypted file fallback for headless / WSL.
- Config subsystem: TOML schema with `serde(default)` everywhere, RFC-7396
  JSON merge patches via `config_update`, hot-reload via `notify` watcher,
  `config://changed` broadcast.
- Typed IPC surface: every Rust DTO carries `#[ts(export)]` for `ts-rs`
  codegen; hand-written mirrors in `src/ipc/types.ts` until the first
  backend build seeds `src/ipc/bindings/`.
- xterm.js 5 + addons (`@xterm/addon-image`, `webgl`, `fit`, `search`,
  `web-links`, `unicode11`) dependencies pinned.
- Bundled default `config.toml` written on first launch.

### Changed

- CI: bumped Node to 22 and build frontend before clippy so
  `tauri::generate_context!` finds the dist output (commit `bba07a6`).
- CI: aligned `cargo fmt --check` output and pnpm action version
  (commit `8fcf790`).

### Security

- `Content-Security-Policy` in `tauri.conf.json` restricts `connect-src` to
  `https://api.anthropic.com` and the local Tauri IPC origin.
- Drag-drop interception: `fileDropEnabled: false` to prevent WebKit /
  WebView2 hijacking file paths.
- API keys are stored via the OS keychain, never written to disk in
  plaintext, never logged (redacted via `keystore::redact_key`).

[Unreleased]: https://github.com/mobel8/vibe-term/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mobel8/vibe-term/releases/tag/v0.1.0
