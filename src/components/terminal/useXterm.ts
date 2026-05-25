import { useCallback, useEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";

import type { PtyId } from "@/ipc";

// Dark theme — sourced from tailwind.config.ts:theme.colors.bg + a balanced
// ANSI 16 palette (Tokyo Night inspired) so colour-rich CLIs (htop, vim) stay
// legible without fighting the surrounding UI chrome.
const THEME = Object.freeze({
  foreground: "#e4e4e7",
  background: "#0a0a0b",
  cursor: "#7c93ff",
  cursorAccent: "#0a0a0b",
  selectionBackground: "#3d4a8a66",
  selectionForeground: "#ffffff",
  black: "#15161e",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#a9b1d6",
  brightBlack: "#414868",
  brightRed: "#ff7a93",
  brightGreen: "#b9f27c",
  brightYellow: "#ff9e64",
  brightBlue: "#7da6ff",
  brightMagenta: "#bb9af7",
  brightCyan: "#0db9d7",
  brightWhite: "#c0caf5",
});

const DEFAULT_FONT_STACK =
  "JetBrains Mono, Geist Mono, Menlo, Monaco, Consolas, Liberation Mono, monospace";

export interface UseXtermOptions {
  onData(data: string): void;
  onResize(cols: number, rows: number): void;
  onBell?(): void;
  onAttached?(term: Terminal): void;
}

export interface XtermHandle {
  term: Terminal | null;
  fit: FitAddon | null;
  search: SearchAddon | null;
  focus(): void;
  write(data: string): void;
  paste(data: string): void;
  resizeToFit(): void;
}

/**
 * Initialise an xterm.js terminal inside `container` with the addon set used
 * across the app. The hook does NOT spawn the PTY — caller owns the lifecycle
 * (see TerminalView). Refs are stable across renders so we can safely wire
 * IPC listeners outside of React's render cycle.
 *
 * INVARIANTS:
 *   - The Terminal instance is created once per (container, ptyId) tuple.
 *   - WebGL activation is best-effort; falls back to the DOM/canvas renderer.
 *   - Cleanup disposes the terminal, all addons and the registered event
 *     listeners. Calling site must let this hook own the .dispose() lifecycle.
 */
export function useXterm(
  containerRef: RefObject<HTMLDivElement | null>,
  ptyId: PtyId | null,
  options: UseXtermOptions,
): XtermHandle {
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  // Keep the callbacks in a ref so the init effect doesn't tear down the
  // terminal whenever the caller passes inline arrow functions.
  const callbacksRef = useRef(options);
  callbacksRef.current = options;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      allowProposedApi: true,
      allowTransparency: false,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: DEFAULT_FONT_STACK,
      fontSize: 13,
      lineHeight: 1.4,
      scrollback: 10000,
      smoothScrollDuration: 80,
      theme: { ...THEME },
      windowsMode: navigator.userAgent.includes("Windows"),
    });

    const fit = new FitAddon();
    const search = new SearchAddon();
    const unicode11 = new Unicode11Addon();
    const webLinks = new WebLinksAddon();
    const image = new ImageAddon({
      enableSizeReports: true,
      sixelSupport: true,
      iipSupport: true,
      showPlaceholder: true,
      storageLimit: 64,
    });

    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(unicode11);
    term.loadAddon(webLinks);
    term.loadAddon(image);
    // Switching the unicode handler must happen after the addon registers it.
    term.unicode.activeVersion = "11";

    term.open(container);

    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        // WebGL2 context can be evicted under memory pressure (e.g. tab
        // resume). Disposing here triggers the addon-managed fallback to the
        // DOM renderer for the remainder of this terminal's lifetime.
        webgl?.dispose();
        webgl = null;
         
        console.warn("[xterm] WebGL context lost; falling back to DOM renderer");
      });
      term.loadAddon(webgl);
    } catch (err) {
       
      console.warn("[xterm] WebGL renderer unavailable, using DOM fallback", err);
      webgl?.dispose();
      webgl = null;
    }

    const onDataDisposable = term.onData((data) => {
      callbacksRef.current.onData(data);
    });
    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      callbacksRef.current.onResize(cols, rows);
    });
    const onBellDisposable = term.onBell(() => {
      callbacksRef.current.onBell?.();
    });

    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    // First fit — defer one frame so the container has its measured size.
    const firstFit = requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch (err) {
         
        console.warn("[xterm] initial fit failed", err);
      }
    });

    callbacksRef.current.onAttached?.(term);

    return () => {
      cancelAnimationFrame(firstFit);
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
      onBellDisposable.dispose();
      try {
        webgl?.dispose();
      } catch {
        /* webgl already disposed */
      }
      image.dispose();
      webLinks.dispose();
      unicode11.dispose();
      search.dispose();
      fit.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
    // ptyId is intentionally a dep: switching the PTY behind the same
    // container should rebuild a fresh terminal (clean scrollback + cursor).
  }, [containerRef, ptyId]);

  const focus = useCallback(() => {
    termRef.current?.focus();
  }, []);

  const write = useCallback((data: string) => {
    termRef.current?.write(data);
  }, []);

  const paste = useCallback((data: string) => {
    termRef.current?.paste(data);
  }, []);

  const resizeToFit = useCallback(() => {
    try {
      fitRef.current?.fit();
    } catch {
      /* container detached during a layout flush */
    }
  }, []);

  return useMemo<XtermHandle>(
    () => ({
      term: termRef.current,
      fit: fitRef.current,
      search: searchRef.current,
      focus,
      write,
      paste,
      resizeToFit,
    }),
    // We don't include refs in deps — they're stable across renders and the
    // handle is read on-demand by callers.
    [focus, write, paste, resizeToFit],
  );
}
