# vibe-term

A modern cross-platform terminal with native image support and an integrated AI assistant — built for the vibe-coding era.

> **Status:** early bootstrap. Phase 0 (project scaffolding & CI) in progress.

## Why

Existing terminals treat images as second-class citizens. With AI agents that can now *see* what you screenshot, the workflow `take a screenshot → paste in terminal → ask Claude to look at it` should be one keypress, not a 5-step shuffle. `vibe-term` is that terminal.

## Features (target v1)

- **Cross-platform**: Linux (Ubuntu/Xubuntu), macOS, Windows — one codebase, native binaries on each.
- **Multi-shell**: bash, zsh, fish, PowerShell 7, CMD, WSL — auto-detected with a shell picker.
- **Images as first-class citizens**:
  - Paste from clipboard (Ctrl/Cmd+V) — image rendered inline with short ID `img_xxxx`.
  - Drag & drop PNG/JPG/WebP files.
  - Region screenshot via global hotkey (default `Ctrl+Alt+S`).
  - Lazy OCR (`Extract text` from any pasted image).
- **Native AI panel (Claude)** — bring your own API key (stored in the OS keyring):
  - Streaming responses, Markdown + code highlight.
  - Multimodal: reference any `img_xxxx` in your prompt and Claude sees it.
  - Context auto-injection of the last N terminal blocks.
- **Persistent sessions**: SQLite + FTS5 full-text history search, export to Markdown / HTML.
- **Tabs, splits, themes, hotkeys, hot-reloadable TOML config.**

## Tech stack

| Layer | Choice |
|---|---|
| App framework | Tauri 2 (Rust core + system WebView) |
| Frontend | React 19 + TypeScript + Vite + Tailwind CSS |
| Terminal core | xterm.js 5 + Sixel/iTerm image addon + WebGL renderer |
| PTY backend | `portable-pty` (Rust, unified across Win/Mac/Linux) |
| Persistence | SQLite (`rusqlite`) + FTS5 |
| Screenshots | `xcap` (Wayland + X11 + macOS + Windows) |
| AI | Anthropic Claude API (BYOK) — Opus 4.7 vision / Sonnet 4.6 |

## Install (TBD when first release ships)

Releases will be published at [https://github.com/mobel8/vibe-term/releases](https://github.com/mobel8/vibe-term/releases).

| OS | Format |
|---|---|
| Linux | `.AppImage`, `.deb` |
| macOS | `.dmg` (arm64 + x86_64) |
| Windows | `.msi`, `_setup.exe` (NSIS) |

## Build from source

### Prerequisites

| Tool | Notes |
|---|---|
| Rust ≥ 1.77 | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Node ≥ 20 | https://nodejs.org |
| pnpm ≥ 11 | `npm install -g pnpm` |
| **Linux only** | `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev pkg-config build-essential` |

### Run in dev mode

```bash
pnpm install
pnpm tauri:dev
```

### Build for release

```bash
pnpm tauri:build
```

Output bundles will be in `src-tauri/target/release/bundle/`.

## Project layout

```
src-tauri/   Rust backend (PTY, images, storage, AI client, OCR, config)
src/         React frontend (terminal UI, AI sidebar, settings)
docs/        Architecture & protocol notes
scripts/     OS-specific setup helpers
tests/       Rust integration + Playwright/WebdriverIO E2E
.github/     CI workflows for build, test, release
```

See `docs/ARCHITECTURE.md` for the full module map and IPC surface.

## Contributing

This is a personal project at an early stage; PRs and issues are welcome once the v1 surface stabilises (see `tasks/v1-acceptance.md`).

Conventional Commits style (`feat:`, `fix:`, `chore:`…) with a `Co-Authored-By: Claude` trailer when AI-assisted.

## License

MIT — see [LICENSE](./LICENSE).
