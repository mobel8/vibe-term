# Architecture

This document describes the technical architecture of `vibe-term` — the module
layout, IPC surface, persistence schema, and cross-platform strategy.

Sister documents you may also want to read:

- [BUILD.md](./BUILD.md) — how to build from source on each OS.
- [CONFIG.md](./CONFIG.md) — every TOML knob and its effect.
- [PROTOCOLS.md](./PROTOCOLS.md) — image protocol coverage matrix.
- [HOTKEYS.md](./HOTKEYS.md) — default shortcuts and customisation.
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — common runtime issues.

---

## 1. Mission

`vibe-term` is an **AI-first, multimodal terminal**. Two design pillars set
it apart from incumbents:

1. **Images are first-class citizens.** Paste from the clipboard, drag-drop
   PNG/JPG/WebP, region screenshot via global hotkey, lazy OCR — every image
   gets a short `img_xxxxxx` identifier and renders inline.
2. **Native Claude assistant.** A side panel streams responses from Claude
   (Opus 4.7 vision / Sonnet 4.6 / Haiku 4.5). Any `img_xxxx` referenced in a
   prompt is sent as a multimodal `image` content block — no manual paste, no
   browser detour.

Everything else — cross-platform shells, tabs, splits, themes, FTS5 history —
is mandatory plumbing in service of those two pillars.

---

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| App framework | **Tauri 2.x** with `macos-private-api` | 3-5 MB binary vs 80+ MB Electron, 45 MB RAM idle, system WebView, mature in 2026 |
| Frontend | **React 19 + TypeScript + Vite + Tailwind** | mainstream stack, strict types, HMR sub-second |
| Terminal core | **xterm.js 5.x** + `@xterm/addon-image`, `webgl`, `fit`, `search`, `web-links`, `unicode11` | the only mature JS terminal stack with an official image addon |
| PTY backend | **`portable-pty`** (the WezTerm crate) | one API for ConPTY (Windows) and forkpty (Unix), no Node bindings to compile |
| Storage | **`rusqlite` + FTS5** (`bundled-full`, `blob`) | zero-conf, full-text search natively, no external service |
| Clipboard | **`arboard` 3.4+** with `wl-paste` fallback | only crate with working Wayland image support in 2026 |
| Screenshots | **`xcap`** | unified X11 + Wayland + macOS + Windows capture |
| OCR (lazy) | **`ocrs`** (Rust + ONNX) | no system Tesseract dependency, faster on modern CPUs |
| AI | **Anthropic API** via `reqwest` + `eventsource-stream` | direct SSE control, no SDK churn |
| Secret store | **`keyring`** + `age`-encrypted fallback | Keychain / Credential Manager / libsecret, headless-safe |
| Layouts | **Dockview React** | tabs + splits with drag handles, zero peer deps |
| Global hotkeys | **`global-hotkey`** | X11 / Wayland / Win / Mac in one crate |
| Config | **TOML** + `notify` watcher | human-readable, hot-reload without restart |
| Frontend state | **Zustand** + `persist` localStorage middleware | tiny, no boilerplate, SSR-safe |
| Bundled font | **JetBrains Mono** (Apache 2.0) | legal to ship, monospaced ligatures |

A complete rationale for each choice lives in the implementation plan; this
table is the elevator pitch.

---

## 3. Rust module map (`src-tauri/src/`)

| Module | Responsibility | Files |
|---|---|---|
| `lib.rs` | Tauri builder, plugin registration, command handler list | `lib.rs`, `main.rs` |
| `state` | `AppState` `Arc` container shared across IPC commands | `state.rs` |
| `error` | `AppError` enum, serialised as `string` on the IPC boundary | `error.rs` |
| `events` | Centralised `&'static str` event-name constants | `events.rs` |
| `commands` | Every `#[tauri::command]` handler, deferring work to managers | `commands.rs` |
| `pty` | Spawn / write / resize / kill PTY sessions, reader-thread lifecycle | `pty/{mod,session,shell}.rs` |
| `store` | Connection pool, migrations, sessions, blocks, FTS5 search | `store/{mod,sessions,blocks,search}.rs` + `migrations/*.sql` |
| `images` | Clipboard / drop / screenshot intake, dedup via sha256, LRU cache | `images/{mod,clipboard,screenshot,storage}.rs` |
| `ai` | Streaming Claude client, BYOK keystore, request builder | `ai/{mod,claude,streaming,keystore}.rs` |
| `ocr` | Lazy-init `ocrs` engine, ONNX models cached under `~/.cache/vibe-term/models/` | `ocr/mod.rs` |
| `config` | TOML schema, paths, `notify` watcher, hot-reload broadcast | `config/{mod,schema,paths,watcher}.rs` + `default_config.toml` |
| `hotkeys` | `global-hotkey` registry, dispatches `hotkey://triggered` | `hotkeys/` (phase 7) |
| `export` | Markdown + HTML serialisation of a session's blocks | `export/` (phase 8) |

