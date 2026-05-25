# vibe-term

[![build](https://github.com/mobel8/vibe-term/actions/workflows/build.yml/badge.svg)](https://github.com/mobel8/vibe-term/actions/workflows/build.yml)
[![test](https://github.com/mobel8/vibe-term/actions/workflows/test.yml/badge.svg)](https://github.com/mobel8/vibe-term/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A modern cross-platform terminal with **native image support** and an **integrated AI assistant** — built for the vibe-coding era.

> **Status:** active development. See [CHANGELOG.md](./CHANGELOG.md) for the current state.

## Why

Existing terminals treat images as second-class citizens. With AI agents that can now *see* what you screenshot, the workflow `take a screenshot → paste in terminal → ask Claude to look at it` should be one keypress, not a 5-step shuffle. `vibe-term` is that terminal.

## Comparison

| Capability | vibe-term | Warp | Ghostty | WezTerm | Windows Terminal |
|---|:---:|:---:|:---:|:---:|:---:|
| Cross-platform (Lin/Mac/Win) | ✓ | partial | ✓ (Win planned) | ✓ | Win-only |
| Native image paste (clipboard) | ✓ | ✗ | ✗ | partial | ✓ |
| Built-in screenshot tool | ✓ | ✗ | ✗ | ✗ | ✗ |
| Image drag & drop | ✓ | ✗ | ✗ | partial | ✗ |
| Inline AI panel (BYOK) | ✓ | ✓ (proprietary) | ✗ | ✗ | ✗ |
| Multimodal AI (image + text) | ✓ | partial | ✗ | ✗ | ✗ |
| Open-source full-stack | ✓ (MIT) | partial (AGPL/MIT) | ✓ | ✓ | ✓ |
| Sixel + iTerm OSC 1337 | ✓ | ✓ | ✓ | ✓ | ✓ (1.22+) |

See [docs/PROTOCOLS.md](./docs/PROTOCOLS.md) for the full matrix.

## Features (target v1)

- **Cross-platform**: Linux (Ubuntu/Xubuntu), macOS, Windows — one codebase, native binaries on each.
- **Multi-shell**: bash, zsh, fish, PowerShell 7, CMD, WSL — auto-detected with a shell picker.
- **Images as first-class citizens**:
  - Paste from clipboard (Ctrl/Cmd+V) — image rendered inline with short ID `img_xxxx`.
  - Drag & drop PNG/JPG/WebP files.
  - Region screenshot via global hotkey (default `Ctrl+Alt+S`).
  - Lazy OCR (`Extract text` from any pasted image).
- **Native AI panel (Claude)** — Bring Your Own Key, stored in the OS keyring (Keychain / Credential Manager / libsecret); never transmitted anywhere except `api.anthropic.com`:
  - Streaming responses, Markdown + code highlight.
  - Multimodal: reference any `img_xxxx` in your prompt and Claude sees it.
  - Context auto-injection of the last N terminal blocks.
- **Persistent sessions**: SQLite + FTS5 full-text history search, export to Markdown / HTML.
- **Tabs, splits, themes, hotkeys, hot-reloadable TOML config.**

## Quick install

> First-binary releases not yet published — see [Build from source](#build-from-source) below in the meantime.

```bash
# Linux (Ubuntu 22.04 / 24.04 / Debian 12+)
curl -L https://github.com/mobel8/vibe-term/releases/latest/download/vibe-term_amd64.deb -o vibe-term.deb
sudo apt install ./vibe-term.deb

# macOS (Apple Silicon)
curl -L https://github.com/mobel8/vibe-term/releases/latest/download/vibe-term_aarch64.dmg -o vibe-term.dmg
hdiutil attach vibe-term.dmg && cp -R "/Volumes/vibe-term/vibe-term.app" /Applications/

# Windows
# Download the .msi or _setup.exe from the latest release and run it.
```

Full distribution table:

| OS | Format |
|---|---|
| Linux | `.AppImage`, `.deb` |
| macOS | `.dmg` (arm64 + x86_64) |
| Windows | `.msi`, `_setup.exe` (NSIS) |

Note: until code-signing is in place you may need to right-click → Open on macOS (Gatekeeper) and click "More info → Run anyway" on Windows (SmartScreen). See [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md).

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

## Build from source

### Prerequisites

| Tool | Notes |
|---|---|
| Rust ≥ 1.77 | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Node ≥ 22.13 | https://nodejs.org |
| pnpm ≥ 11 | `npm install -g pnpm` |
| **Linux only** | `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev pkg-config build-essential` (one-liner in `scripts/setup-linux.sh`) |

Detailed per-OS instructions in [docs/BUILD.md](./docs/BUILD.md).

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

## Documentation

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — module map (Rust + React), IPC surface, SQL schema, security model.
- [docs/BUILD.md](./docs/BUILD.md) — per-OS prerequisites and build steps.
- [docs/CONFIG.md](./docs/CONFIG.md) — full `config.toml` reference.
- [docs/HOTKEYS.md](./docs/HOTKEYS.md) — default keymap and how to rebind.
- [docs/PROTOCOLS.md](./docs/PROTOCOLS.md) — image protocol support matrix.
- [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) — Gatekeeper, SmartScreen, Wayland clipboard, WebKitGTK DMA-BUF, etc.

## Project layout

```
src-tauri/   Rust backend (PTY, images, storage, AI client, OCR, config)
src/         React frontend (terminal UI, AI sidebar, settings)
docs/        Architecture, build, config, protocols, troubleshooting
scripts/     OS-specific setup helpers
tests/       Rust integration + WebdriverIO E2E
.github/     CI workflows for build, test, release, e2e
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) — Conventional Commits, branch model, local test runbook.

PRs and issues are welcome once the v1 surface stabilises.

## License

MIT — see [LICENSE](./LICENSE).
