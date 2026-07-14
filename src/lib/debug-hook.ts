// vibe-term — Read-only runtime introspection hook.
//
// Exposes `window.__vibe` so the e2e/CDP harness (scripts/e2e-*.mjs) can
// observe real state — xterm buffers, DEC private modes, viewport position,
// store snapshots — without reaching into React internals. The WebGL renderer
// leaves `.xterm-rows` DOM empty, so the buffer API here is the ONLY reliable
// way to read what the terminal displays in automated tests.
//
// Deliberately shipped in production builds: proofs must run on the exact
// artifact the user runs. Everything here is read-only introspection over
// state the webview already owns; no secrets, no privileged bridge.

import type { Terminal } from "@xterm/xterm";

import { writePty } from "@/lib/pty-writer";
import { getAllTerms } from "@/lib/terminal-registry";

export interface VibeDebugHook {
  /** Live xterm instances keyed by tab id (the terminal-registry map). */
  terms: ReadonlyMap<string, Terminal>;
  /** Dockview API once SplitContainer is ready (layout introspection). */
  dockview: unknown;
  /** Read a snapshot of visible/scrollback lines for a tab's terminal. */
  readLines(tabId: string, start?: number, count?: number): string[] | null;
  /** Terminal + emulator state relevant to scroll/mode bugs. */
  termState(tabId: string): Record<string, unknown> | null;
  /** Store snapshots (zustand getState passthroughs, registered lazily). */
  stores: Record<string, () => unknown>;
  /** The app's REAL serialized PTY writer — lets the e2e harness prove that
   *  concurrent writers cannot splice (the parasitic-characters fix). */
  writePty(ptyId: string, data: string): void;
}

function getHook(): VibeDebugHook {
  const w = window as unknown as { __vibe?: VibeDebugHook };
  if (!w.__vibe) {
    const hook: VibeDebugHook = {
      terms: getAllTerms(),
      dockview: null,
      stores: {},
      writePty,
      readLines(tabId, start, count) {
        const term = hook.terms.get(tabId);
        if (!term) return null;
        const buf = term.buffer.active;
        const from = start ?? Math.max(0, buf.baseY - 0); // default: viewport top
        const n = count ?? term.rows;
        const out: string[] = [];
        for (let i = 0; i < n; i++) {
          const line = buf.getLine(from + i);
          if (!line) break;
          out.push(line.translateToString(true));
        }
        return out;
      },
      termState(tabId) {
        const term = hook.terms.get(tabId);
        if (!term) return null;
        const buf = term.buffer.active;
        return {
          cols: term.cols,
          rows: term.rows,
          bufferType: buf.type,
          baseY: buf.baseY,
          viewportY: buf.viewportY,
          cursorY: buf.cursorY,
          length: buf.length,
          modes: { ...term.modes },
          options: {
            fontSize: term.options.fontSize,
            fontFamily: term.options.fontFamily,
            scrollback: term.options.scrollback,
            cursorBlink: term.options.cursorBlink,
            cursorStyle: term.options.cursorStyle,
            lineHeight: term.options.lineHeight,
            theme: term.options.theme,
          },
        };
      },
    };
    w.__vibe = hook;
  }
  return w.__vibe;
}

/** Force the hook to exist (call once from app bootstrap). */
export function ensureDebugHook(): void {
  getHook();
}

/** Register the dockview api for layout introspection. */
export function debugRegisterDockview(api: unknown): void {
  getHook().dockview = api;
}

/** Register a named store snapshot getter (e.g. "terminal", "config"). */
export function debugRegisterStore(name: string, get: () => unknown): void {
  getHook().stores[name] = get;
}
