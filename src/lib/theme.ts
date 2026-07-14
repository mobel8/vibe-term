// vibe-term — Theme runtime.
//
// Responsibilities:
//   1. Eager-load every theme stylesheet so all `:root[data-theme="…"]` blocks
//      live in the document at boot. Switching themes is then a single DOM
//      attribute write — no flash, no `<link>` race, no dynamic import latency.
//   2. Expose `applyTheme(name)` for any non-React caller (e.g. early bootstrap
//      script that wants to honor `localStorage` before React mounts).
//   3. Provide `useTheme()` that wires the current theme to backend config:
//        - reads `appearance.theme` from `config_get` at mount,
//        - listens to `config://changed` for live updates from elsewhere,
//        - resolves the magic "system" value against `prefers-color-scheme`,
//        - calls `config_update` when `setTheme` is invoked.
//
// We import the .css side-effect files eagerly (5 small files, ~5 KB total).
// This trades a few hundred bytes for guaranteed instant switches and avoids
// the `noUncheckedSideEffectImports` tsconfig gotcha that bites dynamic CSS
// imports under bundler resolution.

import { useCallback, useEffect, useRef, useState } from "react";

import { config, on, CONFIG_CHANGED } from "../ipc";
import type { Settings } from "../ipc/types";
import {
  DARK_THEMES,
  DEFAULT_THEME,
  XTERM_THEMES,
  isThemeName,
  type ThemeName,
} from "../styles/themes";
import { getAllTerms } from "./terminal-registry";

// Side-effect imports — Vite collects these into the global CSS bundle so every
// theme's variable block is present from frame 1. The bundler treats `.css`
// imports as having known side effects, so the strict-flag is satisfied.
import "../styles/themes/dark.css";
import "../styles/themes/light.css";
import "../styles/themes/dracula.css";
import "../styles/themes/nord.css";
import "../styles/themes/tokyo-night.css";

/** Special non-theme value persisted in config: follow the OS preference. */
export const SYSTEM_THEME = "system" as const;
export type ThemePreference = ThemeName | typeof SYSTEM_THEME;

const PREFERS_DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Resolve a stored preference (which may be "system" or an unknown legacy
 * value) into a concrete theme that exists in `THEMES`.
 */
export function resolveTheme(pref: ThemePreference | string | null | undefined): ThemeName {
  if (pref === SYSTEM_THEME) {
    if (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(PREFERS_DARK_QUERY).matches
    ) {
      return "dark";
    }
    return "light";
  }
  if (isThemeName(pref)) return pref;
  return DEFAULT_THEME;
}

/**
 * Imperatively switch the document theme. Safe to call from any context
 * (including outside React) — only touches the document root attribute.
 */
export function applyTheme(name: ThemeName): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // Skip the write when nothing changed: avoids a forced style recalc on every
  // config event roundtrip.
  if (root.getAttribute("data-theme") === name) return;
  root.setAttribute("data-theme", name);
  // xterm paints from its own options — CSS variables don't reach the canvas.
  // Push the matching palette to every live terminal so the theme picker (and
  // the "system" preference) actually recolors the terminal, not just the
  // chrome. Terminals created later self-serve from data-theme at creation.
  const palette = XTERM_THEMES[name];
  if (palette) {
    for (const term of getAllTerms().values()) {
      term.options.theme = { ...palette };
    }
  }
}

/**
 * Toggle helper bound to `Ctrl+Shift+L` — flips light↔dark and otherwise stays
 * on the user's chosen palette. Returns the new theme so the caller can fire
 * any side effects (e.g. update an indicator before the round-trip completes).
 */
export function flipTheme(current: ThemeName): ThemeName {
  return DARK_THEMES.has(current) ? "light" : "dark";
}

export interface UseThemeResult {
  /** The currently applied (resolved) theme. */
  theme: ThemeName;
  /** The raw preference as stored in config — may equal "system". */
  preference: ThemePreference | string;
  /** Whether the initial config fetch has resolved. */
  ready: boolean;
  /** Update both local + persisted preference. */
  setTheme: (next: ThemePreference) => Promise<void>;
  /** Toggle light/dark (used by Ctrl+Shift+L). */
  toggleTheme: () => Promise<void>;
}

/**
 * React hook: keeps the document `data-theme` attribute in sync with the
 * backend `appearance.theme` setting and with the OS preference (when the user
 * picked "system"). Strict-mode safe: all subscriptions are torn down in their
 * cleanup branches.
 */
export function useTheme(): UseThemeResult {
  const [preference, setPreferenceState] = useState<ThemePreference | string>(DEFAULT_THEME);
  const [theme, setThemeState] = useState<ThemeName>(DEFAULT_THEME);
  const [ready, setReady] = useState(false);
  // Track the latest preference for matchMedia callback (avoids stale closure).
  const preferenceRef = useRef<ThemePreference | string>(DEFAULT_THEME);

  const applyResolved = useCallback((pref: ThemePreference | string) => {
    const resolved = resolveTheme(pref);
    preferenceRef.current = pref;
    setPreferenceState(pref);
    setThemeState(resolved);
    applyTheme(resolved);
  }, []);

  // 1) Initial fetch from backend config.
  useEffect(() => {
    let cancelled = false;
    config
      .get()
      .then((settings: Settings) => {
        if (cancelled) return;
        applyResolved(settings.appearance.theme);
      })
      .catch((err) => {
        // Don't block the UI on a missing/early backend — keep the default.
        console.warn("[theme] failed to read config; using default:", err);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [applyResolved]);

  // 2) Listen for config changes pushed by the backend (file watcher, other
  //    windows, etc.) so live edits to `config.toml` propagate immediately.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    on(CONFIG_CHANGED, (payload) => {
      if (cancelled) return;
      applyResolved(payload.settings.appearance.theme);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) => {
        console.warn("[theme] failed to subscribe to config changes:", err);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applyResolved]);

  // 3) Follow the OS color-scheme when the user picked "system".
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia(PREFERS_DARK_QUERY);
    const handler = () => {
      if (preferenceRef.current === SYSTEM_THEME) {
        applyResolved(SYSTEM_THEME);
      }
    };
    // Older Safari only supports `addListener`; modern browsers prefer
    // `addEventListener`. Use a feature check to stay portable.
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, [applyResolved]);

  const setTheme = useCallback(
    async (next: ThemePreference) => {
      // Optimistic local apply first so the UI reacts within the same frame,
      // then persist. If the backend write fails we keep the local state —
      // the user already saw the change and the next config event will
      // reconcile.
      applyResolved(next);
      try {
        await config.update({ appearance: { theme: next } });
      } catch (err) {
        console.error("[theme] failed to persist theme:", err);
      }
    },
    [applyResolved],
  );

  const toggleTheme = useCallback(async () => {
    await setTheme(flipTheme(resolveTheme(preferenceRef.current)));
  }, [setTheme]);

  return { theme, preference, ready, setTheme, toggleTheme };
}
