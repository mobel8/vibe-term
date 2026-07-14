// vibe-term — Settings (config) Zustand store.
//
// Responsibilities:
//   1. Hold the latest in-memory copy of `Settings` after the first fetch.
//   2. Hydrate from `config.get()` on demand (`load()`); subsequent calls are
//      no-ops while a fetch is already in flight.
//   3. Subscribe to the backend `config://changed` event so live edits to
//      `config.toml` (from another window or by hand) propagate to the UI
//      without polling.
//   4. Provide `update(patch)` that delegates to `config.update` and trusts the
//      server's returned `Settings` as the new source of truth.
//   5. Provide `reset()` that pushes a known default tree to the backend (used
//      by the AdvancedTab "Reset to defaults" button).
//
// The store deliberately does NOT auto-load on import — the App owns the
// hydration call so we can sequence it with other startup work and surface
// errors deterministically.

import { create } from "zustand";

import { CONFIG_CHANGED, config, on } from "@/ipc";
import type { Settings } from "@/ipc";

/** Sensible factory defaults — mirrors what the Rust `Config::default()` ships. */
export function defaultSettings(): Settings {
  return {
    general: {
      defaultShell: null,
      workingDirectory: null,
      scrollbackLines: 10_000,
      confirmOnClose: true,
    },
    appearance: {
      theme: "dark",
      fontFamily: "JetBrains Mono",
      fontSize: 13,
      // 1.0 matches the long-shipped rendering (values >1 are also clamped at
      // runtime under WebGL + fractional DPR to avoid glyph residue).
      lineHeight: 1.0,
      cursorStyle: "block",
      cursorBlink: true,
    },
    // MUST mirror the backend canon (src-tauri/src/config/schema.rs::default_hotkeys)
    // EXACTLY — same snake_case action ids AND same accelerators. The runtime
    // handler registry (Layout.tsx) + the backend hotkey emitter both dispatch
    // these snake_case ids; the old dotted ids ("tab.new", "palette.open", …)
    // had NO registered handler, so every config-driven / rebindable shortcut
    // silently no-op'd and `reset()` corrupted the persisted hotkey map.
    hotkeys: {
      new_tab: "Ctrl+T",
      close_tab: "Ctrl+W",
      // Canon: D = horizontal/side-by-side, E = vertical/stacked — matching
      // the hero text, the palette and the split semantics. Older configs
      // with the exact swapped pair are migrated in normalizeBindings().
      split_horizontal: "Ctrl+Shift+D",
      split_vertical: "Ctrl+Shift+E",
      toggle_ai_panel: "Ctrl+I",
      search_history: "Ctrl+R",
      screenshot_region: "Ctrl+Alt+S",
      screenshot_full: "Ctrl+Alt+F",
      command_palette: "Ctrl+K",
      open_settings: "Ctrl+,",
    },
    ai: {
      provider: "anthropic",
      model: "claude-opus-4-7",
      maxContextBlocks: 5,
      autoSummarizeThresholdTokens: 150_000,
    },
    terminal: {
      // Mirrors the Rust factory default (schema.rs) — this used to say
      // `false`, so "Reset to defaults" silently turned the bell off.
      bell: true,
      copyOnSelect: false,
      rightClickPaste: true,
    },
  };
}

/**
 * Merge persisted hotkeys over the factory canon (so actions ADDED in newer
 * builds — e.g. `open_settings` — get a binding even for configs written
 * before they existed) and migrate the one known-bad legacy default: builds
 * up to 2026-07 shipped `split_horizontal`/`split_vertical` swapped relative
 * to what the shortcuts actually did. Only the EXACT legacy pair is swapped,
 * so genuine user customisations are preserved.
 */
export function normalizeBindings(
  persisted: Record<string, string> | undefined,
): Record<string, string> {
  const merged = { ...defaultSettings().hotkeys, ...(persisted ?? {}) };
  if (
    merged.split_horizontal === "Ctrl+Shift+E" &&
    merged.split_vertical === "Ctrl+Shift+D"
  ) {
    merged.split_horizontal = "Ctrl+Shift+D";
    merged.split_vertical = "Ctrl+Shift+E";
  }
  return merged;
}

export interface ConfigState {
  settings: Settings | null;
  isLoading: boolean;
  error: string | null;
  /** Idempotent: only triggers a fetch if not already loaded / loading. */
  load: () => Promise<void>;
  /** Sends a JSON patch (deep-merged on the backend) and stores the result. */
  update: (patch: Partial<Settings>) => Promise<void>;
  /** Pushes the factory defaults back to the backend. */
  reset: () => Promise<void>;
  /** Optional subscription teardown — exposed so tests can be deterministic. */
  _stopListening: () => void;
}

let unlisten: (() => void) | undefined;
let listening = false;
let listenPromise: Promise<void> | undefined;
let loadPromise: Promise<void> | undefined;

/**
 * Idempotently attach the `config://changed` subscription. Guarded by
 * `listening` so it can be re-attempted on a later `load()` if a previous
 * attach failed transiently, and by `listenPromise` so concurrent callers
 * share a single in-flight attach instead of double-subscribing. `listening`
 * is flipped to `true` only after `await on(...)` resolves, so a failure
 * leaves the flag clear for retry.
 */
function ensureListening(
  set: (partial: Pick<ConfigState, "settings">) => void,
): Promise<void> {
  if (listening) return Promise.resolve();
  if (listenPromise) return listenPromise;
  listenPromise = (async () => {
    try {
      unlisten = await on(CONFIG_CHANGED, (payload) => {
        set({ settings: payload.settings });
      });
      listening = true;
    } catch (err) {
      // Subscription failure is non-fatal — the user can still edit settings;
      // they just won't see external updates live. Leave `listening` false so
      // a subsequent `load()` retries the attach.
      console.warn("[config] failed to subscribe to CONFIG_CHANGED:", err);
    } finally {
      listenPromise = undefined;
    }
  })();
  return listenPromise;
}

export const useConfigStore = create<ConfigState>()((set, get) => ({
  settings: null,
  isLoading: false,
  error: null,

  async load() {
    // Always (re)attempt the CONFIG_CHANGED subscription, even when settings
    // are already loaded — a prior transient attach failure must be retryable,
    // otherwise the early return below would permanently disable live updates.
    await ensureListening(set);

    // De-duplicate concurrent callers: while a fetch is in-flight, return the
    // same Promise so two components don't race on `config.get`.
    if (loadPromise) return loadPromise;
    if (get().settings) return;

    set({ isLoading: true, error: null });
    loadPromise = (async () => {
      try {
        const settings = await config.get();
        set({ settings, isLoading: false });
      } catch (err) {
        set({
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        loadPromise = undefined;
      }
    })();
    return loadPromise;
  },

  async update(patch) {
    try {
      const settings = await config.update(patch as Record<string, unknown>);
      set({ settings, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  async reset() {
    const defaults = defaultSettings();
    await get().update(defaults);
  },

  _stopListening() {
    if (unlisten) {
      try {
        unlisten();
      } catch {
        // Listener may already be detached — best-effort cleanup.
      }
      unlisten = undefined;
    }
    listening = false;
  },
}));
