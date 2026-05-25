/**
 * E2E smoke test: launch the packaged vibe-term binary, verify the React UI
 * renders, and confirm the Tauri IPC bridge responds to `ping` / `app_info`.
 *
 * Run with:
 *   pnpm test:e2e
 *
 * The browser global is injected by @wdio/cli at runtime; we only need to import
 * the matchers from `@wdio/globals` / `expect-webdriverio` when stricter assertions
 * are desired. For this smoke we stick to `assert` from Node to keep the dependency
 * surface minimal.
 */

import { strict as assert } from "node:assert";

interface PingInvoker {
  invoke(cmd: "ping"): Promise<string>;
  invoke(cmd: "app_info"): Promise<{
    name: string;
    version: string;
    target_os: string;
    target_arch: string;
  }>;
}

declare global {
  interface Window {
    __TAURI__?: {
      core?: PingInvoker;
      invoke?: PingInvoker["invoke"];
    };
    __TAURI_INTERNALS__?: {
      invoke: PingInvoker["invoke"];
    };
  }
}

describe("vibe-term smoke", () => {
  it("renders the hero h1 with the product name", async () => {
    // The hero is only shown on first launch (no sessions yet). The freshly-built
    // binary starts with an empty store, so the hero h1 should always be visible.
    const heading = await browser.$("h1");
    await heading.waitForDisplayed({ timeout: 30_000 });
    const text = await heading.getText();
    assert.equal(text.trim(), "vibe-term", `unexpected hero heading: ${text}`);
  });

  it("responds to the `ping` IPC command with \"pong\"", async () => {
    const result = await browser.executeAsync<string, []>((done) => {
      // Tauri v2 exposes `invoke` under two paths depending on the build mode:
      //   - `window.__TAURI__.core.invoke` (when the JS API bindings are loaded)
      //   - `window.__TAURI_INTERNALS__.invoke` (always present, lower-level)
      const w = window as unknown as Window;
      const invoke =
        w.__TAURI__?.core?.invoke ??
        w.__TAURI__?.invoke ??
        w.__TAURI_INTERNALS__?.invoke;
      if (!invoke) {
        done("__missing_invoke__");
        return;
      }
      Promise.resolve(invoke("ping"))
        .then((r) => done(String(r)))
        .catch((e) => done(`__error__:${String(e)}`));
    });

    assert.equal(result, "pong", `expected "pong", got: ${result}`);
  });

  it("returns the expected metadata from the `app_info` IPC command", async () => {
    const result = await browser.executeAsync<
      { name?: string; version?: string; target_os?: string; target_arch?: string; error?: string },
      []
    >((done) => {
      const w = window as unknown as Window;
      const invoke =
        w.__TAURI__?.core?.invoke ??
        w.__TAURI__?.invoke ??
        w.__TAURI_INTERNALS__?.invoke;
      if (!invoke) {
        done({ error: "missing_invoke" });
        return;
      }
      Promise.resolve(invoke("app_info"))
        .then((r) => done(r as { name: string; version: string; target_os: string; target_arch: string }))
        .catch((e) => done({ error: String(e) }));
    });

    assert.equal(result.error, undefined, `app_info errored: ${result.error}`);
    assert.equal(result.name, "vibe-term", `unexpected name: ${result.name}`);
    assert.ok(
      typeof result.version === "string" && result.version.length > 0,
      `version should be a non-empty string, got: ${JSON.stringify(result.version)}`,
    );
    assert.ok(
      ["linux", "macos", "windows"].includes(result.target_os ?? ""),
      `unexpected target_os: ${result.target_os}`,
    );
  });
});
