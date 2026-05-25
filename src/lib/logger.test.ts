import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// IMPORTANT: stub `@tauri-apps/plugin-log` BEFORE importing the module under
// test, so the lazy `await import(...)` inside the logger resolves to our
// mock. Vitest hoists `vi.mock` calls automatically, so this works even
// though `logger.ts` lives below the mock. Hoisted helpers keep the const
// declarations TDZ-safe.
const { tauriWarn, tauriError } = vi.hoisted(() => ({
  tauriWarn: vi.fn(async (_message: string) => undefined),
  tauriError: vi.fn(async (_message: string) => undefined),
}));

vi.mock("@tauri-apps/plugin-log", () => ({
  warn: tauriWarn,
  error: tauriError,
  info: vi.fn(async (_message: string) => undefined),
  debug: vi.fn(async (_message: string) => undefined),
  trace: vi.fn(async (_message: string) => undefined),
}));

import {
  configureLogger,
  getLoggerConfig,
  logger,
  _resetBackendSinks,
} from "./logger";

/**
 * Yield to the microtask queue several times so any chained
 * `Promise.then(...)` callbacks (notably the lazy `await import(...)` inside
 * the logger's backend-sink resolution) have a chance to run before we
 * assert on the spies.
 */
async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
  // One macro-task hop too, for cases where the runner sneaks a
  // setTimeout(0) into the IPC plumbing.
  await new Promise((r) => setTimeout(r, 0));
}

describe("logger", () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    tauriWarn.mockClear();
    tauriError.mockClear();
    _resetBackendSinks();
    // Default each test to DEV-mode so all levels flow through unless the
    // test opts into prod-mode explicitly.
    configureLogger({ dev: true, threshold: "debug" });
  });

  afterEach(() => {
    debugSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("emits every level when threshold=debug", () => {
    logger.debug("pty", "hello");
    logger.info("pty", "hello");
    logger.warn("pty", "hello");
    logger.error("pty", "hello");
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("formats lines with the [scope] prefix and the structured meta payload", () => {
    logger.info("pty", "spawned", { id: "abc", cols: 80 });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const line = infoSpy.mock.calls[0]?.[0] as string;
    expect(line).toMatch(/^\[pty\] spawned/);
    expect(line).toContain('"id":"abc"');
    expect(line).toContain('"cols":80');
  });

  it("omits the JSON suffix when meta is absent or empty", () => {
    logger.info("pty", "ready");
    logger.info("pty", "ready", {});
    expect(infoSpy.mock.calls[0]?.[0]).toBe("[pty] ready");
    expect(infoSpy.mock.calls[1]?.[0]).toBe("[pty] ready");
  });

  it("filters everything below the threshold (prod-mode silence)", () => {
    configureLogger({ dev: false, threshold: "warn" });
    logger.debug("pty", "verbose");
    logger.info("pty", "chatter");
    logger.warn("pty", "careful");
    logger.error("pty", "oh no");
    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("getLoggerConfig reflects the latest configureLogger call", () => {
    configureLogger({ dev: false, threshold: "error" });
    expect(getLoggerConfig()).toEqual({ dev: false, threshold: "error" });
  });

  it("forwards warn/error to the backend log plugin", async () => {
    logger.warn("ipc", "slow rpc", { ms: 200 });
    logger.error("ipc", "fatal", { code: 1 });
    // The lazy `await import(...)` inside the logger queues several
    // microtasks before our spies are touched; flush them deterministically.
    await flushMicrotasks();
    expect(tauriWarn).toHaveBeenCalledTimes(1);
    expect(tauriError).toHaveBeenCalledTimes(1);
    expect(tauriWarn.mock.calls[0]?.[0]).toContain("[ipc] slow rpc");
    expect(tauriError.mock.calls[0]?.[0]).toContain("[ipc] fatal");
  });

  it("does NOT forward debug/info to the backend log plugin", async () => {
    logger.debug("ipc", "noise");
    logger.info("ipc", "noise");
    await flushMicrotasks();
    expect(tauriWarn).not.toHaveBeenCalled();
    expect(tauriError).not.toHaveBeenCalled();
  });

  it("never throws when the backend plugin rejects", async () => {
    tauriError.mockRejectedValueOnce(new Error("ipc down"));
    expect(() => logger.error("net", "kaboom")).not.toThrow();
    await flushMicrotasks();
    // We expect no escalation; the console call still happened.
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("serialises Error objects in the meta payload", () => {
    const err = new Error("boom");
    logger.error("net", "request failed", { err });
    const line = errorSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain('"message":"boom"');
    expect(line).toContain('"name":"Error"');
  });

  it("does not crash on circular meta", () => {
    const root: Record<string, unknown> = { name: "root" };
    root.self = root;
    expect(() => logger.warn("scope", "msg", root)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
