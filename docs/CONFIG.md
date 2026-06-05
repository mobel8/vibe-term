# Configuration reference

`vibe-term` is configured by a single TOML file. The file is created on
first launch from the bundled defaults, watched at runtime, and
hot-reloaded on every save. Missing fields fall back to their built-in
default, so you only need to write what you want to change.

---

## 1. File location

| OS | Path |
|---|---|
| Linux | `~/.config/vibe-term/config.toml` |
| macOS | `~/Library/Application Support/vibe-term/config.toml` |
| Windows | `%APPDATA%\vibe-term\config.toml` |

Run `Command Palette → Settings → Open config file` (or just `Ctrl+K → open config`)
to reveal the file in your file manager.

---

## 2. Reading & editing

- **Editor friendly.** TOML, UTF-8, LF line endings. Comments start with `#`.
- **Atomic save.** Editors that write via tmp file + rename (vim, VS Code)
  are detected by the watcher; the change is applied within 200 ms.
- **Validation.** Invalid TOML or unknown enum variants are logged and the
  previous snapshot is kept — your app does not blank out.
- **Programmatic edits.** The `config_update` IPC command applies an
  RFC-7396 JSON merge patch on top of the current snapshot, persists the
  result, and broadcasts `config://changed`.

---

## 3. Section reference

The schema is defined in `src-tauri/src/config/schema.rs`. Section order is
free; this listing follows the bundled `default_config.toml`.

### `[general]`

```toml
[general]
# default_shell = "/usr/bin/zsh"     # absolute path; defaults to the best detected shell
# working_directory = "/home/me"     # defaults to $HOME / %USERPROFILE%
scrollback_lines = 10000
confirm_on_close = true
```

| Field | Type | Default | Description |
|---|---|---|---|
| `default_shell` | string \| missing | autodetected | Absolute path to the shell binary new tabs spawn. When missing, the first entry from `pty_list_shells` is used. |
| `working_directory` | string \| missing | `$HOME` / `%USERPROFILE%` | CWD assigned to every newly spawned PTY. |
| `scrollback_lines` | u32 | `10000` | Per-tab xterm scrollback length. Higher = more RAM. |
| `confirm_on_close` | bool | `true` | Ask before closing a tab / window with a live child process. |

### `[appearance]`

```toml
[appearance]
theme = "dark"                       # "dark" | "light" | "dracula" | "nord" | "tokyo-night"
font_family = "JetBrains Mono"
font_size = 13
line_height = 1.4
cursor_style = "block"               # "block" | "bar" | "underline"
cursor_blink = true
```

| Field | Type | Default | Description |
|---|---|---|---|
| `theme` | string | `"dark"` | Bundled theme name. Custom themes can be added under `~/.config/vibe-term/themes/<name>.toml`. |
| `font_family` | string | `"JetBrains Mono"` | Family name resolved by the WebView. Use a Nerd Font variant for glyph icons. |
| `font_size` | u16 | `13` | Pixel size. Zoom hotkeys (`Ctrl++`, `Ctrl+-`) mutate this temporarily; saving persists. |
| `line_height` | f32 | `1.4` | Multiplier (not pixels). Anything below `1.2` cramps box-drawing chars. |
| `cursor_style` | enum | `"block"` | `block`, `bar`, or `underline`. |
| `cursor_blink` | bool | `true` | Disable for an OLED-friendly steady cursor. |

### `[ai]`

```toml
[ai]
provider = "anthropic"               # "anthropic" | "groq" | "mistral" | "cerebras" | "deepseek"
model = "claude-opus-4-7"
max_context_blocks = 5
auto_summarize_threshold_tokens = 150000
```

| Field | Type | Default | Description |
|---|---|---|---|
| `provider` | enum | `"anthropic"` | One of `anthropic`, `groq`, `mistral`, `cerebras`, `deepseek`. Anthropic uses the native Messages API; the others are OpenAI-compatible. Each provider stores its own API key. (Legacy `openai` is accepted and migrated to `anthropic`.) |
| `model` | string | `"claude-opus-4-7"` | Model ID passed verbatim to the selected provider's API. Must be a model offered by `provider` (see the in-app model picker for the full per-provider list). |
| `max_context_blocks` | u32 | `5` | Number of trailing terminal blocks auto-attached as a `<terminal_context>` system note. |
| `auto_summarize_threshold_tokens` | u32 | `150000` | When the running conversation crosses this input-token count, the app offers to compact via Sonnet 4.6. |

