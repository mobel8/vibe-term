// vibe-term — SettingsPanel smoke test.
//
// We don't have @testing-library installed yet, so we drive the component
// through React's own createRoot + the standard `act` from `react-dom/test-utils`.
// The goal is to prove:
//   1. The panel mounts when `open` and writes the dialog into the DOM.
//   2. It is fully unmounted when `open` flips to false.
//   3. The configStore's `defaultSettings()` helper produces a tree shaped
//      like the `Settings` contract the panel relies on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { defaultSettings, useConfigStore } from "@/state/configStore";

// Stub the IPC invoke layer so the component can call `config.get/path` and
// `pty.listShells` without a Tauri runtime.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    switch (cmd) {
      case "config_get":
        return defaultSettings();
      case "config_path":
        return "/tmp/vibe-term/config.toml";
      case "detect_shells":
        return [];
      case "ai_has_api_key":
        return false;
      case "app_info":
        return {
          name: "vibe-term",
          version: "0.0.0-test",
          targetOs: "linux",
          targetArch: "x86_64",
        };
      default:
        return null;
    }
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

import { SettingsPanel } from "./SettingsPanel";

describe("SettingsPanel (smoke)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // Reset zustand state between tests so the load() guard re-runs.
    useConfigStore.setState({
      settings: null,
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders nothing when closed", () => {
    act(() => {
      root.render(<SettingsPanel open={false} onClose={() => undefined} />);
    });
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });

  it("renders the modal dialog when open and shows the title", async () => {
    act(() => {
      root.render(<SettingsPanel open={true} onClose={() => undefined} />);
    });
    // Allow the hydration `await config.get()` microtask + setState to flush.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const dialog = document.querySelector("[role='dialog']");
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent ?? "").toContain("Settings");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
  });

  it("invokes onClose when the close button is clicked", async () => {
    const onClose = vi.fn();
    act(() => {
      root.render(<SettingsPanel open={true} onClose={onClose} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const closeBtn = document.querySelector<HTMLButtonElement>(
      "[aria-label='Close settings']",
    );
    expect(closeBtn).not.toBeNull();
    act(() => {
      closeBtn?.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("defaultSettings", () => {
  it("returns a Settings tree with all five top-level keys", () => {
    const s = defaultSettings();
    expect(Object.keys(s).sort()).toEqual(
      ["ai", "appearance", "general", "hotkeys", "terminal"].sort(),
    );
    expect(s.appearance.theme).toBe("dark");
    expect(s.ai.provider).toBe("anthropic");
    expect(typeof s.hotkeys["palette.open"]).toBe("string");
  });
});
