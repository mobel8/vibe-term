import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";

import { registerTerm } from "@/lib/terminal-registry";
import { useConfigStore } from "@/state/configStore";
import { useTerminalStore } from "@/state/terminalStore";
import { XTERM_THEMES, isThemeName } from "@/styles/themes";
import type { Settings } from "@/ipc";

// Fallback palette when no theme attribute is applied yet — matches the
// "dark" theme the UI boots into (see styles/themes/index.ts).
const DEFAULT_THEME_NAME = "dark" as const;

const DEFAULT_FONT_STACK =
  "JetBrains Mono, Geist Mono, Menlo, Monaco, Consolas, Liberation Mono, monospace";

/** Settings the user can point at a single family name — always keep the
 *  monospace fallback chain behind it so a missing font never degrades to
 *  the browser's default proportional face. */
function xtermFontFamily(family: string | undefined): string {
  const f = family?.trim();
  if (!f) return DEFAULT_FONT_STACK;
  return f.includes(",") ? f : `${f}, ${DEFAULT_FONT_STACK}`;
}

function clampScrollback(lines: number | undefined): number {
  const n = Number(lines);
  if (!Number.isFinite(n)) return 10_000;
  return Math.min(100_000, Math.max(100, Math.round(n)));
}

function toCursorStyle(style: string | undefined): "block" | "bar" | "underline" {
  return style === "bar" || style === "underline" ? style : "block";
}

/**
 * lineHeight guard: with the WebGL renderer at a FRACTIONAL devicePixelRatio
 * (e.g. 1.25 on 125% Windows scaling) any lineHeight > 1 leaves un-cleared
 * glyph residue — an erased character stays on screen ("ghost"). Honor the
 * configured value only when it is safe (integer DPR or DOM renderer).
 */
function safeLineHeight(requested: number | undefined, webglActive: boolean): number {
  const lh = Math.max(1, Number(requested) || 1);
  if (lh === 1) return 1;
  const dpr = window.devicePixelRatio || 1;
  const fractional = Math.abs(dpr - Math.round(dpr)) > 0.001;
  if (webglActive && fractional) {
    console.info(
      `[xterm] lineHeight ${lh} ignored: WebGL renderer at fractional DPR ${dpr} leaves glyph residue; using 1.0`,
    );
    return 1;
  }
  return lh;
}

/** Palette for the currently applied UI theme (document data-theme). Live
 *  theme switches are pushed by the theme runtime via the terminal registry. */
function currentThemePalette(): ITheme {
  const name = document.documentElement.getAttribute("data-theme");
  return { ...XTERM_THEMES[isThemeName(name) ? name : DEFAULT_THEME_NAME] };
}

/** OSC 7 payload → local path. Accepts `file://host/path`, `file:///path`
 *  and bare paths; percent-decodes; normalises `/C:/…` to `C:\…`. */