**Pattern: trait + per-OS impl rather than `cfg!` macros scattered through
business logic.** A typical example:

```rust
pub trait ClipboardImage: Send + Sync {
    fn read_image(&self) -> Result<Option<DynamicImage>>;
}
#[cfg(target_os = "linux")]   pub use linux::LinuxClipboard   as PlatformClipboard;
#[cfg(target_os = "macos")]   pub use macos::MacClipboard     as PlatformClipboard;
#[cfg(target_os = "windows")] pub use windows::WinClipboard   as PlatformClipboard;
```

Conditional compilation lives at the *boundary*; every consumer sees the
single trait.

---

## 4. React module map (`src/`)

| Component / module | Responsibility |
|---|---|
| `App.tsx` | Root layout: Dockview, AI sidebar, status bar, command palette portal |
| `main.tsx` | React entry point, mounts `<App />`, attaches global error handlers |
| `components/terminal/TerminalView.tsx` | xterm.js instance per PTY, addons, IPC wiring |
| `components/terminal/useXterm.ts` | Hook owning the `Terminal` instance + resize observer |
| `components/terminal/ImageOverlay.tsx` | xterm decoration: inline thumbnail + `img_xxxx` badge |
| `components/terminal/BlockBoundary.tsx` | OSC 133 prompt-boundary marker rendered as a clickable separator |
| `components/layout/TabBar.tsx` | Top tab strip wired to Dockview groups |
| `components/layout/SplitContainer.tsx` | Dockview wrapper + split-axis hotkeys |
| `components/layout/StatusBar.tsx` | Bottom bar: shell, cwd, token usage, AI model |
| `components/ai/AISidebar.tsx` | Collapsible right panel with chat list + composer |
| `components/ai/ChatMessage.tsx` | `react-markdown` + `rehype-highlight` render, `React.memo` per `msgId` |
| `components/ai/ImageChip.tsx` | Staging chip with thumbnail + remove button |
| `components/ai/ApiKeyPrompt.tsx` | First-run onboarding for the Claude API key |
| `components/palette/CommandPalette.tsx` | `cmdk` modal: new tab, switch shell/theme, screenshot, search history |
| `components/settings/SettingsPanel.tsx` | Tabbed modal: General / Appearance / Hotkeys / AI / Advanced |
| `components/settings/ThemeEditor.tsx` | Live colour-token editor backed by `configStore` |
| `components/settings/HotkeysEditor.tsx` | Key-capture row per action, conflict detection |
| `state/terminalStore.ts` | Map `ptyId → metadata`, active tab, scrollback flags |
| `state/aiStore.ts` | Map `conversationId → messages`, streaming buffers |
| `state/imageStore.ts` | Map `imageId → ImageMeta`, staging queue |
| `state/configStore.ts` | Mirror of backend `Settings`, populated by `config_get` + `config://changed` |
| `ipc/types.ts` | Hand-written TS DTOs (re-exported from `ipc/bindings/` once `ts-rs` codegen runs) |
| `ipc/invoke.ts` | Typed wrappers around `tauri.invoke`, grouped by domain |
| `ipc/events.ts` | Typed `on(event, handler)` helper with a per-event payload type map |
| `lib/ansi.ts` | OSC parsing (133 block markers, 7 cwd, bell) |
| `lib/markdown.ts` | Shared `react-markdown` plugin set + sanitizer |
| `lib/id.ts` | Frontend `img_xxxx` / `msg_xxxx` short-id generators |
| `styles/themes/*.css` | Theme token files, switched via `data-theme` on `<html>` |

---

## 5. IPC surface

All Tauri commands return `Result<T, AppError>` (serialised as the
inner-error string on the JS side). Long-running operations *return Ok
immediately* and stream progress via events, never via the IPC reply.

