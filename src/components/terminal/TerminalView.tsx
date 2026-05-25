import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  PTY_BELL,
  PTY_CWD_CHANGE,
  PTY_DATA,
  PTY_EXIT,
  images,
  on,
  pty,
} from "@/ipc";
import type { ImageMeta } from "@/ipc";
import { useTerminalStore } from "@/state/terminalStore";
import { useConfigStore } from "@/state/configStore";
import { flashVisualBell, playBeep } from "@/lib/bell";

import { ImageOverlay } from "./ImageOverlay";
import { useXterm } from "./useXterm";

interface TerminalViewProps {
  tabId: string;
}

const RESIZE_DEBOUNCE_MS = 100;

/**
 * Single terminal pane bound to a tab in the terminal store. Owns:
 *   - the xterm.js instance via useXterm (rendering)
 *   - the lifecycle of the underlying PTY: spawn on mount when the tab has
 *     no ptyId yet, attach data/exit listeners, propagate input + resize back
 *     to the backend. We do NOT kill the PTY on unmount — the store's
 *     `closeTab` action explicitly calls `pty.kill` so PTY survival is
 *     decoupled from React reconciliation (Dockview can detach/re-attach
 *     panels during layout updates).
 */
export function TerminalView({ tabId }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tab = useTerminalStore((s) => s.tabs.find((t) => t.id === tabId));
  const setPtyId = useTerminalStore((s) => s.setPtyId);
  const setStatus = useTerminalStore((s) => s.setStatus);
  const setCwd = useTerminalStore((s) => s.setCwd);

  // Live PTY id mirror — the store value can lag by a render when the spawn
  // resolves; the local ref is what the input/resize handlers read.
  const ptyIdRef = useRef<string | null>(tab?.ptyId ?? null);
  const [previewImage, setPreviewImage] = useState<ImageMeta | null>(null);
  const [exitNotice, setExitNotice] = useState<string | null>(null);

  const handleData = useCallback((data: string) => {
    const id = ptyIdRef.current;
    if (!id) return;
    pty.write(id, data).catch((err: unknown) => {
       
      console.warn("[terminal] pty.write failed", err);
    });
  }, []);

  const handleResize = useCallback((cols: number, rows: number) => {
    const id = ptyIdRef.current;
    if (!id) return;
    pty.resize(id, cols, rows).catch((err: unknown) => {
       
      console.warn("[terminal] pty.resize failed", err);
    });
  }, []);

  const xterm = useXterm(containerRef, tab?.ptyId ?? null, {
    onData: handleData,
    onResize: handleResize,
  });

  // ── Spawn / re-attach ───────────────────────────────────────────────
  useEffect(() => {
    if (!tab) return;
    if (tab.ptyId) {
      ptyIdRef.current = tab.ptyId;
      return;
    }

    let cancelled = false;
    const term = xterm.term;
    const cols = term?.cols ?? 80;
    const rows = term?.rows ?? 24;

    void pty
      .spawn(tab.shell.path, tab.shell.args, tab.cwd, cols, rows, [])
      .then((id) => {
        if (cancelled) {
          // The tab was closed before spawn resolved — kill the orphan now.
          void pty.kill(id).catch(() => undefined);
          return;
        }
        ptyIdRef.current = id;
        setPtyId(tab.id, id);
        setStatus(tab.id, "running");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
         
        console.error("[terminal] pty.spawn failed", err);
        setStatus(tab.id, "error");
        setExitNotice(
          `Failed to spawn ${tab.shell.name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });

    return () => {
      cancelled = true;
    };
  }, [tab, xterm.term, setPtyId, setStatus]);

  // ── PTY event subscriptions ────────────────────────────────────────
  useEffect(() => {
    if (!tab) return;
    const unlisteners: Promise<UnlistenFn>[] = [];

    unlisteners.push(
      on(PTY_DATA, (payload) => {
        if (payload.ptyId !== ptyIdRef.current) return;
        xterm.write(payload.data);
      }),
    );
    unlisteners.push(
      on(PTY_EXIT, (payload) => {
        if (payload.ptyId !== ptyIdRef.current) return;
        setStatus(tab.id, "exited", payload.code);
        setExitNotice(
          `[Process exited${
            payload.code !== null ? ` (code ${payload.code})` : ""
          }]`,
        );
      }),
    );
    unlisteners.push(
      on(PTY_CWD_CHANGE, (payload) => {
        if (payload.ptyId !== ptyIdRef.current) return;
        setCwd(tab.id, payload.cwd);
      }),
    );
    unlisteners.push(
      on(PTY_BELL, (payload) => {
        if (payload.ptyId !== ptyIdRef.current) return;
        const settings = useConfigStore.getState().settings;
        if (settings?.terminal.bell) {
          playBeep();
        }
        flashVisualBell();
      }),
    );

    return () => {
      unlisteners.forEach((p) => {
        p.then((un) => un()).catch(() => undefined);
      });
    };
    // We re-subscribe whenever the tab identity changes; the ptyIdRef stays
    // in lockstep with `tab.ptyId` so callbacks always see the freshest id.
  }, [tab, xterm, setStatus, setCwd]);

  // ── Container resize ↔ xterm.fit ───────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        xterm.resizeToFit();
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
  }, [xterm]);

  // ── Clipboard image paste intercept ────────────────────────────────
  useEffect(() => {
    const term = xterm.term;
    if (!term || !tab) return;

    term.attachCustomKeyEventHandler((ev) => {
      const isPasteCombo =
        ev.type === "keydown" &&
        (ev.ctrlKey || ev.metaKey) &&
        !ev.altKey &&
        (ev.key === "v" || ev.key === "V");

      if (!isPasteCombo) return true;

      // Probe the clipboard for an image; if none, fall through to text paste.
      void (async () => {
        try {
          const meta = await images.pasteFromClipboard();
          if (meta) {
            setPreviewImage(meta);
            useTerminalStore.getState().attachImageToTab(tab.id, meta);
            term.paste(`[${meta.id}]`);
            return;
          }
        } catch (err) {
           
          console.warn("[terminal] image paste probe failed", err);
        }
        // No image on the clipboard — perform a normal text paste.
        try {
          const text = await navigator.clipboard.readText();
          if (text) term.paste(text);
        } catch (err) {
           
          console.warn("[terminal] text paste failed", err);
        }
      })();

      // We always swallow the native paste — the async branch above
      // explicitly calls term.paste() with the right payload.
      return false;
    });
  }, [tab, xterm.term]);

  if (!tab) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        Tab not found.
      </div>
    );
  }

  return (
    <div className="vibe-terminal-root">
      <div
        ref={containerRef}
        className="relative h-full w-full"
        onClick={() => xterm.focus()}
        role="presentation"
      />
      {previewImage && (
        <ImageOverlay
          image={previewImage}
          onDismiss={() => setPreviewImage(null)}
        />
      )}
      {exitNotice && (
        <div className="vibe-terminal-exit-overlay">{exitNotice}</div>
      )}
    </div>
  );
}

export default TerminalView;