function parseOsc7Cwd(data: string): string | null {
  let raw = data.trim();
  if (!raw) return null;
  if (raw.toLowerCase().startsWith("file://")) {
    raw = raw.slice("file://".length);
    const slash = raw.indexOf("/");
    if (slash === -1) return null;
    raw = raw.slice(slash); // drop hostname
  }
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* keep undecoded */
  }
  // Windows drive form "/c:/Users/x" → "c:\Users\x"
  const m = /^\/([A-Za-z]:)(\/.*)?$/.exec(raw);
  if (m) raw = m[1] + (m[2] ?? "/").replace(/\//g, "\\");
  return raw || null;
}

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
 *   - Appearance/terminal settings (font, cursor, scrollback, lineHeight) are
 *     read from the config store at creation AND applied live on change; the
 *     terminal colour palette follows the UI theme via the theme runtime.
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

    const settings = useConfigStore.getState().settings;
    const appearance = settings?.appearance;

    const term = new Terminal({
      allowProposedApi: true,
      allowTransparency: false,
      cursorBlink: appearance?.cursorBlink ?? true,
      cursorStyle: toCursorStyle(appearance?.cursorStyle),
      fontFamily: xtermFontFamily(appearance?.fontFamily),
      fontSize: appearance?.fontSize ?? 13,
      // Constructed at 1.0; raised to the configured value AFTER the WebGL
      // attempt below decides which renderer is active (see safeLineHeight).
      lineHeight: 1.0,
      scrollback: clampScrollback(settings?.general.scrollbackLines),
      // Instant scroll — the 80ms smooth-scroll animation made fast output
      // (e.g. AI streaming) feel laggy as it continuously re-animated to bottom.
      smoothScrollDuration: 0,
      theme: currentThemePalette(),
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

    // Now that the renderer is known, honor the configured lineHeight where
    // it is safe to do so (see safeLineHeight for the fractional-DPR ghost).
    const requestedLineHeight = appearance?.lineHeight;
    const effectiveLh = safeLineHeight(requestedLineHeight, !!webgl);
    if (effectiveLh !== term.options.lineHeight) {
      term.options.lineHeight = effectiveLh;
    }

    // ── Live settings → terminal options ─────────────────────────────
    // Applies Appearance/General changes without a pane rebuild. The colour
    // theme is NOT handled here — the theme runtime (src/lib/theme.ts)
    // resolves "system" and pushes palettes through the terminal registry.
    const unsubscribeConfig = useConfigStore.subscribe((state, prev) => {
      const s: Settings | null = state.settings;
      if (!s) return;
      const p = prev.settings;
      const a = s.appearance;
      const pa = p?.appearance;
      let metricsChanged = false;
      if (a.fontSize !== pa?.fontSize && a.fontSize !== term.options.fontSize) {
        term.options.fontSize = a.fontSize;
        metricsChanged = true;
      }
      const fam = xtermFontFamily(a.fontFamily);
      if (fam !== term.options.fontFamily) {
        term.options.fontFamily = fam;
        metricsChanged = true;
      }
      const lh = safeLineHeight(a.lineHeight, !!webglRef.current);
      if (lh !== term.options.lineHeight) {
        term.options.lineHeight = lh;
        metricsChanged = true;
      }
      if (a.cursorBlink !== term.options.cursorBlink) {
        term.options.cursorBlink = a.cursorBlink;
      }
      const cs = toCursorStyle(a.cursorStyle);
      if (cs !== term.options.cursorStyle) {
        term.options.cursorStyle = cs;
      }
      const sb = clampScrollback(s.general.scrollbackLines);
      if (sb !== term.options.scrollback) {
        term.options.scrollback = sb;
      }
      if (metricsChanged) {
        try {
          fit.fit();
          webglRef.current?.clearTextureAtlas();
          term.refresh(0, term.rows - 1);
        } catch {
          /* container mid-layout; next resize refits */
        }
      }
    });

    // ── Shell-integration cwd tracking (OSC 7 / OSC 9;9) ─────────────
    // Emitted by shells with integration configured (bash/zsh PROMPT_COMMAND,
    // Windows Terminal-style PowerShell profiles). Feeds the status bar and
    // "split inherits cwd". Harmless no-op when the shell never emits them.
    const osc7 = term.parser.registerOscHandler(7, (data) => {
      const cwd = parseOsc7Cwd(data);
      if (cwd) useTerminalStore.getState().setCwd(instanceKey, cwd);
      return true;
    });
    const osc9 = term.parser.registerOscHandler(9, (data) => {
      // Windows Terminal convention: OSC 9;9;"<cwd>" — other OSC 9
      // subcommands (ConEmu progress etc.) fall through unhandled.
      if (!data.startsWith("9;")) return false;
      const cwd = data.slice(2).replace(/^"(.*)"$/, "$1").trim();
      if (cwd) useTerminalStore.getState().setCwd(instanceKey, cwd);
      return true;
    });

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
    // App-level features (palette clear/reset, theme pushes, e2e harness)
    // reach this pane through the registry.
    const unregisterTerm = registerTerm(instanceKey, term);

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
        // The safe lineHeight depends on the DPR — re-evaluate it too.
        const next = safeLineHeight(
          useConfigStore.getState().settings?.appearance.lineHeight,
          !!webglRef.current,
        );
        if (next !== term.options.lineHeight) term.options.lineHeight = next;
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
      unregisterTerm();
      unsubscribeConfig();
      osc7.dispose();
      osc9.dispose();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [focus, write, paste, resizeToFit, termVersion],
  );
}
