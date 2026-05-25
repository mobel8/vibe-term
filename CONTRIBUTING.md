# Contributing

Thanks for your interest in `vibe-term`. This document covers the
day-to-day workflow: how to set up a build, what the commit / PR
conventions are, and which checks must pass before review.

If you only want an architectural overview, read
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) first.

---

## 1. Code of conduct

Be excellent to each other. We follow the spirit of the
[Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/);
no formal violation procedure is in place yet (small project), but
maintainers reserve the right to close issues / PRs that are abusive or
off-topic.

---

## 2. Getting set up

1. Install the prerequisites for your OS — see
   [docs/BUILD.md](./docs/BUILD.md).
2. Fork `mobel8/vibe-term`, clone your fork, add the upstream remote:
   ```bash
   git clone git@github.com:<your-handle>/vibe-term.git
   cd vibe-term
   git remote add upstream https://github.com/mobel8/vibe-term.git
   ```
3. Install JS deps and verify the dev build:
   ```bash
   pnpm install
   pnpm tauri:dev
   ```

If `pnpm tauri:dev` opens an empty terminal-themed window, you're good.

---

## 3. Branch & commit conventions

### Branching

Trunk-based. `main` must always be green (CI matrix passing on all four
OS targets). Open feature branches off `main`, keep them short (<3 days),
rebase on `main` before opening a PR.

| Prefix | Meaning |
|---|---|
| `feat/<scope>` | a new feature or capability |
| `fix/<scope>` | a bug fix |
| `chore/<scope>` | tooling / dependency / build housekeeping |
| `refactor/<scope>` | no behaviour change, internal cleanup |
| `docs/<scope>` | documentation only |
| `test/<scope>` | tests only |
| `ci/<scope>` | CI configuration |

Example: `feat/pty-resize-debounce`, `fix/wayland-clipboard-fallback`.

### Commits — Conventional Commits

```
<type>(<scope>): <imperative subject line, ≤72 chars>

<wrap body at 72 chars>
<explain why, not what>

Co-Authored-By: Claude <noreply@anthropic.com>   # when AI-assisted
```

Allowed `type` values match the branch prefixes above plus `perf`, `style`,
`build`, `revert`. `scope` is optional but encouraged — typically the
module name (e.g. `pty`, `ai`, `images`, `config`).

Example:

```
feat(pty): debounce resize on Windows to avoid ConPTY corruption

Bursts of resize events from a fast monitor drag could leave the pseudo
console in a half-updated state. Adds a 100 ms debounce on the frontend
side and documents the knob under [terminal] resize_debounce_ms.

Refs: docs/TROUBLESHOOTING.md §7

Co-Authored-By: Claude <noreply@anthropic.com>
```

`Co-Authored-By: Claude` is required when an AI agent wrote any of the
diff (per CLAUDE.md global rules).

---

## 4. Local checks before pushing

Run the same gates CI does:

```bash
# Frontend
pnpm typecheck
pnpm lint
pnpm test

# Backend
cd src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
```

`pnpm lint` runs with `--max-warnings=0`; `cargo clippy` with
`-D warnings`. A single warning fails CI — fix it locally rather than
hoping a reviewer will overlook it.

If you only changed Rust or only changed TS, you can scope:

```bash
cargo clippy -p vibe-term -- -D warnings
pnpm test -- src/components/terminal
```

---

## 5. Pull-request workflow

1. Push your branch to your fork.
2. Open a PR against `mobel8/vibe-term:main`.
3. CI runs four matrix jobs (Linux x86_64, macOS aarch64, macOS x86_64,
   Windows x86_64) plus `test.yml` (Rust + frontend). All must be green.
4. At least one maintainer approval is required (currently solo
   maintainership during the v0.x bootstrap — self-merge after CI green is
   acceptable for small docs / chore PRs only).
5. Squash-and-merge is the default. Edit the squash subject so it follows
   the Conventional Commits format (the PR title usually is the right
   subject already).

PRs that touch the IPC surface (`commands.rs`, `events.rs`, any DTO with
`#[ts(export)]`) need both Rust and TypeScript updated — the type
generation script lives in the Rust build and runs implicitly during
`cargo build`.

---

## 6. Module structure recap

| Path | Purpose |
|---|---|
| `src-tauri/src/lib.rs` | Tauri builder, plugin list, command handler list |
| `src-tauri/src/commands.rs` | Every `#[tauri::command]` |
| `src-tauri/src/state.rs` | `AppState` with `Arc` managers |
| `src-tauri/src/error.rs` | `AppError` + `Serialize` impl |
| `src-tauri/src/events.rs` | Event-name constants |
| `src-tauri/src/pty/` | PTY manager, sessions, shell detection |
| `src-tauri/src/store/` | SQLite pool + migrations + FTS5 search |
| `src-tauri/src/images/` | Clipboard / screenshot / drop ingestion |
| `src-tauri/src/ai/` | Anthropic streaming client + keystore |
| `src-tauri/src/ocr/` | `ocrs` engine wrapper |
| `src-tauri/src/config/` | TOML schema, paths, watcher |
| `src-tauri/src/hotkeys/` | Global hotkeys (`global-hotkey` crate) |
| `src-tauri/src/export/` | Markdown / HTML serialisation |
| `src/main.tsx` / `App.tsx` | React entry + root layout |
| `src/components/terminal/` | xterm.js view + image overlay + block boundaries |
| `src/components/layout/` | Tabs, splits, status bar |
| `src/components/ai/` | Sidebar, chat messages, image chips, key prompt |
| `src/components/palette/` | `cmdk` command palette |
| `src/components/settings/` | Settings modal + theme / hotkeys editors |
| `src/ipc/` | Typed wrappers around `invoke` + `listen` |
| `src/state/` | Zustand stores |

Full descriptions in [docs/ARCHITECTURE.md §3–4](./docs/ARCHITECTURE.md#3-rust-module-map-src-tauri-src).

---

## 7. Issue triage labels

| Label | Meaning |
|---|---|
| `bug` | confirmed regression |
| `enhancement` | new capability |
| `good first issue` | self-contained, well-scoped, no deep context needed |
| `help wanted` | maintainer would welcome a PR |
| `platform: linux` / `platform: macos` / `platform: windows` | OS-specific |
| `area: pty` / `area: ai` / `area: images` / `area: config` / `area: ci` | module routing |
| `blocked: upstream` | waiting on Tauri / xterm.js / ocrs / etc. |

---

## 8. Releases

Maintainers cut releases by tagging `vX.Y.Z` on `main`:

```bash
git tag -s vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

This triggers `.github/workflows/release.yml`, which:

1. Creates a draft GitHub Release with auto-generated notes.
2. Runs the build matrix and uploads `AppImage`, `deb`, `rpm`, `dmg`
   (arm64 + x64), `msi`, `nsis` bundles.
3. Publishes the draft once every artefact is attached.

Before tagging, the human releaser must:

- Update `CHANGELOG.md`: move `[Unreleased]` entries under the new
  version with today's date.
- Bump `version` in `package.json`, `src-tauri/Cargo.toml`, and
  `src-tauri/tauri.conf.json` (script TBD).
- Update the `[Unreleased]`/`[X.Y.Z]` link references at the bottom of
  `CHANGELOG.md`.

---

## 9. License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE).
