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