### Commands

| Command | Args | Return | Notes |
|---|---|---|---|
| `ping` | — | `"pong"` | health check |
| `app_info` | — | `AppInfo` | name / version / OS / arch |
| `pty_spawn` | `opts: SpawnOptions` | `PtyId` | spawns reader thread |
| `pty_write` | `id, data: string` | `()` | UTF-8 → master |
| `pty_resize` | `id, cols, rows` | `()` | debounce 100 ms on the frontend |
| `pty_kill` | `id` | `()` | force-kill child, joins reader |
| `pty_list_shells` | — | `Vec<ShellInfo>` | preferred-first |
| `image_paste_from_clipboard` | — | `Option<ImageMeta>` | None when clipboard has no image |
| `image_capture_screen` | `mode: CaptureMode` | `ImageMeta` | `fullscreen` / `activeMonitor` / `region` |
| `image_get` | `id` | `Option<ImageMeta>` | metadata only |
| `image_get_base64` | `id` | `string` | data sans `data:` prefix |
| `image_delete` | `id` | `()` | removes file + sidecar |
| `list_monitors` | — | `Vec<MonitorInfo>` | for region picker UI |
| `ocr_extract` | `imageId` | `string` | lazy engine init on first call |
| `session_create` | `name` | `SessionMeta` | |
| `session_list` | `limit` | `Vec<SessionMeta>` | sorted by `updated_at desc` |
| `session_get` | `id` | `Option<SessionMeta>` | |
| `session_touch` | `id` | `()` | bumps `updated_at` |
| `session_delete` | `id` | `()` | cascades to blocks + images |
| `block_append` | `params: AppendBlockParams` | `Block` | one block per command / output / AI turn |
| `block_list` | `sessionId, limit, offset` | `Vec<Block>` | ordered by `sequence` |
| `block_count` | `sessionId` | `number` | for pagination |
| `search_fts` | `query, session?, limit` | `Vec<SearchHit>` | FTS5 with `<mark>` snippets |
| `ai_set_api_key` | `key: string` | `()` | stores via `keyring` |
| `ai_has_key` | — | `bool` | does **not** return the key |
| `ai_send` | `req: SendRequest` | `()` | returns immediately, results via events |
| `ai_stop` | `conversationId` | `()` | signals in-flight stream to abort |
| `config_get` | — | `Settings` | snapshot under `RwLock` |
| `config_update` | `patch: object` | `Settings` | RFC-7396 JSON merge, persisted to TOML |
| `config_path` | — | `string` | absolute path to `config.toml` |

### Events (backend → frontend)

| Event | Payload | Trigger |
|---|---|---|
| `pty://data` | `{ ptyId, data }` | every 4–16 KB chunk from the PTY reader |
| `pty://exit` | `{ ptyId, code? }` | child process exits |
| `pty://bell` | `{ ptyId }` | BEL (0x07) byte seen |
| `pty://cwd_change` | `{ ptyId, cwd }` | OSC 7 parsed |
| `ai://delta` | `{ conversationId, messageId, text }` | streaming SSE delta (batched 50–100 ms) |
| `ai://message_complete` | `{ conversationId, messageId, usage }` | SSE `message_stop` |
| `ai://error` | `{ conversationId, messageId, error }` | API error or retry exhaustion |
| `hotkey://triggered` | `{ action }` | global hotkey fired |
| `image://added` | `{ imageId, source, w, h, bytes }` | new image landed in the store |
| `config://changed` | `Settings` | TOML edited on disk (watcher) or `config_update` |

Types are generated Rust → TS by `ts-rs` (`#[ts(export, export_to = "../../../src/ipc/bindings/")]`)
so the two sides cannot drift. Until the first backend build seeds the
`bindings/` directory, `src/ipc/types.ts` contains hand-written mirrors.

---

## 6. SQLite schema

The full DDL lives in `src-tauri/src/store/migrations/`. Migrations are
applied at boot, tracked in a `_migrations` table, and **never rewritten in
place** — append a new versioned file instead.

