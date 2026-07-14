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
  store,
} from "@/ipc";
import type { ImageMeta } from "@/ipc";
import { useTerminalStore } from "@/state/terminalStore";
import { useConfigStore } from "@/state/configStore";
import { useImageStore } from "@/state/imageStore";
import { flashVisualBell, playBeep } from "@/lib/bell";
import { copyText, readText } from "@/lib/clipboard";
import {
  GALLERY_DRAG_MIME,
  detectSshHost,
  insertImageIntoTerminal,
} from "@/lib/image-insert";
import { disposePtyWriter, writePty } from "@/lib/pty-writer";
import { getTerm } from "@/lib/terminal-registry";
import {
  healTerminalModes,
  isTerminalStateSuspicious,
} from "@/lib/terminal-heal";
import { toast } from "@/state/toastStore";

import { ImageOverlay } from "./ImageOverlay";
import { useXterm } from "./useXterm";

interface TerminalViewProps {
  tabId: string;
}

const RESIZE_DEBOUNCE_MS = 100;

/** Idle gap that closes one coarse terminal-history "output" block. */
const BLOCK_IDLE_MS = 1200;
/** Cap the output buffer so a flood before the DB session lands can't grow
 *  unbounded; keep the most-recent bytes. */
const BLOCK_BUF_CAP = 131_072;

