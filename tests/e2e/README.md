# vibe-term E2E tests (WebdriverIO + tauri-driver)

End-to-end coverage for the packaged Tauri app. We rely on [`tauri-driver`][td]
to spawn the native WebDriver implementation that ships with each OS and proxy
WebDriver commands to the Tauri window.

[td]: https://v2.tauri.app/develop/tests/webdriver/

## What this exercises

`tests/e2e/specs/smoke.spec.ts` covers the bare minimum required to catch a
regression in the app shell:

1. The binary launches and the React UI mounts.
2. The hero `<h1>` reads `vibe-term`.
3. The Tauri IPC bridge replies to `ping` with `"pong"`.
4. `app_info` returns the expected metadata shape (`name`, `version`,
   `target_os`, `target_arch`).

Anything richer (PTY sessions, image paste, AI streaming) lives in dedicated
Rust integration tests or — eventually — additional WDIO specs.

## Local install (once)

```sh
# WebdriverIO + the Mocha framework + a spec reporter.
pnpm add -D \
  @wdio/cli@^9 \
  @wdio/local-runner@^9 \
  @wdio/mocha-framework@^9 \
  @wdio/spec-reporter@^9 \
  @wdio/types@^9 \
  webdriverio@^9 \
  @types/mocha@^10

# The Rust-side driver. Same on every OS.
cargo install tauri-driver --locked
```

Add the convenience script to `package.json`:

```json
{
  "scripts": {
    "test:e2e": "wdio run tests/e2e/wdio.conf.ts"
  }
}
```

## Running per OS

In every case the driver binary must be on `PATH`. The flow is the same:

```sh
pnpm tauri build --debug   # produce src-tauri/target/debug/vibe-term
pnpm test:e2e              # spawns tauri-driver + runs WDIO
```

### Linux (Ubuntu / Debian)

`tauri-driver` shells out to `WebKitWebDriver` (a.k.a. `webkit2gtk-driver`).
Install it from the system package manager:

```sh
sudo apt-get install -y webkit2gtk-driver xvfb
```

Headless CI runners need an X server. Wrap the command in `xvfb-run`:

```sh
xvfb-run -a pnpm test:e2e
```

`wdio.conf.ts` automatically exports the two WebKit env vars required to keep
the compositor stable inside Xvfb:

- `WEBKIT_DISABLE_DMABUF_RENDERER=1`
- `WEBKIT_DISABLE_COMPOSITING_MODE=1`

### macOS

WebKit on macOS uses `WebDriverAgent` via Apple's bundled `safaridriver`. Enable
it once per machine:

```sh
sudo safaridriver --enable
```

Tests that take screenshots will trigger a one-time **Screen Recording**
permission prompt under *System Settings → Privacy & Security*. Grant it to
the terminal you launch `pnpm test:e2e` from, otherwise WebDriver screenshot
calls return a blank image.

If you prefer the standalone WebDriver shim ([Apple's
suggestion](https://developer.apple.com/documentation/webkit/testing-with-webdriver-in-safari)
for headless runs), install:

```sh
brew install --cask webdriver-safari
```

### Windows

Tauri uses WebView2 (Edge Chromium). Install the matching `msedgedriver.exe`
build — version must align with the installed Edge — from
<https://developer.microsoft.com/en-us/microsoft-edge/tools/webdriver/>. Drop
it on `PATH` (or in `%LocalAppData%\Microsoft\WebDriver\`).

```powershell
pnpm tauri build --debug
pnpm test:e2e
```

No headless wrapper required — Windows runners attach a real display.

## Known limitations

`tauri-driver` is significantly less mature than Playwright or Cypress:

- **No mobile / tablet emulation.** The native WebDriver runs against a real
  desktop window only.
- **No request interception.** Mocking network calls is out of scope; tests
  must drive the live IPC surface.
- **No multi-tab / multi-window automation** through a single session — each
  Tauri window needs its own driver instance.
- **`browser.url()` is a no-op** because the app shell is not navigable.
  Always anchor your specs on the initial render.
- **Screenshots on Linux** can return empty images if `xvfb-run` was not used
  or if the compositing env vars were not exported.

For anything beyond a smoke check, prefer a dedicated Rust integration test
against `vibe_term_lib` (see `tests/rust/`).

## Debugging

Set `logLevel: "debug"` in `wdio.conf.ts` to see the raw WebDriver wire traffic.
Spawn `tauri-driver` manually in another terminal to attach a debugger:

```sh
tauri-driver --port 4444
# in another shell:
pnpm test:e2e
```
