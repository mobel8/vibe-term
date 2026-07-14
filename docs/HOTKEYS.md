# Hotkeys

Every rebindable keyboard shortcut in `vibe-term` lives in the `[hotkeys]`
section of `config.toml`. Changes are picked up at runtime by the watcher
(see [CONFIG.md](./CONFIG.md)) — no restart required. Shortcuts are matched
in the window's **capture phase**, before the terminal sees the keystroke,
so a chord never leaks bytes into the shell.

The defaults below are the canon from `src-tauri/src/config/schema.rs`
(`default_hotkeys()`), mirrored by `default_config.toml`.

---

## 1. Default bindings (rebindable)

| Action | Default | Effect |
|---|---|---|
| `new_tab` | `Ctrl+T` | New terminal tab (uses `general.defaultShell` / `workingDirectory`) |
| `close_tab` | `Ctrl+W` | Close the active pane (asks first when `general.confirmOnClose` and a process is running) |
| `split_horizontal` | `Ctrl+Shift+D` | Split side-by-side (new pane to the right) |
| `split_vertical` | `Ctrl+Shift+E` | Split stacked (new pane below) |
| `toggle_ai_panel` | `Ctrl+I` | Toggle the AI sidebar |
| `search_history` | `Ctrl+R` | Search persisted scrollback (FTS5) |
| `screenshot_region` | `Ctrl+Alt+S` | Region screenshot → inserts the image path into the active CLI |
| `screenshot_full` | `Ctrl+Alt+F` | Full-screen screenshot → same insertion |
| `command_palette` | `Ctrl+K` | Toggle the command palette |
| `open_settings` | `Ctrl+,` | Open the settings panel |
| `clear_terminal` | *(unbound)* | Wipe the active pane's viewport + scrollback |
| `reset_terminal` | *(unbound)* | Rewind leaked TUI modes (mouse tracking, bracketed paste, alt screen…) |

On macOS, `Ctrl` in a stored combo is treated as `Cmd` at match time, so one
binding table serves every platform.

> Older builds shipped `split_horizontal`/`split_vertical` swapped relative
> to what the keys actually did. Configs still containing that exact legacy
> pair are migrated automatically at load.

### Fixed aliases (not rebindable)

| Combination | Effect |
|---|---|
| `Ctrl+Shift+W` | Close pane (Windows Terminal muscle memory) |
| `Ctrl+Shift+G` | Toggle the image gallery |
| `Alt+Shift+=` (plus) | Split side-by-side (WT-style) |
| `Alt+Shift+-` (minus / `Digit6` on AZERTY) | Split stacked (WT-style) |

---

## 2. Customising

Edit the config file (`Ctrl+K` → "Open config.toml", or find it at
`%APPDATA%\com.vibeterm.app\config.toml` on Windows,
`~/.config/com.vibeterm.app/config.toml` on Linux,
`~/Library/Application Support/com.vibeterm.app/config.toml` on macOS):

```toml
[hotkeys]
new_tab = "Ctrl+T"
command_palette = "Ctrl+Shift+P"    # rebind from Ctrl+K
clear_terminal = "Ctrl+Alt+L"       # give the unbound actions a chord
reset_terminal = "Ctrl+Alt+R"
```

Modifier names recognised by the parser: `Ctrl`/`Control`, `Shift`,
`Alt`/`Option`/`Opt`, `Meta`/`Cmd`/`Command`/`Super`/`Win`. Key names:
single characters, `F1`-style function keys, `Enter`, `Tab`, `Space`,
`Escape`, `ArrowUp`…, `PageUp`/`PageDown`, `Home`/`End`, `+`, `-`, `,`.

A binding must include `Ctrl`, `Alt` or `Meta` when its key is a single
printable character — a bare `"r"` would capture normal typing and is
ignored with a console warning.

To **disable** a binding, set it to an empty string. To restore a default,
delete the line.

The Settings → Hotkeys tab edits the same table interactively (click a row,
press the new chord) and warns about common OS conflicts.

---

## 3. Conflicts and gotchas

`screenshot_region` / `screenshot_full` may also be registered as OS-global
shortcuts. If registration fails (combo held by the OS or another app), a
toast appears and the log records the `HotKeyAlreadyRegistered` warning —
rebind in config or free the OS shortcut. Known collisions: GNOME uses
`Ctrl+Alt+S` in some setups; Windows `Win+Shift+S` (Snipping Tool) is not
used by vibe-term.

---

## 4. In-terminal keybindings

Handled inside the terminal pane (not remappable via `[hotkeys]`):

| Combination | Effect |
|---|---|
| `Ctrl+V` | Paste text — or, with an image on the clipboard, insert a functional `@~/.vibe-shots/<id>.png` mention (local **and** over SSH, upload runs in the background) |
| `Ctrl+Shift+V` | Same as `Ctrl+V` (force path-mention mode for images) |
| `Ctrl+Alt+V` | Stream the clipboard image through the PTY as base64 (works over any transport) |
| `Alt+V` | Passes through to the running program untouched |
| `Ctrl+C` | With a selection: copy it. Without: send SIGINT as usual |
| `Shift+wheel` | ALWAYS scrolls the local viewport — escape hatch when a TUI (or a leaked mouse mode) owns the wheel |
| `Shift+PageUp` / `Shift+PageDown` | Scroll the scrollback buffer |
| Right-click | Paste (when `terminal.rightClickPaste` is on) |
| Mouse selection | Copies automatically when `terminal.copyOnSelect` is on; `Shift+drag` forces a local selection while a TUI has mouse reporting |

The terminal also **self-heals** leaked TUI state: when a fullscreen app
dies without cleanup (ssh drop mid-`claude`/`vim`), scrolling or pasting
into the orphaned pane detects that no child process is running and rewinds
mouse tracking / bracketed paste / focus reporting / the alternate screen
automatically. The palette's **"Reset terminal state"** runs the same rewind
on demand.

---

## 5. Programmatic dispatch

Internally, every shortcut maps to an `action` string (the keys in the
table above). The backend emits `hotkey://triggered` with `{ action }` and
the frontend dispatches to the matching handler registered in the hotkeys
store. The command palette (`Ctrl+K`) lists every action by name — type
"screenshot" and you'll find both screenshot actions even if you forgot the
keystroke; the shortcut hints it shows are read from the live binding
table, so they always tell the truth.
