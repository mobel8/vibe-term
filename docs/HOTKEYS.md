# Hotkeys

Every keyboard shortcut in `vibe-term` is configurable via the `[hotkeys]`
section of `config.toml`. Changes are picked up at runtime by the watcher
(see [CONFIG.md](./CONFIG.md)) — no restart required.

The defaults below come from `src-tauri/src/config/default_config.toml`.

---

## 1. Default bindings

| Action | Linux / Windows | macOS |
|---|---|---|
| `new_tab` | `Ctrl+T` | `Cmd+T` |
| `close_tab` | `Ctrl+W` | `Cmd+W` |
| `split_horizontal` (above / below) | `Ctrl+Shift+E` | `Cmd+Shift+E` |
| `split_vertical` (left / right) | `Ctrl+Shift+D` | `Cmd+Shift+D` |
| `toggle_ai_panel` | `Ctrl+I` | `Cmd+I` |
| `search_history` (FTS5) | `Ctrl+R` | `Cmd+R` |
| `screenshot_region` (global) | `Ctrl+Alt+S` | `Cmd+Option+S` |
| `screenshot_full` (global) | `Ctrl+Alt+F` | `Cmd+Option+F` |
| `command_palette` | `Ctrl+K` | `Cmd+K` |
| `paste_clipboard_image` | `Ctrl+V` | `Cmd+V` |
| `copy_selection` | `Ctrl+Shift+C` | `Cmd+C` |
| `paste_selection` | `Ctrl+Shift+V` | `Cmd+V` |
| `zoom_in` | `Ctrl++` | `Cmd++` |
| `zoom_out` | `Ctrl+-` | `Cmd+-` |
| `zoom_reset` | `Ctrl+0` | `Cmd+0` |
| `next_tab` | `Ctrl+Tab` | `Ctrl+Tab` |
| `prev_tab` | `Ctrl+Shift+Tab` | `Ctrl+Shift+Tab` |
| `toggle_devtools` (dev builds) | `Ctrl+Shift+I` | `Cmd+Option+I` |

On macOS the platform translates `Ctrl+X` defaults into `Cmd+X` at config
load time; you don't need to maintain two parallel sets. The exception is
*global* shortcuts (`screenshot_region`, `screenshot_full`), which must use
the literal modifier name (`Cmd`, `Option`) on macOS to register correctly
with the system event tap.

---

## 2. Customising

Edit `~/.config/vibe-term/config.toml` (Linux),
`~/Library/Application Support/vibe-term/config.toml` (macOS), or
`%APPDATA%\vibe-term\config.toml` (Windows):

```toml
[hotkeys]
new_tab = "Ctrl+T"
toggle_ai_panel = "Cmd+I"           # macOS-style modifier
screenshot_region = "Ctrl+Alt+S"
command_palette = "Ctrl+Shift+P"    # rebind from Ctrl+K
```

Modifier names recognised by the parser: `Ctrl`, `Shift`, `Alt` (Linux /
Windows), `Cmd` and `Option` (macOS), `Super` (Linux Meta / Windows key).
Key names follow the [`global-hotkey` crate](https://docs.rs/global-hotkey/)
conventions: alphanumerics, `F1`–`F24`, `Enter`, `Tab`, `Space`, `Backspace`,
`Delete`, `Up`, `Down`, `Left`, `Right`, `PageUp`, `PageDown`, `Home`, `End`,
`Escape`, `+`, `-`, `[`, `]`, etc.

To **disable** a binding, set it to an empty string:

```toml
[hotkeys]
zoom_in = ""
```

To restore a binding to its built-in default, delete the line entirely.

---

## 3. Conflicts and gotchas

Global hotkeys (those registered with the OS regardless of focus) can
collide with desktop-environment shortcuts. Common ones:

| OS / DE | Reserved combination | Affected default |
|---|---|---|
| GNOME on Ubuntu / Fedora | `Ctrl+Alt+S` (sometimes Settings → Sound) | `screenshot_region` |
| KDE Plasma | `Ctrl+Alt+L` (lock screen) | — |
| macOS Sequoia | `Cmd+Space` (Spotlight) | — |
| macOS Sequoia | `Cmd+Option+Esc` (Force Quit) | — |
| Windows 11 | `Ctrl+Alt+Del` (security desktop) | — |
| Windows 11 | `Win+Shift+S` (Snipping Tool) | not used by default; safe |
| i3 / Sway | window-manager bindings vary | check `i3-config-wizard` / `swaymsg` |

If `vibe-term` fails to register a global hotkey, the in-app status bar
flashes a warning toast (`"Couldn't register Ctrl+Alt+S: in use"`) and the
log file records:

```
WARN hotkeys::registry  failed to register Ctrl+Alt+S: HotKeyAlreadyRegistered
```

Either rebind the hotkey in `config.toml` or release the conflicting
shortcut in your OS settings.

---

## 4. In-terminal keybindings

These are handled by xterm.js (frontend only) and *cannot* be remapped via
`[hotkeys]`. They are listed here for reference.

| Combination | Effect |
|---|---|
| `Shift+PageUp` / `Shift+PageDown` | scroll the scrollback buffer |
| `Shift+Home` / `Shift+End` | jump to top / bottom of scrollback |
| Mouse selection | held by xterm; respect `terminal.copy_on_select` |
| Middle-click | paste selection (X11 / Wayland convention) |
| Right-click | context menu (paste, copy, "extract text from image"…) |

If you need different behaviour, look in `src/components/terminal/useXterm.ts`
where `attachCustomKeyEventHandler` lives.

---

## 5. Programmatic dispatch

Internally, every shortcut maps to an `action` string (the keys in the
table above). The backend emits `hotkey://triggered` with `{ action }` and
the frontend dispatches to the matching handler. The command palette
(`Ctrl+K`) lists every action by name, which doubles as a discoverability
mechanism: type `screenshot` and you'll find both `screenshot_region` and
`screenshot_full` even if you forgot the keystroke.
