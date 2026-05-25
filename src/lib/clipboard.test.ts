import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// IMPORTANT: mock BEFORE importing the module under test so the module-level
// import resolves to our mock.
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn(),
  writeText: vi.fn(),
}));

import {
  readText as tauriReadText,
  writeText as tauriWriteText,
} from "@tauri-apps/plugin-clipboard-manager";

import { copyImageId, copyText, readText } from "./clipboard";

/* eslint-disable @typescript-eslint/no-explicit-any */

describe("clipboard helpers", () => {
  beforeEach(() => {
    vi.mocked(tauriReadText).mockReset();
    vi.mocked(tauriWriteText).mockReset();
    // Default: pretend Tauri is NOT injected so we exercise the fallback.
    delete (window as any).__TAURI_INTERNALS__;
    delete (window as any).__TAURI__;
    delete (window as any).__TAURI_IPC__;
    delete (window as any).isTauri;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses navigator.clipboard when Tauri is unavailable", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const ok = await copyText("hello");
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(tauriWriteText).not.toHaveBeenCalled();
  });

  it("prefers the Tauri path when available", async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    vi.mocked(tauriWriteText).mockResolvedValue(undefined);
    const navWrite = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText: navWrite } });

    const ok = await copyText("hi");
    expect(ok).toBe(true);
    expect(tauriWriteText).toHaveBeenCalledWith("hi");
    expect(navWrite).not.toHaveBeenCalled();
  });

  it("falls back to navigator.clipboard when Tauri rejects", async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    vi.mocked(tauriWriteText).mockRejectedValue(new Error("nope"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const ok = await copyText("retry");
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("retry");
    warn.mockRestore();
  });

  it("returns false when every backend fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const ok = await copyText("oops");
    expect(ok).toBe(false);
    warn.mockRestore();
  });

  it("returns null from readText when no backend works", async () => {
    vi.stubGlobal("navigator", { clipboard: undefined });
    const out = await readText();
    expect(out).toBeNull();
  });

  it("returns navigator.clipboard text in fallback mode", async () => {
    const readTextMock = vi.fn().mockResolvedValue("yo");
    vi.stubGlobal("navigator", { clipboard: { readText: readTextMock } });
    const out = await readText();
    expect(out).toBe("yo");
    expect(readTextMock).toHaveBeenCalled();
  });

  it("copyImageId is just a typed alias of copyText", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const ok = await copyImageId("img_abcdef");
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("img_abcdef");
  });
});
