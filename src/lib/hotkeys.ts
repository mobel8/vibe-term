// vibe-term — Window-level hotkey runtime.
//
// Two surfaces:
//   1. A pure parser/matcher (`parseCombo`, `matchEvent`, `formatCombo`) that
//      is environment-agnostic and trivially unit-testable.
//   2. A side-effectful `setupHotkeys` that wires a single `keydown` listener
//      to the window and dispatches matched actions to a user-supplied handler.
//
// On macOS we transparently map "Ctrl" combos to "Cmd" so cross-platform
// bindings ("Ctrl+Shift+T") feel native on every OS without forcing the user
// to maintain two binding tables. Callers can still express macOS-only combos
// explicitly by spelling out "Cmd"/"Meta".
//
// The OS detection is best-effort and cached: it consults the Tauri OS plugin
// when the runtime exposes it (production) and falls back to `navigator.userAgent`
// in non-Tauri contexts (vitest, dev preview).
//
// CAUTION: This module owns ZERO React state. The hotkeys store wraps it.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Combo {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  /** Normalised single-character key or named key (lowercased, e.g. "t", "f5", "arrowup"). */
  key: string;
}

// ───────────────────────── platform detection ─────────────────────────

let cachedIsMac: boolean | null = null;

/**
 * Best-effort macOS detection. Reads the Tauri OS plugin global if injected,
 * otherwise falls back to `navigator.userAgent`. Cached on first call.
 */
export function isMacPlatform(): boolean {
  if (cachedIsMac !== null) return cachedIsMac;
  // Tauri plugin-os exposes a synchronous global once the runtime loaded.
  if (typeof window !== "undefined") {
    const tauriOs = (window as any).__TAURI_OS_PLUGIN_INTERNALS__;
    if (tauriOs && typeof tauriOs.platform === "string") {
      cachedIsMac = tauriOs.platform === "macos";
      return cachedIsMac;
    }
  }
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent ?? "";
    cachedIsMac = /Mac|iPhone|iPad|iPod/i.test(ua);
    return cachedIsMac;
  }
  cachedIsMac = false;
  return cachedIsMac;
}

/** Test seam: reset the cached platform so unit tests can swap it freely. */
export function __resetPlatformCacheForTests(): void {
  cachedIsMac = null;
}

// ───────────────────────── parse / format ─────────────────────────

const MOD_ALIASES: Record<string, keyof Omit<Combo, "key">> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  opt: "alt",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  super: "meta",
  win: "meta",
};

// Display order is stable so `formatCombo(parseCombo(x))` round-trips.
const MOD_DISPLAY_ORDER: Array<{ key: keyof Omit<Combo, "key">; label: string }> = [
  { key: "ctrl", label: "Ctrl" },
  { key: "alt", label: "Alt" },
  { key: "shift", label: "Shift" },
  { key: "meta", label: "Meta" },
];

/**
 * Normalise a token coming either from a user-typed combo string or from a
 * `KeyboardEvent.key` value into the lowercase token we compare on.
 */
function normaliseKey(raw: string): string {
  const t = raw.trim().toLowerCase();
  // Common synonyms — keep the table tiny; we don't want to surprise users.
  if (t === "esc") return "escape";
  if (t === "return") return "enter";
  if (t === "space" || t === "spacebar" || t === " ") return "space";
  if (t === "del") return "delete";
  if (t === "ins") return "insert";
  if (t === "plus") return "+";
  return t;
}

/**
 * Parse a combo string like "Ctrl+Shift+T" or "Cmd+,". Case-insensitive and
 * forgiving of extra whitespace. Returns a normalised `Combo` object.
 *
 * Throws if no non-modifier key is supplied — a modifier-only combo would
 * fire on every shift press and is almost certainly a user error.
 */
export function parseCombo(spec: string): Combo {
  const out: Combo = {
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
    key: "",
  };
  // Split on "+" but tolerate a literal "+" key (the user wrote "Ctrl++" or
  // "Shift+Plus"): the empty trailing segment after a trailing "+" means the
  // last meaningful token is the "+" key itself.
  const parts = spec
    .split("+")
    .map((s) => s.trim())
    .filter((s, i, arr) => s.length > 0 || i === arr.length - 1);

  if (parts.length === 0 || parts.every((p) => p === "")) {
    // An all-empty spec ("", "  ", "+") has no real token: the trailing-"+"
    // branch below would otherwise mis-register it as a live "+" hotkey.
    throw new Error(`Invalid hotkey combo: ${JSON.stringify(spec)}`);
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "" && i === parts.length - 1) {
      // Trailing "+" → the literal plus key.
      out.key = "+";
      continue;
    }
    const lower = part.toLowerCase();
    const mod = MOD_ALIASES[lower];
    if (mod) {
      out[mod] = true;
    } else {
      out.key = normaliseKey(part);
    }
  }

  if (!out.key) {
    throw new Error(`Hotkey combo has no key: ${JSON.stringify(spec)}`);
  }

  return out;
}

