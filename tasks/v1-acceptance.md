# v1.0.0 acceptance checklist

Concrete, testable checks that must all pass before tagging `v1.0.0`.

Run through this on each supported OS (Ubuntu 24.04 Wayland + X11, macOS 14 ARM, macOS 13 x86_64, Windows 11). Tick each box when verified end-to-end on the OS in question.

Legend: ☐ pending · ✅ passed · ❌ failed (link to issue) · ⏳ in progress

## A. Build & CI

- ☐ CI `build` workflow green on `ubuntu-24.04`, `macos-14`, `macos-13`, `windows-2022` — 7 consecutive runs
- ☐ CI `test` workflow green (rust + frontend lanes) — 7 consecutive runs
- ☐ `release.yml` produces all bundles on tag push:
  - ☐ `vibe-term_X.Y.Z_amd64.AppImage`
  - ☐ `vibe-term_X.Y.Z_amd64.deb`
  - ☐ `vibe-term_X.Y.Z_aarch64.dmg`
  - ☐ `vibe-term_X.Y.Z_x64.dmg`
  - ☐ `vibe-term_X.Y.Z_x64-setup.exe`
  - ☐ `vibe-term_X.Y.Z_x64_en-US.msi`
- ☐ `cargo clippy --all-targets --all-features -- -D warnings` exit 0
- ☐ `pnpm typecheck` exit 0
- ☐ `pnpm lint --max-warnings=0` exit 0
- ☐ `pnpm test` (vitest) exit 0
- ☐ `cargo test --all-features` exit 0 (skip Wayland-only tests on CI runners without display)

## B. Install on fresh VM

For each OS, on a clean VM with no prior install, follow `docs/BUILD.md`:

| OS | Install < 1 min | App opens | Heading renders |
|---|:---:|:---:|:---:|
| Ubuntu 24.04 | ☐ | ☐ | ☐ |
| macOS 14 ARM | ☐ | ☐ | ☐ |
| Windows 11 | ☐ | ☐ | ☐ |

## C. Terminal core (10 critical features)

On each OS, exercise these end-to-end without restarting the app:

1. ☐ Default shell auto-detected; shell picker dropdown lists all installed shells
2. ☐ `ls -la` shows ANSI colours correctly
3. ☐ `vim`, edit a file, `:wq`, file is saved on disk
4. ☐ `htop` renders at 60 fps, refreshes fluidly, `q` exits cleanly
5. ☐ `Ctrl+T` opens a new tab spawning a fresh PTY (isolated env)
6. ☐ `Ctrl+Shift+D` / `Ctrl+Shift+E` split horizontal / vertical
7. ☐ Close tab kills the PTY (verified with `pgrep` / `tasklist`)
8. ☐ Paste image from clipboard → inline thumbnail with `img_xxxxxx` badge in < 500 ms
9. ☐ Drag-drop PNG file from file manager → same thumbnail
10. ☐ Screenshot region hotkey → selection rectangle → capture inserted inline

## D. AI panel & multimodal

- ☐ First run: `ApiKeyPrompt` modal asks for Claude key
- ☐ Key saved in OS keyring (verify it is *not* in `~/.config/vibe-term/`)
- ☐ Open sidebar (`Ctrl+I`); ask "summarize last output" → streaming Markdown response
- ☐ Type `img_xxxxxx` in prompt → request includes base64 image block; Claude correctly describes the image
- ☐ Model picker switches between Opus 4.7 / Sonnet 4.6 / Haiku 4.5
- ☐ Cancel button stops streaming mid-response
- ☐ Token usage shown after `message_complete`

## E. Persistence & search

- ☐ Each command appended to SQLite (`history.db` in app data dir)
- ☐ Restart app → previous tabs / blocks / AI conversations restored
- ☐ `Ctrl+R` opens search palette; query "git push" returns hits in < 100 ms on 10 k entries
- ☐ Export session as Markdown / HTML — both renderable in a browser

## F. Configuration & themes

- ☐ Edit `~/.config/vibe-term/config.toml` while app is open → theme switches live (no restart)
- ☐ All 5 themes (`dark`, `light`, `dracula`, `nord`, `tokyo-night`) apply correctly to both UI chrome and terminal ANSI palette
- ☐ Hotkeys rebind from Settings panel; new bindings persist across restart
- ☐ Conflicting hotkeys (e.g. `Ctrl+Alt+T` reserved on GNOME) detected and surfaced with a toast warning

## G. Performance budget

- ☐ Cold start < 2 s on each OS (i9-class hardware)
- ☐ Idle RSS < 300 MB after 5 min running with 2 tabs
- ☐ No memory leak after 1 h of `yes` + intermittent input (RSS stable within ±20 %)
- ☐ 60 fps sustained when scrolling `cat bigfile` (1 MB+)
- ☐ Frontend bundle < 3 MB gzipped
- ☐ Installer < 12 MB per platform

## H. Cross-platform gotchas (regression guard)

- ☐ **Wayland** clipboard image paste works (or falls back to `wl-paste` cleanly with a toast hint)
- ☐ **macOS** Screen Recording permission requested on first screenshot; works after grant
- ☐ **Windows** ConPTY survives rapid resize (drag window edge for 10 s — no corruption)
- ☐ **Linux** AppImage launches on Ubuntu 24.04 (DMA-BUF workaround documented if needed)
- ☐ **macOS** Gatekeeper bypass instructions in TROUBLESHOOTING.md confirmed working

## I. Documentation & release artefacts

- ☐ README install steps tested verbatim on each OS
- ☐ `docs/BUILD.md`, `docs/CONFIG.md`, `docs/HOTKEYS.md`, `docs/TROUBLESHOOTING.md` all up to date
- ☐ `CHANGELOG.md` v1.0.0 section written
- ☐ GitHub release notes include sha256sums for each artefact
- ☐ `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` present
- ☐ Demo GIF in README shows the kill feature (screenshot → paste → ask Claude)

## J. Process hygiene

- ☐ No orphan PTY processes after `Quit` (verified `pgrep -f bash` empty)
- ☐ All temp files cleaned up on quit (`/tmp/vibe-term-*` empty)
- ☐ `sentry`/telemetry disabled by default; opt-in switch documented (if added)

---

**Tagging policy:** if a single checkbox in sections A-H is unchecked, ship as `v1.0.0-rcN` instead of `v1.0.0`. Sections I-J can ship with known gaps documented in the release notes.