### `[terminal]`

```toml
[terminal]
bell = true
copy_on_select = false
right_click_paste = true
```

| Field | Type | Default | Description |
|---|---|---|---|
| `bell` | bool | `true` | Honour BEL (0x07) bytes with a status-bar flash. |
| `copy_on_select` | bool | `false` | macOS / X11 muscle-memory: highlight = copy. |
| `right_click_paste` | bool | `true` | Right-click pastes the clipboard (Windows-Terminal-style). |

### `[hotkeys]`

Map of `action → key combination`. The exhaustive list of actions and
default combos lives in [HOTKEYS.md](./HOTKEYS.md). Example:

```toml
[hotkeys]
new_tab = "Ctrl+T"
close_tab = "Ctrl+W"
split_horizontal = "Ctrl+Shift+E"
split_vertical = "Ctrl+Shift+D"
toggle_ai_panel = "Ctrl+I"
search_history = "Ctrl+R"
screenshot_region = "Ctrl+Alt+S"
screenshot_full = "Ctrl+Alt+F"
command_palette = "Ctrl+K"
```

---

## 4. Custom themes

A theme file lives in `~/.config/vibe-term/themes/<slug>.toml`:

```toml
# ~/.config/vibe-term/themes/solarized-dark.toml
name = "Solarized Dark"

[colors]
background = "#002b36"
foreground = "#839496"
cursor     = "#93a1a1"
selection  = "#073642"

# 16-colour ANSI palette
black   = "#073642"; red     = "#dc322f"
green   = "#859900"; yellow  = "#b58900"
blue    = "#268bd2"; magenta = "#d33682"
cyan    = "#2aa198"; white   = "#eee8d5"

bright_black   = "#002b36"; bright_red     = "#cb4b16"
bright_green   = "#586e75"; bright_yellow  = "#657b83"
bright_blue    = "#839496"; bright_magenta = "#6c71c4"
bright_cyan    = "#93a1a1"; bright_white   = "#fdf6e3"
```

Then in `config.toml`:

```toml
[appearance]
theme = "solarized-dark"
```

The theme file is reloaded by the watcher — switching is instant.

---

## 5. Environment variable overrides

A handful of variables override config for diagnostic / scripting use:

| Variable | Effect |
|---|---|
| `VIBE_CONFIG_PATH` | absolute path to use instead of the default config file |
| `VIBE_DATA_DIR` | override base directory for `history.db`, `images/`, `logs/` |
| `VIBE_MODELS_DIR` | OCR model cache (default `~/.cache/vibe-term/models`) |
| `VIBE_ALLOW_FILE_KEYSTORE` | `1` to force the `age`-encrypted file keystore even when `keyring` works |
| `RUST_LOG` | tracing filter (default `info,vibe_term_lib=debug`) |
| `WEBKIT_DISABLE_DMABUF_RENDERER` | Linux: workaround for AppImage Wayland crashes (see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)) |

Env-var values *always win* over the file. Useful when testing a build
against an isolated profile: `VIBE_CONFIG_PATH=/tmp/t.toml VIBE_DATA_DIR=/tmp/d ./vibe-term`.

---

## 6. JSON shape (frontend / IPC)

`config_get` returns the same tree as JSON, with `snake_case` field names
preserved. For example:

```json
{
  "general":   { "defaultShell": null, "workingDirectory": null, "scrollbackLines": 10000, "confirmOnClose": true },
  "appearance":{ "theme": "dark", "fontFamily": "JetBrains Mono", "fontSize": 13, "lineHeight": 1.4, "cursorStyle": "block", "cursorBlink": true },
  "hotkeys":   { "new_tab": "Ctrl+T", "close_tab": "Ctrl+W", "command_palette": "Ctrl+K" },
  "ai":        { "provider": "anthropic", "model": "claude-opus-4-7", "maxContextBlocks": 5, "autoSummarizeThresholdTokens": 150000 },
  "terminal":  { "bell": true, "copyOnSelect": false, "rightClickPaste": true }
}
```

(Frontend DTOs use `camelCase`; the conversion happens via `serde` rename
rules — see `src-tauri/src/config/schema.rs`.)
