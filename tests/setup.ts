// vitest setup — runs before every test file.
//
// Two responsibilities:
//   1. Flip the React 19 `IS_REACT_ACT_ENVIRONMENT` flag so the `act(...)`
//      warnings go away. React 19 reads this on first call.
//   2. Polyfill `localStorage` / `sessionStorage`. jsdom 29 ships a stub
//      object without `getItem`/`setItem`/etc. (regression versus jsdom 23),
//      which breaks zustand's persist middleware. We replace it with a
//      memory-backed implementation that satisfies the `Storage` interface.

import { afterEach } from "vitest";

// ── React 19 act environment ──────────────────────────────────────────────
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

// ── Memory-backed Storage polyfill ────────────────────────────────────────
function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear(): void {
      store.clear();
    },
    getItem(key: string): string | null {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value));
    },
  };
}

function ensureStorage(slot: "localStorage" | "sessionStorage") {
  const current = (globalThis as unknown as Record<string, Storage | undefined>)[slot];
  if (!current || typeof current.setItem !== "function") {
    Object.defineProperty(globalThis, slot, {
      configurable: true,
      writable: true,
      value: memoryStorage(),
    });
  }
}

ensureStorage("localStorage");
ensureStorage("sessionStorage");

// ── matchMedia polyfill ───────────────────────────────────────────────────
// xterm.js's CoreBrowserService accesses `window.matchMedia` at construction
// time to detect high-DPI displays. jsdom doesn't implement it.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

// ── ResizeObserver polyfill ───────────────────────────────────────────────
// jsdom doesn't implement ResizeObserver. Components that observe content size
// (AISidebar's auto-scroll-to-bottom, TerminalView's fit-on-resize) construct
// one at mount, so a no-op stub keeps those smoke tests from throwing. They
// don't assert on resize-driven behaviour, so the stub firing nothing is fine.
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    ResizeObserverStub;
}

afterEach(() => {
  try {
    globalThis.localStorage?.clear?.();
    globalThis.sessionStorage?.clear?.();
  } catch {
    /* ignore — storage may have been replaced by an individual test */
  }
});
