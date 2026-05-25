# Troubleshooting

Symptom → Cause → Fix entries for every quirk we've hit so far. If your
problem isn't listed, please open an issue with the contents of the log
file (see [Log locations](#0-where-is-the-log-file)).

---

## 0. Where is the log file

| OS | Path |
|---|---|
| Linux | `~/.local/share/vibe-term/logs/vibe-term.log` |
| macOS | `~/Library/Logs/vibe-term/vibe-term.log` |
| Windows | `%LOCALAPPDATA%\vibe-term\logs\vibe-term.log` |

Set `RUST_LOG=debug` (Linux / macOS) or `$env:RUST_LOG = "debug"`
(PowerShell) before launching from a terminal to get verbose tracing.

---

## 1. macOS Gatekeeper blocks first launch

**Symptom.** Double-clicking `vibe-term.dmg → vibe-term.app` shows
"vibe-term cannot be opened because the developer cannot be verified" with
only a "Move to Trash" button.

**Cause.** We do not (yet) sign or notarise macOS builds. Gatekeeper
quarantines the bundle on first run.

**Fix (one-time).**

1. In Finder, locate the `vibe-term` app icon (usually in `/Applications`
   after dragging from the DMG).
2. **Right-click → Open** (or `Ctrl`-click → Open).
3. The dialog now contains an **Open** button. Click it. The app launches
   and Gatekeeper records the consent.
4. Subsequent launches via Spotlight / Dock work normally.

Alternative (terminal): `xattr -dr com.apple.quarantine /Applications/vibe-term.app`.

---

## 2. Windows SmartScreen "unknown publisher"

**Symptom.** Running the `.exe` or `.msi` installer pops up
"Windows protected your PC" with a single "Don't run" button.

**Cause.** No code-signing certificate. SmartScreen treats every unsigned
download with low reputation.

**Fix (one-time).**

1. Click **More info** in the dialog.
2. A **Run anyway** button appears. Click it.
3. Optional: in PowerShell as Admin, unblock the file in bulk:
   `Get-ChildItem Downloads -Recurse | Unblock-File`.

---

## 3. AppImage crashes immediately on Ubuntu 24.04 / Wayland

**Symptom.** `./vibe-term_x.y.z_amd64.AppImage` exits with no window, log
contains `Trace/breakpoint trap` or `dmabuf: failed to import buffer`.

**Cause.** WebKitGTK's DMA-BUF renderer collides with the Wayland compositor
in certain GNOME 46 configurations.

**Fix.**

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 ./vibe-term_x.y.z_amd64.AppImage
```

Or, prefer the `.deb` package (`sudo dpkg -i vibe-term_x.y.z_amd64.deb`) —
it's slightly more robust on Wayland.

Persistent workaround: drop a `~/.config/environment.d/99-vibe-term.conf`
with `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

---

## 4. Wayland: pasting an image does nothing

**Symptom.** `Ctrl+V` works for text but no image appears, even though
GIMP / a browser can paste the same screenshot.

**Cause.** `arboard` falls back to `wl-paste` on Wayland and `wl-clipboard`
is not installed.

**Fix.**

```bash
sudo apt-get install wl-clipboard       # Debian/Ubuntu
sudo dnf install wl-clipboard           # Fedora
sudo pacman -S wl-clipboard             # Arch
```

Verify: `wl-paste --list-types` should include `image/png` after copying an
image somewhere.

---

## 5. macOS: screenshot hotkey does nothing

**Symptom.** Pressing `Cmd+Option+S` shows no overlay, no log error.

**Cause.** macOS requires explicit Screen Recording permission for
non-sandboxed apps. The first capture should prompt; if you missed the
dialog, you need to grant it manually.

**Fix.**

1. **System Settings → Privacy & Security → Screen & System Audio Recording**.
2. Toggle **vibe-term** ON.
3. macOS asks to *quit and re-open* the app — do so.

If `vibe-term` isn't in the list, run a capture once to trigger the
authorisation prompt.

---

## 6. macOS: microphone / camera permissions denied at boot

**Symptom.** Log line: `tcc: required permission missing`.

**Cause.** We currently do not request microphone or camera access. If you
see this, an outdated plugin in `tauri.conf.json` is misconfigured.

**Fix.** Update to the latest release. Report the version in an issue.

---

## 7. Windows: ConPTY output garbled after rapid resize

**Symptom.** Dragging the window edge fast leaves the terminal with
duplicate prompt lines or interleaved escape sequences.

**Cause.** ConPTY (the Windows pseudo-console) handles resize via its own
worker; sending too many `ResizePseudoConsole` calls per second corrupts
state.

**Fix.** The frontend already debounces resize at 100 ms by default. If you
still see corruption (very fast monitors, multiple high-Hz screens), bump it:

```toml
[terminal]
resize_debounce_ms = 200
```

A planned full fix is to throttle on the Rust side as well; track
[issue #TBD] when filed.

---

## 8. Windows: WSL distros missing from the shell picker

**Symptom.** The dropdown shows `pwsh`, `powershell`, `cmd` but no
`WSL: <distro>` entry, despite WSL being installed.

**Cause.** `wsl.exe -l -q` returns an empty list when no distros have
finished provisioning, or when `wsl.exe` is older than build 19000.

**Fix.**

```powershell
wsl --update
wsl -l -q          # confirm at least one distro is listed
```

Restart `vibe-term`; the shell detector runs only at app start.

---

## 9. Linux: `webkit2gtk-4.1.pc not found` during `pnpm tauri:dev`

**Symptom.** Cargo build error mentioning `webkit2gtk-4.1`.

**Cause.** Ubuntu 22.04 / Debian 12 still ship WebKitGTK 4.0; Tauri 2 needs
4.1.

**Fix.** Either upgrade to Ubuntu 24.04 / Debian 13, or add the Tauri PPA:

```bash
sudo add-apt-repository ppa:tauri-apps/tauri
sudo apt-get update
sudo apt-get install libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev
```

---

## 10. Linux: status bar shows "AI: no key" even after entering one

**Symptom.** You typed your `sk-ant-…` key in the onboarding modal and the
status bar still reports "no key".

**Cause.** `libsecret` is missing (headless install) or the user has no
unlocked keyring. `keyring` writes succeed but reads return nothing.

**Fix.**

```bash
sudo apt-get install gnome-keyring libsecret-1-0 libsecret-1-dev
```

Log out / in once so GNOME Keyring picks up the new password manager. As a
last resort, set `VIBE_ALLOW_FILE_KEYSTORE=1` and re-run; the keystore will
fall back to an `age`-encrypted file under `~/.local/share/vibe-term/keys/`.

---

## 11. OCR: "extract text" says "no models found"

**Symptom.** Right-click → "Extract text" toast: `OCR models not initialised`.

**Cause.** The ONNX models for `ocrs` are ~50 MB and not bundled with the
app. They download lazily on the first OCR run; if the download was
interrupted, the cache directory may contain a partial file.

**Fix.**

```bash
rm -rf ~/.cache/vibe-term/models
./scripts/fetch-ocr-models.sh
```

Alternatively, run the script from the source tree before first launch to
pre-cache the models.

---

## 12. Network: AI requests time out after 60 s with no output

**Symptom.** `ai://error` event payload contains
`anthropic stream failed after retries: connect timeout`.

**Cause.** Corporate proxies, VPN, or DNS issues blocking
`api.anthropic.com`.

**Fix.**

1. From a terminal: `curl -v https://api.anthropic.com/v1/models -H "anthropic-version: 2023-06-01" -H "x-api-key: $ANTHROPIC_API_KEY"`.
2. If `curl` fails too, fix DNS / proxy first (`HTTPS_PROXY` env var is
   honoured by `reqwest`).
3. If `curl` succeeds, ensure the app inherits the proxy env (launch from a
   shell, not from the Dock / Start menu launcher).

---

## 13. Terminal renders garbled glyphs / boxes instead of icons

**Symptom.** Nerd Font icons render as `?` or rectangles.

**Cause.** JetBrains Mono (bundled) does **not** include the Nerd Font
ligatures. The terminal also doesn't load OS-installed fonts unless you ask
for one.

**Fix.**

```toml
[appearance]
font_family = "JetBrainsMono Nerd Font"   # or "FiraCode Nerd Font", etc.
```

You must install the Nerd Font family yourself; we don't redistribute it.

---

## 14. xterm.js warns about WebGL context loss

**Symptom.** DevTools console: `WARN xterm: WebGL context lost, falling back to Canvas`.

**Cause.** Old WebKitGTK on Linux, or a GPU driver that suspended the WebGL
context (NVIDIA on power-save).

**Fix.** The fallback is automatic and harmless — performance drops from
60+ fps to 30-ish on heavy redraws. To silence the warning permanently:

```toml
[appearance]
renderer = "canvas"     # explicitly opt out of WebGL
```

---

## 15. The app refuses to close, "process still running"

**Symptom.** Closing the last window leaves a `vibe-term` process running
(visible in `ps`/Task Manager).

**Cause.** A child shell process didn't exit cleanly — usually a wedged
`ssh` session or an interactive `vim` waiting for input.

**Fix.** From a terminal:

```bash
pgrep -f vibe-term | xargs kill   # nuclear option, all instances
```

Then file a bug with the offending command so we can add proper cleanup
to the PTY `Drop` impl.

---

## 16. Config changes don't take effect

**Symptom.** Edit `config.toml`, save, but the theme / hotkey doesn't change.

**Cause.** Either you saved the file in an editor that writes via a tmp
file + rename (and `notify` lost the event), or there's a TOML parse error.

**Fix.**

1. Check the log for `config: failed to parse, keeping previous` — fix the
   syntax error first.
2. Touch the file manually: `touch ~/.config/vibe-term/config.toml`.
3. As a last resort, restart the app.

The watcher is debounced at 200 ms; if your editor saves in two rapid
operations, only the second triggers a reload.