/** Inverse of `parseCombo` — produces a canonical "Ctrl+Shift+T" string. */
export function formatCombo(combo: Combo): string {
  const parts: string[] = [];
  for (const m of MOD_DISPLAY_ORDER) {
    if (combo[m.key]) parts.push(m.label);
  }
  parts.push(displayKey(combo.key));
  return parts.join("+");
}

function displayKey(key: string): string {
  if (key.length === 1) return key.toUpperCase();
  // Title-case named keys ("arrowup" → "ArrowUp", "escape" → "Escape").
  if (key.startsWith("arrow") && key.length > 5) {
    return "Arrow" + key.charAt(5).toUpperCase() + key.slice(6);
  }
  return key.charAt(0).toUpperCase() + key.slice(1);
}

// ───────────────────────── matcher ─────────────────────────

/**
 * Translate a stored cross-platform combo into the effective combo for the
 * current OS. On macOS, "Ctrl" alone (without explicit "Meta") is rewritten
 * to "Meta" so users can keep a single binding table. We don't touch combos
 * that already use Meta — those are explicitly mac-aware.
 */
export function adaptComboForPlatform(combo: Combo): Combo {
  if (!isMacPlatform()) return combo;
  if (combo.ctrl && !combo.meta) {
    return { ...combo, ctrl: false, meta: true };
  }
  return combo;
}

/**
 * Compare a live KeyboardEvent against a combo. Modifier states must match
 * exactly (so "Ctrl+T" does not match "Ctrl+Shift+T"). The key comparison is
 * case-insensitive and tolerant of single-char vs. named key formats.
 */
export function matchEvent(event: KeyboardEvent, combo: Combo): boolean {
  const adapted = adaptComboForPlatform(combo);
  if (event.ctrlKey !== adapted.ctrl) return false;
  if (event.shiftKey !== adapted.shift) return false;
  if (event.altKey !== adapted.alt) return false;
  if (event.metaKey !== adapted.meta) return false;
  const eventKey = normaliseKey(event.key ?? "");
  if (eventKey === adapted.key) return true;
  // KeyboardEvent.key reflects the shifted value (e.g. "T" with Shift) on
  // some platforms; compare case-insensitively for single character keys.
  if (
    adapted.key.length === 1 &&
    eventKey.length === 1 &&
    eventKey.toLowerCase() === adapted.key.toLowerCase()
  ) {
    return true;
  }
  return false;
}

// ───────────────────────── runtime wiring ─────────────────────────

export type HotkeyHandler = (action: string, event: KeyboardEvent) => void;
export type Bindings = Record<string, string>;

interface ParsedBinding {
  action: string;
  combo: Combo;
}

/**
 * Attach a `keydown` listener that dispatches matched actions. Returns a
 * cleanup function that detaches the listener — keep it and call it on
 * unmount / re-init to avoid double-firing.
 *
 * Malformed combos are skipped with a console warning rather than crashing
 * the app; we'd rather lose one hotkey than block startup.
 */
export function setupHotkeys(
  bindings: Bindings,
  handler: HotkeyHandler,
): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const parsed: ParsedBinding[] = [];
  for (const [action, spec] of Object.entries(bindings)) {
    if (!spec) continue;
    try {
      parsed.push({ action, combo: parseCombo(spec) });
    } catch (err) {
       
      console.warn(`[hotkeys] skipping invalid combo for "${action}":`, err);
    }
  }

  const onKeydown = (event: KeyboardEvent) => {
    for (const { action, combo } of parsed) {
      if (matchEvent(event, combo)) {
        event.preventDefault();
        event.stopPropagation();
        handler(action, event);
        return;
      }
    }
  };

  window.addEventListener("keydown", onKeydown);
  return () => {
    window.removeEventListener("keydown", onKeydown);
  };
}