```sql
-- 001_init.sql

CREATE TABLE sessions (
    id            TEXT    PRIMARY KEY,
    name          TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    metadata_json TEXT
);
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);

CREATE TABLE blocks (
    id          TEXT    PRIMARY KEY,
    session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    pty_id      TEXT,
    kind        TEXT    NOT NULL, -- command|output|ai_user|ai_assistant|system
    content     TEXT    NOT NULL,
    ansi_raw    BLOB,
    exit_code   INTEGER,
    duration_ms INTEGER,
    created_at  INTEGER NOT NULL,
    sequence    INTEGER NOT NULL
);
CREATE INDEX idx_blocks_session ON blocks(session_id, sequence);
CREATE INDEX idx_blocks_created ON blocks(created_at);

CREATE TABLE images (
    id         TEXT    PRIMARY KEY,        -- img_xxxxxx
    sha256     TEXT    NOT NULL UNIQUE,    -- dedup key
    path       TEXT    NOT NULL,
    mime       TEXT    NOT NULL,
    width      INTEGER NOT NULL,
    height     INTEGER NOT NULL,
    bytes      INTEGER NOT NULL,
    source     TEXT    NOT NULL,           -- clipboard|screenshot|drop|terminal
    ocr_text   TEXT,                       -- populated lazily
    created_at INTEGER NOT NULL
);

CREATE TABLE block_images (
    block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (block_id, image_id)
);

CREATE TABLE ai_conversations (
    id         TEXT    PRIMARY KEY,
    session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    title      TEXT,
    model      TEXT    NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE ai_exchanges (
    id              TEXT    PRIMARY KEY,
    conversation_id TEXT    NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    role            TEXT    NOT NULL,        -- user|assistant
    content_json    TEXT    NOT NULL,        -- ContentBlock[] serialised
    input_tokens    INTEGER,
    output_tokens   INTEGER,
    created_at      INTEGER NOT NULL,
    sequence        INTEGER NOT NULL
);
CREATE INDEX idx_exch_conv ON ai_exchanges(conversation_id, sequence);

-- 002_fts.sql

CREATE VIRTUAL TABLE blocks_fts USING fts5(
    content,
    content='blocks',
    content_rowid='rowid',
    tokenize='porter unicode61'
);
CREATE VIRTUAL TABLE images_fts USING fts5(
    ocr_text,
    content='images',
    content_rowid='rowid'
);
-- INSERT/UPDATE/DELETE triggers keep the FTS shadows in sync.
```

Connection pool: `r2d2_sqlite` with `max_size = 8`. Per-connection PRAGMAs:
`journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`,
`busy_timeout=5000`.

Default on-disk location:

- Linux: `~/.local/share/vibe-term/history.db`
- macOS: `~/Library/Application Support/vibe-term/history.db`
- Windows: `%APPDATA%\vibe-term\history.db`

---

## 7. End-to-end input flow (one keypress)

```
   User
    |
    | keystroke
    v
+---------------------+
|  xterm.js Terminal  |
+---------------------+
    |
    | term.onData(payload)
    v
+---------------------+
|  TerminalView.tsx   |
+---------------------+
    |
    | invoke("pty_write", { id, data })
    v
+---------------------+
|  commands::pty_write|
+---------------------+
    |
    | PtyManager.write(id, bytes)
    v
+---------------------+
|  portable_pty       |
|  master writer      |
+---------------------+
    |
    | write(2)
    v
+---------------------+
|     shell (PTY)     |
+---------------------+
    |
    | output bytes (echo + result)
    v
+---------------------+
|  reader thread      |
|  (per session)      |
+---------------------+
    |
    | UTF-8 chunk (4..16 KB)
    v
+---------------------+
| AppHandle.emit_to   |
|  "pty://data"       |
+---------------------+
    |
    | Tauri IPC bridge
    v
+---------------------+
|  ipc/events.on(...) |
+---------------------+
    |
    | handler({ ptyId, data })
    v
+---------------------+
|  term.write(data)   |
+---------------------+
```

Backpressure: the reader thread runs in a dedicated `std::thread` (not on the
Tokio pool) and feeds an `mpsc` channel sized at 1 MiB. If the frontend lags,
the channel saturates, the reader sleeps briefly, then resumes — pickup is
graceful and no data is lost.

---

## 8. Cross-platform strategy

Three OS families share one codebase. The rules:

- **No `#[cfg]` in business logic.** Each subsystem (clipboard, screenshot,
  shell detection, hotkeys, keystore) declares a trait; the platform-specific
  module implements it; a single `pub use` reroutes the right impl per OS.
