/**
 * WebdriverIO configuration for vibe-term end-to-end tests driven by tauri-driver.
 *
 * tauri-driver is a small shim that spawns the OS-native WebDriver implementation
 * required by the Tauri window (WebKitGTK on Linux, WebView2 on Windows, WKWebView
 * on macOS) and proxies WebDriver commands to it. We talk to tauri-driver as if it
 * were any other WebDriver endpoint.
 *
 * Running this config:
 *   pnpm test:e2e              # invokes `wdio run tests/e2e/wdio.conf.ts`
 *
 * Pre-requisites (per-OS): see tests/e2e/README.md.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { platform } from "node:os";
import type { Options } from "@wdio/types";

const PROJECT_ROOT = resolve(__dirname, "..", "..");
const TARGET_DIR = join(PROJECT_ROOT, "src-tauri", "target");

/**
 * Resolve the freshly-built Tauri binary for the current OS.
 *
 * We prefer the `--debug` build because it is significantly faster to compile
 * in CI, but fall back to `release` when only a release build is available.
 */
function resolveAppBinary(): string {
  const os = platform();
  const binaryName = os === "win32" ? "vibe-term.exe" : "vibe-term";

  const candidates = [
    join(TARGET_DIR, "debug", binaryName),
    join(TARGET_DIR, "release", binaryName),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not find a vibe-term binary. Run \`pnpm tauri build --debug\` first.\n` +
      `Looked in:\n  ${candidates.join("\n  ")}`,
  );
}

let tauriDriver: ChildProcess | undefined;

const isLinux = platform() === "linux";

export const config: Options.Testrunner = {
  runner: "local",
  framework: "mocha",
  reporters: ["spec"],

  specs: ["./specs/**/*.spec.ts"],
  maxInstances: 1,

  logLevel: "info",
  bail: 0,
  waitforTimeout: 30_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,

  // tauri-driver listens on 4444 by default. We do not register `services: ['tauri']`
  // here because the official tauri WDIO service is still pre-1.0 — we spawn the
  // driver ourselves in onPrepare / onComplete to stay portable across versions.
  hostname: "127.0.0.1",
  port: 4444,
  path: "/",

  capabilities: [
    {
      maxInstances: 1,
      // The `tauri:options` capability is consumed by tauri-driver and tells it
      // which native binary to launch. Anything else under this object is forwarded
      // to the underlying WebDriver implementation (webkit2gtk-driver / msedgedriver).
      "tauri:options": {
        application: resolveAppBinary(),
      },
      // browserName is required by the WebdriverIO type checker but ignored by
      // tauri-driver — any non-empty string works.
      browserName: "wry",
    } as WebdriverIO.Capabilities,
  ],

  mochaOpts: {
    ui: "bdd",
    timeout: 60_000,
    retries: 1,
  },

  /**
   * Spawn tauri-driver before the first test runs.
   *
   * On Linux we also export the WebKit env vars that disable hardware-accelerated
   * compositing — these crash inside Xvfb / headless CI runners. Without them the
   * window never paints and every selector times out.
   */
  onPrepare(_config, _capabilities) {
    if (isLinux) {
      process.env.WEBKIT_DISABLE_DMABUF_RENDERER = "1";
      process.env.WEBKIT_DISABLE_COMPOSITING_MODE = "1";
    }

    tauriDriver = spawn("tauri-driver", [], {
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
    });

    tauriDriver.on("error", (err) => {
       
      console.error(
        "[wdio] failed to spawn tauri-driver — is it installed? " +
          "`cargo install tauri-driver --locked`\n",
        err,
      );
    });
  },

  /**
   * Kill tauri-driver once the suite ends, regardless of pass/fail.
   */
  onComplete(_exitCode, _config, _capabilities) {
    tauriDriver?.kill();
    tauriDriver = undefined;
  },
};
