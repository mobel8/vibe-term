import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";

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
 *   - The Terminal instance is created once per (container, instanceKey) tuple.
 *     `instanceKey` MUST be a value stable for the lifetime of the pane (the
 *     tab id) — NOT the ptyId. Keying on the ptyId tore the terminal down and
 *     rebuilt it the instant the spawn resolved (null → id), discarding the
 *     shell's initial prompt/banner and double-building the WebGL context.
 *   - WebGL activation is best-effort; falls back to the DOM/canvas renderer.
 *   - Cleanup disposes the terminal, all addons and the registered event
 *     listeners. Calling site must let this hook own the .dispose() lifecycle.
 */
export function useXterm(
  containerRef: RefObject<HTMLDivElement | null>,
  instanceKey: string,
  options: UseXtermOptions,
): XtermHandle {
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  // The live WebGL addon (or null after a context loss / when unavailable).
  // Held so we can clear its glyph atlas on DPR change / resize to kill the
  // fractional-DPR ghost-glyph residue.
  const webglRef = useRef<WebglAddon | null>(null);
  // Version tag — bumped each time the inner terminal is (re)created so
  // useMemo below re-publishes the live ref values to consumers. Without
  // this, `xterm.term` would stay frozen at its initial `null` snapshot.
  const [termVersion, setTermVersion] = useState(0);
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
      // lineHeight MUST stay 1.0: with the WebGL renderer at a fractional
      // devicePixelRatio (e.g. 1.25 on 125% Windows scaling) any value >1 leaves
      // un-cleared glyph residue — the cell's extra leading isn't redrawn, so an
      // erased character stays on screen. 1.0 makes the glyph fill the cell.
      lineHeight: 1.0,
      scrollback: 10000,
      // Instant scroll — the 80ms smooth-scroll animation made fast output
      // (e.g. AI streaming) feel laggy as it continuously re-animated to bottom.
      smoothScrollDuration: 0,
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
        webglRef.current = null;

        console.warn("[xterm] WebGL context lost; falling back to DOM renderer");
      });
      term.loadAddon(webgl);
    } catch (err) {

      console.warn("[xterm] WebGL renderer unavailable, using DOM fallback", err);
      webgl?.dispose();
      webgl = null;
    }
    webglRef.current = webgl;

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
    setTermVersion((v) => v + 1);

    // First fit — defer one frame so the container has its measured size.
    const firstFit = requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch (err) {
         
        console.warn("[xterm] initial fit failed", err);
      }
    });

    callbacksRef.current.onAttached?.(term);

    // ── DPR-change residue guard ──────────────────────────────────────
    // There is NO DOM event when devicePixelRatio changes (Windows display-
    // scaling change, dragging between monitors, OS zoom). xterm's WebGL glyph
    // atlas can keep stale glyphs rendered at the old scale → a "ghost" char
    // that survives an erase. Observe DPR via matchMedia and, on any change,
    // clear the glyph atlas + full-refresh + refit so nothing stale survives.
    let dprMql: MediaQueryList | null = null;
    const onDprChange = () => {
      try {
        webgl?.clearTextureAtlas();
        term.refresh(0, term.rows - 1);
        fit.fit();
      } catch (err) {
        console.warn("[xterm] DPR-change atlas refresh failed", err);
      }
      // matchMedia `dppx` queries are effectively one-shot — re-arm at the new DPR.
      dprMql?.removeEventListener("change", onDprChange);
      dprMql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprMql.addEventListener("change", onDprChange);
    };
    dprMql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    dprMql.addEventListener("change", onDprChange);

    return () => {
      cancelAnimationFrame(firstFit);
      dprMql?.removeEventListener("change", onDprChange);
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
    // Rebuild only when the pane identity (tab id) or container changes — NOT
    // when the ptyId resolves. Keying on ptyId rebuilt the terminal on first
    // spawn and threw away the initial output (see INVARIANTS above).
  }, [containerRef, instanceKey]);

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
      // After a reflow, clear the WebGL glyph atlas + full-refresh: at a
      // fractional DPR the cell origins shift sub-pixel on resize, which can
      // leave a sliver of an old glyph behind. This forces a clean re-blit so
      // no "ghost" character survives an erase.
      webglRef.current?.clearTextureAtlas();
      const t = termRef.current;
      if (t) t.refresh(0, t.rows - 1);
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
    // termVersion bumps when the inner term is (re)created so consumers see
    // the live refs rather than the stale `null` captured at first render.
    [focus, write, paste, resizeToFit, termVersion],
  );
}