- **No subprocess fallbacks unless they unblock real users.** The Wayland
  clipboard path shells out to `wl-paste` only because `arboard` has known
  Wayland edge cases on KDE/GNOME; that branch is documented in
  [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).
- **Headless gracefully.** WSL and SSH sessions have no keyring; the `ai`
  module detects keyring failure and falls back to an `age`-encrypted file
  keyed on `/etc/machine-id` (Linux) or the Hardware UUID (macOS).
- **PTY:** `portable-pty` already unifies ConPTY (Windows ≥ 1809) with
  forkpty (Unix). The only platform-specific code we ship is shell detection
  (`/etc/shells` vs registry-or-`which` vs `wsl.exe -l -q`).
- **Path resolution:** the `dirs` crate (XDG / Apple / Windows Known Folders)
  produces `app_data`, `cache`, and `config` directories. We never assume
  `$HOME` exists.
- **GPU rendering:** xterm `addon-webgl` is enabled by default; if WebGL
  initialisation fails (older WebKitGTK on Linux), we silently fall back to
  the Canvas renderer with a warning in the log file.

---

## 9. Security model

- **CSP.** `tauri.conf.json` ships a strict `Content-Security-Policy` that
  forbids `unsafe-eval`, restricts `connect-src` to `https://api.anthropic.com`
  and `ipc:` origins, and disallows remote scripts. Hot-reload only relaxes
  CSP in dev builds.
- **Capability manifests.** Every Tauri command is declared in
  `src-tauri/capabilities/default.json`; missing declarations cause IPC to be
  rejected at boot. Adding a command is a two-line PR — file + manifest.
- **BYOK key handling.** API keys never appear in logs (the `redact_key`
  helper truncates to `sk-ant-…1234`), are stored via the OS keychain, and
  the in-memory `String` is marked sensitive in HTTP headers
  (`HeaderValue::set_sensitive(true)`).
- **Drag-drop interception.** WebView2 / WebKitGTK normally hijack file
  drops; we set `fileDropEnabled: false` in `tauri.conf.json` and listen to
  `WindowEvent::FileDrop` on the Rust side, then dispatch via Tauri events.
  This prevents an HTML drop from leaking into the renderer process.
- **Permissions for screenshot on macOS.** `macos-private-api = true` plus an
  `NSScreenCaptureUsageDescription` string in `Info.plist`. First capture
  triggers the System Settings prompt; subsequent captures reuse the grant.
- **Wayland fallbacks.** When `arboard` returns no image on Wayland (some
  KDE configurations), the manager retries via `wl-paste --type image/png`.
  The same logic applies to `wl-copy` on the write path.
- **Network egress.** The only outbound TLS the binary makes is to
  `api.anthropic.com` (`reqwest` with `rustls-tls`, gzip enabled). OCR models
  are downloaded once via a separate shell script (`scripts/fetch-ocr-models.sh`),
  not from inside the running app.

---

## 10. Performance budget

| Metric | Target | Measurement |
|---|---|---|
| Idle RAM (RSS) | ≤ 45 MB (Linux), ≤ 80 MB (macOS / Windows WebView) | `ps -o rss`, Task Manager |
| Cold start to first prompt | ≤ 2 s | `time pnpm tauri:dev` then xterm `onRender` |
| `yes` throughput rendering | ≥ 60 fps with `addon-webgl` | Chrome DevTools FPS meter |
| PTY emit batching | 4–16 KB per `pty://data` event | `tracing` log spans |
| FTS5 search latency | < 50 ms on 10 k blocks | `cargo bench` in `store::search` |
| AI delta batching | 50–100 ms `requestAnimationFrame` coalesce | `ai_store` profiler |
| OCR (1080p frame) | < 3 s on M1 / Ryzen-class CPU | `cargo test --release` in `ocr` |
| Memory after 1 h idle | stable within ±10 % of startup RSS | `htop` long-run |
| PTY zombie count after close | exactly 0 | `pgrep -f bash` post-quit |
| Release binary size | < 12 MB (Linux), < 18 MB (Win/Mac) | `du -h target/release/bundle/...` |

The `[profile.release]` block in `src-tauri/Cargo.toml` enforces these via
`lto = true`, `codegen-units = 1`, `opt-level = "s"`, `panic = "abort"`,
`strip = true`.
