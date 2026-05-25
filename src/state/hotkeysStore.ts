// vibe-term — Hotkeys store.
//
// Holds the binding table (action → combo string) and a runtime registry of
// component-level callbacks (action → fn). The App shell is expected to:
//   1. seed `bindings` from the persisted config (`config.get().hotkeys`),
//   2. call `setupHotkeys(bindings, dispatch)` once at mount where
//      `dispatch(action)` looks up the handler via `getState().handlers`,
//   3. re-call `setupHotkeys` whenever `bindings` mutate.
//
// Components register themselves via `register(action, fn)`, which returns an
// unregister function suitable for a `useEffect` cleanup. We use a Map (not a
// Zustand-tracked plain object) for the handlers so registering a handler does
// NOT re-render every other subscriber. The bindings table IS tracked because
// the settings UI lists them.

import { create } from "zustand";

interface HotkeysState {
  /** Persisted action → combo mapping. */
  bindings: Record<string, string>;
  /**
   * Runtime registry of action → callback. Not tracked by Zustand selectors
   * because registering a handler should never re-render unrelated subscribers.
   */
  handlers: Map<string, () => void>;
  /**
   * Register a component-level handler for an action. Returns a function that
   * unregisters that exact handler (idempotent if called twice).
   */
  register(action: string, handler: () => void): () => void;
  /**
   * Dispatch a hotkey action — called by both the window-level keydown
   * listener and the backend `hotkey://triggered` event subscriber. No-op if
   * no handler is registered.
   */
  dispatch(action: string): void;
  /** Overwrite a single binding (e.g. user-rebinding via settings UI). */
  setBinding(action: string, combo: string): void;
  /** Bulk-replace bindings (e.g. on initial config load). */
  bulkSetBindings(bindings: Record<string, string>): void;
}

export const useHotkeysStore = create<HotkeysState>((set, get) => ({
  bindings: {},
  handlers: new Map(),

  register(action, handler) {
    const handlers = get().handlers;
    handlers.set(action, handler);
    return () => {
      // Only delete if the slot is still ours — avoids races where two
      // components transiently overlap during unmount/remount.
      if (handlers.get(action) === handler) {
        handlers.delete(action);
      }
    };
  },

  dispatch(action) {
    const fn = get().handlers.get(action);
    if (fn) fn();
  },

  setBinding(action, combo) {
    set((state) => ({ bindings: { ...state.bindings, [action]: combo } }));
  },

  bulkSetBindings(bindings) {
    // Always copy — the caller may have passed a frozen object straight from
    // a backend payload and Zustand callers expect to mutate via spreads.
    set({ bindings: { ...bindings } });
  },
}));
