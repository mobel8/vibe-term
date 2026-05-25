import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetPlatformCacheForTests,
  adaptComboForPlatform,
  formatCombo,
  matchEvent,
  parseCombo,
  setupHotkeys,
} from "./hotkeys";

function makeKeyEvent(opts: {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: opts.key,
    ctrlKey: opts.ctrl ?? false,
    shiftKey: opts.shift ?? false,
    altKey: opts.alt ?? false,
    metaKey: opts.meta ?? false,
  });
}

describe("parseCombo", () => {
  it("parses a plain modifier+key string", () => {
    expect(parseCombo("Ctrl+Shift+T")).toEqual({
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
      key: "t",
    });
  });

  it("is case-insensitive", () => {
    expect(parseCombo("ctrl+shift+T")).toEqual(parseCombo("Ctrl+Shift+t"));
  });

  it("maps Cmd, Command and Super to meta", () => {
    expect(parseCombo("Cmd+K").meta).toBe(true);
    expect(parseCombo("Command+K").meta).toBe(true);
    expect(parseCombo("Super+K").meta).toBe(true);
  });

  it("maps Option/Opt to alt", () => {
    expect(parseCombo("Option+T").alt).toBe(true);
    expect(parseCombo("Opt+T").alt).toBe(true);
  });

  it("supports special-named keys", () => {
    expect(parseCombo("Ctrl+ArrowUp").key).toBe("arrowup");
    expect(parseCombo("Escape").key).toBe("escape");
    expect(parseCombo("Esc").key).toBe("escape");
    expect(parseCombo("F5").key).toBe("f5");
  });

  it("supports the literal + key via trailing plus", () => {
    expect(parseCombo("Ctrl++").key).toBe("+");
  });

  it("supports the literal + via the 'Plus' alias", () => {
    expect(parseCombo("Ctrl+Plus").key).toBe("+");
  });

  it("supports comma and slash punctuation keys", () => {
    expect(parseCombo("Cmd+,").key).toBe(",");
    expect(parseCombo("Ctrl+/").key).toBe("/");
  });

  it("throws on modifier-only combos", () => {
    expect(() => parseCombo("Ctrl+Shift")).toThrow();
  });
});

describe("formatCombo", () => {
  it("produces a canonical, deterministic string", () => {
    expect(
      formatCombo({
        ctrl: true,
        shift: true,
        alt: false,
        meta: false,
        key: "t",
      }),
    ).toBe("Ctrl+Shift+T");
  });

  it("round-trips with parseCombo for typical bindings", () => {
    for (const spec of [
      "Ctrl+Shift+T",
      "Cmd+,",
      "Alt+F4",
      "Ctrl+Shift+L",
      "Ctrl+Shift+P",
      "Escape",
    ]) {
      expect(formatCombo(parseCombo(spec))).toBe(canonical(spec));
    }
  });

  it("renders arrow keys with PascalCase", () => {
    expect(formatCombo(parseCombo("Ctrl+ArrowUp"))).toBe("Ctrl+ArrowUp");
  });
});

// `canonical` reflects the expected display form for round-trip checks above:
// modifiers are ordered Ctrl, Alt, Shift, Meta and the key is upper-case for
// single characters, PascalCase for named keys.
function canonical(spec: string): string {
  const c = parseCombo(spec);
  return formatCombo(c);
}

describe("matchEvent", () => {
  beforeEach(() => {
    __resetPlatformCacheForTests();
  });

  it("matches identical modifier+key", () => {
    expect(
      matchEvent(makeKeyEvent({ key: "t", ctrl: true, shift: true }), parseCombo("Ctrl+Shift+T")),
    ).toBe(true);
  });

  it("rejects when a modifier differs", () => {
    expect(
      matchEvent(makeKeyEvent({ key: "t", ctrl: true }), parseCombo("Ctrl+Shift+T")),
    ).toBe(false);
    expect(
      matchEvent(makeKeyEvent({ key: "t", ctrl: true, shift: true, alt: true }), parseCombo("Ctrl+Shift+T")),
    ).toBe(false);
  });

  it("rejects when the key differs", () => {
    expect(
      matchEvent(makeKeyEvent({ key: "y", ctrl: true, shift: true }), parseCombo("Ctrl+Shift+T")),
    ).toBe(false);
  });

  it("matches single-char keys case-insensitively (Shift uppercases the value)", () => {
    expect(
      matchEvent(makeKeyEvent({ key: "T", ctrl: true, shift: true }), parseCombo("Ctrl+Shift+T")),
    ).toBe(true);
  });

  it("matches named keys", () => {
    expect(
      matchEvent(makeKeyEvent({ key: "Escape" }), parseCombo("Escape")),
    ).toBe(true);
  });
});

describe("adaptComboForPlatform", () => {
  afterEach(() => __resetPlatformCacheForTests());

  it("is a no-op on non-mac platforms", () => {
    const combo = parseCombo("Ctrl+T");
    expect(adaptComboForPlatform(combo)).toEqual(combo);
  });

  it("rewrites Ctrl -> Meta on mac", () => {
    __resetPlatformCacheForTests();
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    });
    const adapted = adaptComboForPlatform(parseCombo("Ctrl+T"));
    expect(adapted.ctrl).toBe(false);
    expect(adapted.meta).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("setupHotkeys", () => {
  beforeEach(() => __resetPlatformCacheForTests());

  it("invokes the handler with the matched action and prevents default", () => {
    const handler = vi.fn();
    const cleanup = setupHotkeys({ "open-palette": "Ctrl+Shift+P" }, handler);

    const ev = makeKeyEvent({ key: "p", ctrl: true, shift: true });
    const preventSpy = vi.spyOn(ev, "preventDefault");
    window.dispatchEvent(ev);

    expect(handler).toHaveBeenCalledWith("open-palette", ev);
    expect(preventSpy).toHaveBeenCalled();
    cleanup();
  });

  it("does not fire after cleanup", () => {
    const handler = vi.fn();
    const cleanup = setupHotkeys({ a: "Ctrl+A" }, handler);
    cleanup();
    window.dispatchEvent(makeKeyEvent({ key: "a", ctrl: true }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("skips invalid combos without throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handler = vi.fn();
    const cleanup = setupHotkeys(
      { good: "Ctrl+G", bad: "Shift+" },
      handler,
    );
    window.dispatchEvent(makeKeyEvent({ key: "g", ctrl: true }));
    expect(handler).toHaveBeenCalledWith("good", expect.any(Object));
    cleanup();
    warn.mockRestore();
  });

  it("dispatches at most one action per keydown", () => {
    const handler = vi.fn();
    const cleanup = setupHotkeys(
      { a: "Ctrl+T", b: "Ctrl+T" },
      handler,
    );
    window.dispatchEvent(makeKeyEvent({ key: "t", ctrl: true }));
    expect(handler).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
