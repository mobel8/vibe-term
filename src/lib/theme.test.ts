import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { XTERM_THEMES, THEMES, isThemeName } from "../styles/themes";
import { applyTheme, flipTheme, resolveTheme, SYSTEM_THEME } from "./theme";

// Minimal matchMedia mock — jsdom does not implement it natively. We expose a
// helper so individual tests can flip the dark/light response per scenario.
function installMatchMedia(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("applyTheme", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  it("sets the data-theme attribute on the document root", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    applyTheme("dracula");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dracula");
  });

  it("does not re-write the attribute when value is unchanged", () => {
    applyTheme("nord");
    const setAttr = vi.spyOn(document.documentElement, "setAttribute");
    applyTheme("nord");
    expect(setAttr).not.toHaveBeenCalled();
    setAttr.mockRestore();
  });
});

describe("XTERM_THEMES", () => {
  it("defines an entry for every theme name", () => {
    for (const name of THEMES) {
      expect(XTERM_THEMES[name]).toBeDefined();
    }
  });

  it("dark theme background matches the CSS variable hex used by --vt-bg", () => {
    // This value MUST stay in sync with src/styles/themes/dark.css `--vt-bg`.
    expect(XTERM_THEMES.dark.background).toBe("#0a0a0b");
    expect(XTERM_THEMES.dark.foreground).toBe("#e4e4e7");
    expect(XTERM_THEMES.dark.cursor).toBe("#7c93ff");
  });

  it("every theme exposes the 16 ANSI colors plus background/foreground/cursor", () => {
    const requiredKeys: Array<keyof (typeof XTERM_THEMES)["dark"]> = [
      "background",
      "foreground",
      "cursor",
      "cursorAccent",
      "selectionBackground",
      "black",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
      "brightBlack",
      "brightRed",
      "brightGreen",
      "brightYellow",
      "brightBlue",
      "brightMagenta",
      "brightCyan",
      "brightWhite",
    ];
    for (const name of THEMES) {
      const theme = XTERM_THEMES[name];
      for (const key of requiredKeys) {
        expect(theme[key], `${name}.${String(key)}`).toMatch(/^(#|rgb)/);
      }
    }
  });
});

describe("resolveTheme + isThemeName", () => {
  it("returns dark when system preference matches dark", () => {
    installMatchMedia(true);
    expect(resolveTheme(SYSTEM_THEME)).toBe("dark");
  });

  it("returns light when system preference matches light", () => {
    installMatchMedia(false);
    expect(resolveTheme(SYSTEM_THEME)).toBe("light");
  });

  it("falls back to dark for unknown / null preferences", () => {
    expect(resolveTheme(null)).toBe("dark");
    expect(resolveTheme(undefined)).toBe("dark");
    expect(resolveTheme("zomg-not-a-theme")).toBe("dark");
  });

  it("preserves known theme names as-is", () => {
    expect(resolveTheme("dracula")).toBe("dracula");
    expect(resolveTheme("nord")).toBe("nord");
    expect(resolveTheme("tokyo-night")).toBe("tokyo-night");
  });

  it("flipTheme toggles between light and dark families", () => {
    expect(flipTheme("dark")).toBe("light");
    expect(flipTheme("dracula")).toBe("light");
    expect(flipTheme("nord")).toBe("light");
    expect(flipTheme("tokyo-night")).toBe("light");
    expect(flipTheme("light")).toBe("dark");
  });

  it("isThemeName narrows to the THEMES union", () => {
    expect(isThemeName("dark")).toBe(true);
    expect(isThemeName("tokyo-night")).toBe(true);
    expect(isThemeName("system")).toBe(false);
    expect(isThemeName(42)).toBe(false);
  });
});