// Strip ANSI CSI/OSC escape sequences + other control bytes (keep tab/LF/CR)
// so persisted block content is plain, searchable text. charCodes only — no
// control-char regex literal — so it stays lint-clean and robust.
function stripAnsi(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 27) {
      // ESC — skip a CSI (ESC [ … final @-~) or OSC (ESC ] … BEL) sequence.
      const next = s[i + 1];
      if (next === "[") {
        i += 2;
        while (i < s.length && !/[@-~]/.test(s[i])) i++;
      } else if (next === "]") {
        i += 2;
        while (i < s.length && s.charCodeAt(i) !== 7) i++;
      } else {
        i += 1;
      }
      continue;
    }
    // Keep tab(9)/LF(10)/CR(13) + printable; drop other C0/C1 control bytes.
    if (code === 9 || code === 10 || code === 13 || code >= 32) out += s[i];
  }
  return out;
}

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
  // PTY_DATA events can arrive on Rust's reader thread BEFORE the spawn IPC
  // returns the id to JS (a ~ms race). Without buffering, the listener filter
  // sees `ptyIdRef.current === null` and drops the very first chunk — usually
  // a `\x1b[6n` CPR query the shell needs us to answer to proceed. Result: a
  // wedged terminal that never echoes input.
  // We buffer chunks keyed by their payload ptyId; the spawn `.then` flushes
  // the bucket for its own id once `ptyIdRef.current` is set.
  const pendingDataRef = useRef<Map<string, string[]>>(new Map());
  // Coarse terminal-history persistence: PTY output accumulates here and is
  // flushed as ONE DB "output" block per idle gap — never one write per
  // PTY_DATA (the hottest path in the app). Capped + ANSI-stripped on flush.
  const blockBufRef = useRef("");
  const blockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ctrl+V and Ctrl+Shift+V both produce a browser `paste` event, but that event
  // doesn't expose which modifiers were held. The keydown handler records the
  // intent here ("path" = Ctrl+Shift+V) for the paste handler to read.
  const pasteModeRef = useRef<"auto" | "path">("auto");
  const [previewImage, setPreviewImage] = useState<ImageMeta | null>(null);
  const [exitNotice, setExitNotice] = useState<string | null>(null);

  // ALL PTY writes go through the shared per-pty serialized writer
  // (src/lib/pty-writer.ts). xterm fires onData for typed keys, pastes AND its
  // own auto-replies to program queries (e.g. the cursor-position report a TUI
  // like Claude Code requests continuously); the image/@-mention and
  // screenshot inserters write too. Any two un-serialized writes can
  // interleave in the backend pool and splice bytes INTO the user's typed
  // command — the "parasitic characters" corruption. One queue per PTY keeps
  // byte order end-to-end.
  const handleData = useCallback((data: string) => {
    const id = ptyIdRef.current;
    if (!id) return;
    writePty(id, data);
  }, []);

  // ── Leaked-mode self-heal ──────────────────────────────────────────
  // A TUI that dies uncleanly (ssh drop mid-claude/vim) leaves mouse
  // tracking / bracketed paste / focus reporting / the alternate screen
  // latched in the emulator: the wheel stops scrolling and pastes/focus
  // changes type garbage. When the emulator looks suspicious AND the pane's
  // shell has no live child process (nothing could legitimately want those
  // modes), rewind them. Throttled; the probe is a cheap process-tree count.
  const leakCheckAtRef = useRef(0);
  const leakCheck = useCallback(
    async (force = false): Promise<boolean> => {
      const id = ptyIdRef.current;
      if (!id) return false;
      const now = Date.now();
      if (!force && now - leakCheckAtRef.current < 3000) return false;
      leakCheckAtRef.current = now;
      let children: number;
      try {
        children = await pty.childCount(id);
      } catch {
        return false; // probe failed — do nothing rather than misfire
      }
      const term = getTerm(tabId);
      if (!term || children > 0) return false;
      if (!isTerminalStateSuspicious(term)) return false;
      healTerminalModes(term);
      toast.info("Terminal modes auto-reset (a fullscreen app exited uncleanly)");
      return true;
    },
    [tabId],
  );

  const handleResize = useCallback((cols: number, rows: number) => {
    const id = ptyIdRef.current;
    if (!id) return;
    pty.resize(id, cols, rows).catch((err: unknown) => {
       
      console.warn("[terminal] pty.resize failed", err);
    });
  }, []);

  // Key the xterm instance on the STABLE tab id — never the ptyId. Keying on
  // ptyId rebuilt the terminal the moment the spawn resolved (null → id) and
  // discarded the shell's initial prompt/banner.
  const xterm = useXterm(containerRef, tabId, {
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
    // Wait for the xterm instance before spawning so we hand the real measured
    // cols/rows to the backend rather than the 80x24 fallback. The effect will
    // re-run once useXterm publishes the live term via its version bump.
    const term = xterm.term;
    if (!term) return;

    let cancelled = false;
    const cols = term.cols;
    const rows = term.rows;

    void pty
      .spawn(tab.shell.path, tab.shell.args, tab.cwd, cols, rows, [])
      .then((id) => {
        if (cancelled) {
          // The tab was closed before spawn resolved — kill the orphan now.
          void pty.kill(id).catch(() => undefined);
          return;
        }
        ptyIdRef.current = id;
        // Drain any PTY_DATA chunks that arrived for this id BEFORE we knew
        // it was ours and got buffered.
        const buffered = pendingDataRef.current.get(id);
        if (buffered && buffered.length > 0) {
          for (const chunk of buffered) xterm.write(chunk);
        }
        // Drop every bucket — not just our own id. By the time the spawn
        // resolves, any other key in this pane's map is a foreign pty's output
        // buffered during the null window (that owning pane drains its own
        // copy), so they are orphans we'd otherwise retain for the pane's whole
        // lifetime. The own bucket was already replayed into `buffered` above.
        pendingDataRef.current.clear();
        setPtyId(tab.id, id);
        setStatus(tab.id, "running");
        // Lazily create the DB session backing this tab's persisted history (AI
        // conversations + terminal blocks): one session per tab, kept across
        // restarts. Fire-and-forget so a DB hiccup never wedges the terminal.
        if (!tab.sessionId) {
          void store
            .sessionCreate(tab.title)
            .then((s) => useTerminalStore.getState().setSessionId(tab.id, s.id))
            .catch((e) => console.warn("[persist] sessionCreate failed", e));
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Spawn failed → no id will ever arrive, so drop any PTY_DATA chunks we
        // buffered for the not-yet-known id instead of leaking them in the map.
        pendingDataRef.current.clear();

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
    // xterm.write is intentionally omitted: it's a stable useCallback([]) that
    // targets the live term via a ref, and depending on the whole `xterm`
    // handle would re-run the spawn effect on every term version bump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, xterm.term, setPtyId, setStatus]);

  // ── PTY event subscriptions ────────────────────────────────────────
  useEffect(() => {
    if (!tab) return;
    // Capture the stable tab id + the stable `write` callback (useXterm's write
    // is a useCallback([]) that targets the live term via a ref). Depending on
    // these — NOT the whole `tab`/`xterm` objects — means we register the four
    // listeners ONCE per pane instead of re-subscribing on every cwd/status
    // mutation (which churns the `tab` object on every command, especially over
    // SSH — 4 unlisten+listen IPC hops each time, with a brief window where the
    // data listener isn't live and a chunk could slip through).
    const tabId = tab.id;
    const write = xterm.write;
    const unlisteners: Promise<UnlistenFn>[] = [];

    // Flush the accumulated output as one coarse "output" block. Gated on a real
    // DB session (FK requirement); if none exists yet, keep buffering and flush
    // on a later tick. Clears the buffer atomically before the async write so an
    // idle-flush and an exit/unmount-flush can't emit the same bytes twice.
    const flushBlock = () => {
      const buf = blockBufRef.current;
      if (!buf) return;
      const sid = useTerminalStore
        .getState()
        .tabs.find((t) => t.id === tabId)?.sessionId;
      if (!sid) return;
      blockBufRef.current = "";
      const content = stripAnsi(buf).replace(/[ \t\r\n]+$/, "");
      if (!content) return;
      void store
        .blockAppend({
          sessionId: sid,
          ptyId: ptyIdRef.current ?? undefined,
          kind: "output",
          content,
        })
        .catch((e) => console.warn("[persist] blockAppend failed", e));
    };

    unlisteners.push(
      on(PTY_DATA, (payload) => {
        if (payload.ptyId === ptyIdRef.current) {
          write(payload.data);
          // Accumulate for coarse block persistence; debounce the flush so the
          // DB is hit at most once per idle gap, never per PTY_DATA event.
          blockBufRef.current += payload.data;
          if (blockBufRef.current.length > BLOCK_BUF_CAP) {
            blockBufRef.current = blockBufRef.current.slice(-BLOCK_BUF_CAP);
          }
          if (blockTimerRef.current) clearTimeout(blockTimerRef.current);
          blockTimerRef.current = setTimeout(flushBlock, BLOCK_IDLE_MS);
          return;
        }
        if (ptyIdRef.current === null) {
          // Race-safe path: spawn hasn't returned yet. Buffer the chunk;
          // we'll replay it from the spawn `.then` once we know our id.
          const arr = pendingDataRef.current.get(payload.ptyId) ?? [];
          arr.push(payload.data);
          pendingDataRef.current.set(payload.ptyId, arr);
        }
      }),
    );
    unlisteners.push(
      on(PTY_EXIT, (payload) => {
        if (payload.ptyId !== ptyIdRef.current) return;
        // Persist the final output burst before the pane goes inert.
        if (blockTimerRef.current) clearTimeout(blockTimerRef.current);
        flushBlock();
        // The shell is gone: drop its write queue and rewind any modes the
        // dying process left latched so the pane ends in a sane state.
        disposePtyWriter(payload.ptyId);
        const term = getTerm(tabId);
        if (term) healTerminalModes(term);
        setStatus(tabId, "exited", payload.code);
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
        setCwd(tabId, payload.cwd);
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
      // Persist the last buffered output on unmount (tab close / nav away).
      if (blockTimerRef.current) clearTimeout(blockTimerRef.current);
      flushBlock();
      unlisteners.forEach((p) => {
        p.then((un) => un()).catch(() => undefined);
      });
    };
    // Depend only on the primitive tab id + the stable `write` callback (and the
    // stable zustand setters) so listeners persist across cwd/status churn and
    // term re-creation — ptyIdRef + write target the freshest id/term anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab?.id, xterm.write, setStatus, setCwd]);

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

  // Send the clipboard image to the CURRENT shell as a file by injecting a
  // base64-decode command into the PTY. This is the only transfer mechanism
  // that travels through an SSH session transparently (no scp/credentials):
  // the command runs in whatever shell is active — local OR the remote box —
  // so the screenshot lands on the remote filesystem and Claude Code (running
  // there) can read it via `@~/.vibe-shots/<id>.png`.
  const sendImageToShell = useCallback(
    async () => {
      const id = ptyIdRef.current;
      if (!id) return;
      let meta: ImageMeta | null = null;
      try {
        meta = await images.pasteFromClipboard();
      } catch (err) {
        console.warn("[terminal] clipboard image read failed", err);
      }
      if (!meta) {
        toast.info("No image in clipboard");
        return;
      }
      let b64: string;
      try {
        b64 = await images.getBase64(meta.id);
      } catch (err) {
        toast.error("Could not read image bytes");
        console.warn("[terminal] getBase64 failed", err);
        return;
      }
      // Strip a possible data-URL prefix.
      b64 = b64.replace(/^data:[^,]*,/, "");
      const remoteName = `${meta.id}.png`;
      // Heredoc avoids ARG_MAX limits for large payloads; the quoted tag means
      // the shell performs no expansion on the base64 body. `base64` is part of
      // GNU coreutils / busybox so it's present on essentially every Linux box.
      const cmd =
        `mkdir -p ~/.vibe-shots && base64 -d > ~/.vibe-shots/${remoteName} <<'__VIBETERM_B64__'\n` +
        `${b64}\n` +
        `__VIBETERM_B64__\n` +
        `printf '\\n[vibe-term] image saved → %s/.vibe-shots/${remoteName}\\n' "$HOME"\n`;
      setPreviewImage(meta);
      useTerminalStore.getState().attachImageToTab(tab!.id, meta);
      writePty(id, cmd);
      toast.success("Image sent to shell — reference it in Claude with @~/.vibe-shots/" + remoteName);
    },
    [tab],
  );

  // ── Clipboard paste + copy handling ────────────────────────────────
  // Clipboard INSERTION happens in ONE place — the browser `paste` event — so
  // text is inserted exactly once. (The old code pasted manually in keydown AND
  // let xterm's native paste fire too → every paste was doubled.) The keydown
  // handler only records intent and suppresses the raw ^V control byte.
  //
  //   • Ctrl+V / Ctrl+Shift+V + text  → paste the text once.
  //   • Ctrl+V / Ctrl+Shift+V + image → insert the functional
  //                          `@~/.vibe-shots/<id>.png` mention INSTANTLY (Claude
  //                          Code reads the image from it), BOTH local and SSH.
  //                          SSH: upload to that path in the BACKGROUND. Local:
  //                          copy the file into ~/.vibe-shots/ (instant), falling
  //                          back to `ESC v` (Alt+V) if the copy fails.
  //   • Ctrl+Alt+V        → stream the image through the PTY (base64) to the
  //                          current (possibly remote) shell.
  //   • Alt+V             → passes straight through to the program.
  //   • Ctrl+C + selection → copy (instead of SIGINT); no selection → ^C.
  useEffect(() => {
    const term = xterm.term;
    const container = containerRef.current;
    if (!term || !tab || !container) return;

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;

      // Ctrl+C with an active selection → copy it instead of sending SIGINT.
      // This is what lets the user copy text an SSH/AI session printed. With no
      // selection, fall through so ^C still interrupts the foreground program.
      // (If a TUI has mouse reporting on, shift+drag forces a local selection.)
      if (
        ev.ctrlKey &&
        !ev.shiftKey &&
        !ev.altKey &&
        (ev.key === "c" || ev.key === "C")
      ) {
        const sel = term.getSelection();
        if (sel) {
          void copyText(sel);
          term.clearSelection();
          return false;
        }
        return true;
      }

      const isV = ev.key === "v" || ev.key === "V";
      if (!isV) return true;

      // Ctrl+Alt+V → stream the image through the PTY to the current shell. No
      // native paste event fires for an Alt combo, so we trigger it here.
      if (ev.ctrlKey && ev.altKey) {
        ev.preventDefault();
        void sendImageToShell();
        return false;
      }
      if (ev.altKey) return true; // plain Alt+V → pass through (local claude)

      // Ctrl+V / Ctrl+Shift+V → defer the actual insert to the `paste` event
      // (the single source of truth). Record intent and return false so xterm
      // does NOT emit ^V (0x16); the browser still dispatches `paste`.
      if (ev.ctrlKey) {
        pasteModeRef.current = ev.shiftKey ? "path" : "auto";
        return false;
      }
      return true;
    });

    // ── Wheel: reliable scrolling + escape hatch + leak detection ─────
    // xterm consults this handler FIRST, even while a mouse protocol owns
    // the wheel. Three responsibilities:
    //   1. In the normal buffer with no mouse protocol, drive the buffer via
    //      term.scrollLines OURSELVES and cancel the default. xterm's default
    //      path routes the wheel through the DOM scrollbar element, whose
    //      scrollTop is re-synced to the bottom on every write — while output
    //      streams (claude responding, a build running) that race EATS every
    //      wheel notch and the user simply cannot scroll up. The buffer-level
    //      API is immune (verified: 5 real notches = 0 movement, one
    //      scrollLines call = detaches and holds).
    //   2. Shift+wheel ALWAYS scrolls locally — the universal escape hatch
    //      when a TUI (or a leaked mouse mode) owns the wheel.
    //   3. A wheel arriving while the emulator is in a TUI-only state
    //      schedules the orphan probe that auto-heals leaked modes.
    const wheelLines = (ev: WheelEvent): number => {
      const raw =
        ev.deltaMode === WheelEvent.DOM_DELTA_LINE ? ev.deltaY : ev.deltaY / 40;
      return Math.round(raw) || (ev.deltaY > 0 ? 1 : -1);
    };
    term.attachCustomWheelEventHandler((ev) => {
      if (ev.shiftKey) {
        term.scrollLines(wheelLines(ev));
        return false;
      }
      if (term.modes.mouseTrackingMode !== "none") {
        // A program consumes the wheel (fzf, tmux…) — forward it, but if the
        // state smells leaked, probe & heal for the NEXT notch.
        if (isTerminalStateSuspicious(term)) void leakCheck();
        return true;
      }
      if (term.buffer.active.type === "alternate") {
        // Alt screen without mouse protocol: xterm translates wheel→arrows
        // (how less/vim scroll). Keep it, but probe for an orphaned leak.
        if (isTerminalStateSuspicious(term)) void leakCheck();
        return true;
      }
      term.scrollLines(wheelLines(ev));
      // Scrolling works immediately even in a leaked state (we drive the
      // buffer directly), but 2004/1004/DECCKM leaks still corrupt pastes
      // and focus changes — probe & heal them here too.
      if (isTerminalStateSuspicious(term)) void leakCheck();
      return false;
    });

    // The one place clipboard content is inserted. Capture phase so we run
    // before xterm's own paste handler and can suppress it when WE handle the
    // insert (images / path), while letting plain text fall through to xterm.
    const onPaste = (e: ClipboardEvent) => {
      const mode = pasteModeRef.current;
      pasteModeRef.current = "auto";
      const items = e.clipboardData?.items;
      const hasImage =
        !!items && Array.from(items).some((it) => it.type.startsWith("image/"));
      // Capture the text payload SYNCHRONOUSLY — `e.clipboardData` is neutered
      // once this handler returns, so we can't read it from inside the async
      // IIFE below. Lets the text path skip a redundant clipboard round-trip.
      const inlineText = e.clipboardData?.getData("text/plain") ?? "";

      // Plain Ctrl+V with text → let xterm's native paste insert it ONCE.
      if (mode === "auto" && !hasImage) {
        // …unless bracketed paste looks LEAKED (mode latched in the normal
        // buffer): a dumb prompt would then receive literal `200~…201~`
        // around the text. Confirm the orphan state (bounded to 250ms so a
        // legit remote shell never feels it), heal, then paste exactly once.
        if (
          term.modes.bracketedPasteMode &&
          term.buffer.active.type === "normal"
        ) {
          e.preventDefault();
          e.stopImmediatePropagation();
          void (async () => {
            await Promise.race([
              leakCheck(true),
              new Promise((r) => setTimeout(r, 250)),
            ]);
            const text = inlineText || (await readText()) || "";
            if (text) term.paste(text);
          })();
        }
        return;
      }

      // We take over: block xterm's default paste so there is no double insert.
      e.preventDefault();
      e.stopImmediatePropagation();
      const id = ptyIdRef.current;
      if (!id) return;

      void (async () => {
        try {
          // No image on the clipboard → plain text paste (covers Ctrl+Shift+V
          // with text). Reads the OS clipboard so it works even when the browser
          // strips content from a "paste as plain text" event.
          if (!hasImage) {
            const text = inlineText || (await readText()) || "";
            if (text) term.paste(text);
            return;
          }

          // Screenshot paste (Ctrl+V or Ctrl+Shift+V with an image). Detect SSH
          // and read the clipboard image CONCURRENTLY — the SSH-host scan used
          // to block the whole paste, which killed fluidity over SSH.
          const [sshHost, meta] = await Promise.all([
            detectSshHost(id),
            images.pasteFromClipboard(),
          ]);
          if (!meta) {
            toast.info("No image in clipboard");
            return;
          }
          setPreviewImage(meta);
          useTerminalStore.getState().attachImageToTab(tab.id, meta);

          // Insert the functional @-mention (SSH-aware). `sshHost` was detected
          // in parallel with the clipboard read above, so we pass it through to
          // skip a second remote-process scan. The shared helper inserts the
          // path INSTANTLY and uploads (SSH) / stages (local) so the paste never
          // stalls; it's the SAME code the gallery drag/drop uses.
          await insertImageIntoTerminal(id, meta.path, sshHost);
        } catch (err) {
          toast.error(
            err instanceof Error ? err.message : "Image paste failed",
          );
        }
      })();
    };
    container.addEventListener("paste", onPaste, true);

    // copyOnSelect — mirror any terminal selection straight to the clipboard.
    // Read the flag live from the store so toggling it needs no re-subscribe.
    // onSelectionChange fires on every mousemove that mutates the selection
    // during a drag (and on the auto-scroll tick) — not just on mouse-up — so
    // serialising the whole selection + writing it over the clipboard IPC on
    // each event floods the bridge and stutters the drag. Defer to a trailing
    // timer so only the settled selection is copied once.
    let copyTimer: ReturnType<typeof setTimeout> | null = null;
    const selDispose = term.onSelectionChange(() => {
      if (!useConfigStore.getState().settings?.terminal.copyOnSelect) return;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        const s = term.getSelection();
        if (s) void copyText(s);
      }, 150);
    });

    // rightClickPaste — paste the clipboard on context-menu. A contextmenu event
    // carries no clipboardData, so read the OS clipboard directly.
    const onContextMenu = (e: MouseEvent) => {
      if (!useConfigStore.getState().settings?.terminal.rightClickPaste) return;
      e.preventDefault();
      const id = ptyIdRef.current;
      if (!id) return;
      void (async () => {
        const text = await readText();
        if (text) term.paste(text);
      })();
    };
    container.addEventListener("contextmenu", onContextMenu);

    // Gallery drag-and-drop — a thumbnail dragged from the ImageGallery carries
    // its image id under GALLERY_DRAG_MIME. Accept the drop on THIS pane and
    // insert it through the SAME SSH/local path the paste handler uses, so a
    // screenshot dropped into a specific (possibly remote) pane just works.
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      if (Array.from(e.dataTransfer.types).includes(GALLERY_DRAG_MIME)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    };
    const onDrop = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (!dt || !Array.from(dt.types).includes(GALLERY_DRAG_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      const imageId = dt.getData(GALLERY_DRAG_MIME);
      const id = ptyIdRef.current;
      if (!id) return;
      const meta = useImageStore.getState().get(imageId);
      const localPath = meta?.path ?? dt.getData("text/plain");
      if (!localPath) return;
      if (meta) {
        setPreviewImage(meta);
        useTerminalStore.getState().attachImageToTab(tab.id, meta);
      }
      void insertImageIntoTerminal(id, localPath);
      term.focus();
    };
    container.addEventListener("dragover", onDragOver);
    container.addEventListener("drop", onDrop);

    return () => {
      container.removeEventListener("paste", onPaste, true);
      container.removeEventListener("contextmenu", onContextMenu);
      container.removeEventListener("dragover", onDragOver);
      container.removeEventListener("drop", onDrop);
      if (copyTimer) clearTimeout(copyTimer);
      selDispose.dispose();
    };
  }, [tab, xterm.term, sendImageToShell, leakCheck]);

  if (!tab) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-fg-subtle">
        Tab not found.
      </div>
    );
  }

  return (
    <div className="vibe-terminal-root" data-tab-id={tabId}>
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
