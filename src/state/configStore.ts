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
      lineHeight: 1.3,
      cursorStyle: "block",
      cursorBlink: true,
    },
    hotkeys: {
      "palette.open": "Ctrl+K",
      "tab.new": "Ctrl+Shift+T",
      "tab.close": "Ctrl+Shift+W",
      "tab.next": "Ctrl+Tab",
      "tab.prev": "Ctrl+Shift+Tab",
      "split.horizontal": "Ctrl+Shift+D",
      "split.vertical": "Ctrl+Shift+E",
      "terminal.clear": "Ctrl+L",
      "terminal.search": "Ctrl+F",
      "ai.toggle": "Ctrl+Shift+A",
      "ai.send": "Ctrl+Enter",
      "image.paste": "Ctrl+V",
      "image.screenshot": "Ctrl+Shift+S",
      "theme.toggle": "Ctrl+Shift+L",
      "settings.open": "Ctrl+,",
    },
    ai: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      maxContextBlocks: 8,
      autoSummarizeThresholdTokens: 32_000,
    },
    terminal: {
      bell: false,
      copyOnSelect: false,
      rightClickPaste: true,
    },
  };
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
let loadPromise: Promise<void> | undefined;

export const useConfigStore = create<ConfigState>()((set, get) => ({
  settings: null,
  isLoading: false,
  error: null,

  async load() {
    // De-duplicate concurrent callers: while a fetch is in-flight, return the
    // same Promise so two components don't race on `config.get`.
    if (loadPromise) return loadPromise;
    if (get().settings) return;

    set({ isLoading: true, error: null });
    loadPromise = (async () => {
      try {
        const settings = await config.get();
        set({ settings, isLoading: false });

        if (!listening) {
          listening = true;
          try {
            unlisten = await on(CONFIG_CHANGED, (payload) => {
              set({ settings: payload.settings });
            });
          } catch (err) {
            // Subscription failure is non-fatal — the user can still edit
            // settings; they just won't see external updates live.
            console.warn("[config] failed to subscribe to CONFIG_CHANGED:", err);
            listening = false;
          }
        }
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
