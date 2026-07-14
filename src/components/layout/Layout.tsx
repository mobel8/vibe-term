import { useCallback, useEffect, useRef, useState } from "react";

import type { ShellInfo } from "@/ipc";
import {
  CONFIG_CHANGED,
  HOTKEY_TRIGGERED,
  IMAGE_ADDED,
  appInfo,
  config as configIpc,
  exportSession as exportSessionIpc,
  images as imagesIpc,
  on,
  pty,
  store as storeIpc,
} from "@/ipc";
import { useTerminalStore } from "@/state/terminalStore";
import { useAiStore } from "@/state/aiStore";
import { useImageStore } from "@/state/imageStore";
import { normalizeBindings, useConfigStore } from "@/state/configStore";
import { useHotkeysStore } from "@/state/hotkeysStore";
import { useTheme } from "@/lib/theme";
import { matchEvent, parseCombo, type Combo } from "@/lib/hotkeys";
import { writePty } from "@/lib/pty-writer";
import { getTerm } from "@/lib/terminal-registry";
import { healTerminalModes } from "@/lib/terminal-heal";
import { requestTabClose } from "@/lib/tab-close";
import { toast } from "@/state/toastStore";

import { AISidebar } from "@/components/ai/AISidebar";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { SearchDialog } from "@/components/search/SearchDialog";
import { DropZoneOverlay } from "@/components/images/DropZoneOverlay";
import { ImageGallery } from "@/components/images/ImageGallery";
import { Lightbox } from "@/components/images/Lightbox";
import { ScreenshotRegion } from "@/components/images/ScreenshotRegion";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { FirstRunWizard } from "@/components/onboarding/FirstRunWizard";
import { useFirstRun } from "@/components/onboarding/useFirstRun";
import { ToastContainer } from "@/components/ui/Toast";

import { ShellPicker } from "./ShellPicker";
import { SplitContainer } from "./SplitContainer";
import type { SplitContainerHandle, SplitDirection } from "./SplitContainer";
import { StatusBar } from "./StatusBar";

interface ParsedBinding {
  action: string;
  combo: Combo;
}

/**
 * Parse an action→combo map into matchable bindings, dropping malformed
 * entries and — crucially — bare printable keys: a binding like `"r"` or
 * `"Shift+A"` would hijack normal typing inside the terminal, so a single
 * -character key requires Ctrl/Alt/Meta.
 */
function parseBindings(bindings: Record<string, string>): ParsedBinding[] {
  const out: ParsedBinding[] = [];
  for (const [action, spec] of Object.entries(bindings)) {
    if (!spec) continue;
    try {
      const combo = parseCombo(spec);
      if (!combo.ctrl && !combo.alt && !combo.meta && combo.key.length === 1) {
        console.warn(
          `[hotkeys] ignoring binding for "${action}": "${spec}" would capture plain typing`,
        );
        continue;
      }
      out.push({ action, combo });
    } catch (err) {
      console.warn(`[hotkeys] skipping invalid combo for "${action}":`, err);
    }
  }
  return out;
}

// Used until the config store hydrates so shortcuts work from frame 1.
const FALLBACK_BINDINGS: ParsedBinding[] = parseBindings(
  normalizeBindings(undefined),
);

/** The active tab's live xterm instance, if any. */
function activeTerm() {
  const id = useTerminalStore.getState().activeTabId;
  return id ? getTerm(id) : undefined;
}

/**
 * Root layout: shell picker / tab bar (via Dockview chrome), terminal split
 * area, AI sidebar (Phase 6) and a status bar. Also mounts every app-level
 * overlay — command palette, settings, lightbox, drop-zone, toast container,
 * first-run wizard — and wires the global Tauri event listeners (image added,
 * hotkey triggered, config changed) plus the keyboard hotkey runtime.
 *
 * Window-level shortcuts (Ctrl+T, Ctrl+W, Ctrl+Shift+D|E, Ctrl+I) are bound
 * directly here so they fire even when focus is inside the xterm canvas. The
 * `setupHotkeys` runtime owns the config-driven, rebindable surface — they
 * coexist without overlap because the rebindable actions don't include the
 * raw terminal lifecycle combos.
 */
export function Layout() {
  const splitRef = useRef<SplitContainerHandle | null>(null);
  const shellsRef = useRef<ShellInfo[]>([]);

  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const newTabAction = useTerminalStore((s) => s.newTab);
  const closeTabAction = useTerminalStore((s) => s.closeTab);

  const aiOpen = useAiStore((s) => s.isOpen);
  const togglePanel = useAiStore((s) => s.togglePanel);
  const stageImage = useAiStore((s) => s.stageImage);

  // Palette AI commands — all funnel through the aiStore actions so palette
  // and sidebar behaviour can never drift.
  const activeSessionId = useCallback((): string | null => {
    const st = useTerminalStore.getState();
    return st.tabs.find((t) => t.id === st.activeTabId)?.sessionId ?? null;
  }, []);
  const paletteNewConversation = useCallback(() => {
    const ai = useAiStore.getState();
    ai.togglePanel(true);
    const convId = ai.openConversation(activeSessionId());
    // openConversation reuses the session's conversation — "new" means a
    // clean slate, so reset it explicitly.
    useAiStore.getState().resetConversation(convId);
  }, [activeSessionId]);
  const paletteSendSelectionToAi = useCallback(() => {
    const term = activeTerm();
    const selection = term?.getSelection().trim();
    if (!selection) {
      toast.info("Select some terminal text first");
      return;
    }
    const ai = useAiStore.getState();
    ai.togglePanel(true);
    const convId = ai.openConversation(activeSessionId());
    void useAiStore.getState().sendCurrent(selection, convId);
  }, [activeSessionId]);
  const paletteSwitchModel = useCallback(() => {
    // The model picker lives in the sidebar header — surface it.
    useAiStore.getState().togglePanel(true);
    toast.info("Pick a provider/model in the AI panel header");
  }, []);

  const hydrateImage = useImageStore((s) => s.hydrate);
  const lightboxId = useImageStore((s) => s.lightboxId);

  const loadConfig = useConfigStore((s) => s.load);
  const settings = useConfigStore((s) => s.settings);

  const hotkeyBindings = useHotkeysStore((s) => s.bindings);
  const bulkSetBindings = useHotkeysStore((s) => s.bulkSetBindings);
  const dispatchHotkey = useHotkeysStore((s) => s.dispatch);

  // Theme runtime — applies the persisted theme to `document.documentElement`
  // (and pushes the palette into live terminals); toggleTheme backs the
  // palette's "Switch theme" command.
  const { toggleTheme } = useTheme();

  const firstRun = useFirstRun();

  // ── App-level UI state ────────────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [regionPicker, setRegionPicker] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);

  // Preload the detected shells — used by Ctrl+T / splits if the user hasn't
  // picked one explicitly. The configured `general.defaultShell` wins when it
  // matches a detected shell; otherwise the first detected shell is used.
  useEffect(() => {
    let cancelled = false;
    pty
      .listShells()
      .then((list) => {
        if (cancelled) return;
        shellsRef.current = list;
      })
      .catch((err: unknown) => {
        console.warn("[layout] pty.listShells failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Resolve the shell for a NEW tab: honor `general.defaultShell` (matched
  // against the detected list, case-insensitively) before falling back to the
  // first detected shell. Read live so a settings change applies immediately.
  const pickDefaultShell = useCallback((): ShellInfo | null => {
    const list = shellsRef.current;
    const configured = useConfigStore
      .getState()
      .settings?.general.defaultShell?.trim();
    if (configured) {
      const match = list.find(
        (s) => s.path.toLowerCase() === configured.toLowerCase(),
      );
      if (match) return match;
      console.warn(
        `[layout] configured defaultShell not detected: ${configured}; using first detected shell`,
      );
    }
    return list[0] ?? null;
  }, []);

  // Starting directory for a brand-new tab (not a split — splits inherit the
  // active pane's cwd first): the configured workingDirectory, else $HOME.
  const defaultCwd = useCallback((): string | null => {
    return (
      useConfigStore.getState().settings?.general.workingDirectory?.trim() ||
      null
    );
  }, []);

  // Hydrate config once at mount; the store auto-subscribes to CONFIG_CHANGED.
  useEffect(() => {
    void loadConfig().catch((err: unknown) => {
      console.warn("[layout] failed to load config", err);
    });
  }, [loadConfig]);

  // Mirror config.hotkeys into the runtime hotkeys store the first time the
  // settings tree resolves (subsequent edits flow through the same path).
  // normalizeBindings fills actions added in newer builds and migrates the
  // legacy swapped split pair.
  useEffect(() => {
    if (!settings) return;
    bulkSetBindings(normalizeBindings(settings.hotkeys));
  }, [settings, bulkSetBindings]);

  const openTab = useCallback(
    (shell: ShellInfo, cwd: string | null = null) => {
      const tab = newTabAction(shell, cwd ?? defaultCwd());
      // Dockview reconciliation runs via the effect inside SplitContainer; we
      // still proactively open the panel for snappy UX.
      splitRef.current?.newTab(tab.id, tab.title);
      return tab;
    },
    [newTabAction, defaultCwd],
  );

  const splitActiveTab = useCallback(
    (direction: SplitDirection) => {
      const active = useTerminalStore
        .getState()
        .tabs.find((t) => t.id === useTerminalStore.getState().activeTabId);
      const shell = active?.shell ?? pickDefaultShell();
      if (!shell) {
        console.warn("[layout] no shell available to split");
        return;
      }
      const tab = newTabAction(shell, active?.cwd ?? defaultCwd());
      splitRef.current?.split(tab.id, tab.title, direction);
    },
    [newTabAction, pickDefaultShell, defaultCwd],
  );

  const closeActiveTab = useCallback(() => {
    const id = useTerminalStore.getState().activeTabId;
    if (!id) return;
    // Confirm-on-close gate (general.confirmOnClose + live child processes),
    // then the backend PTY is reaped inside terminalStore.closeTab (the single
    // chokepoint every removal path reaches) — no PTY leak either way.
    void requestTabClose(id, () => {
      const handle = splitRef.current;
      if (handle) handle.closeTab(id);
      else closeTabAction(id);
    });
  }, [closeTabAction]);

  // When the last tab closes, showHero flips to true and SplitContainer
  // unmounts — Dockview's wrapper disposes its api in its effect cleanup. But
  // splitRef.current (set only in onReady) keeps pointing at that now-dead
  // handle, so the next openTab would proactively call newTab() on a disposed
  // Dockview instance (addPanel on a torn-down gridview → possible throw).
  // Null it here so the next open falls through to the freshly-mounted
  // container's reconcile effect, which creates the panel anyway.
  useEffect(() => {
    if (tabs.length === 0) splitRef.current = null;
  }, [tabs.length]);

  // ── Window-level hotkeys (capture phase, config-driven) ──────────────
  // ONE dispatcher owns every app shortcut, in the CAPTURE phase so combos
  // win over xterm's textarea before any bytes leak into the shell (a
  // bubble-phase runtime let e.g. Ctrl+Alt+S reach the terminal first). It
  // matches the LIVE rebindable bindings (settings → hotkeys store) and
  // dispatches by action id — rebinding in Settings now genuinely rebinds.
  const parsedBindingsRef = useRef<ParsedBinding[]>([]);
  useEffect(() => {
    parsedBindingsRef.current = parseBindings(hotkeyBindings);
  }, [hotkeyBindings]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't hijack keys destined for an app-level editable field or its
      // owning modal — settings inputs, the AI composer, the search box, the
      // hotkey-capture field. The xterm helper textarea is the deliberate
      // exception: window shortcuts MUST still win there (that's the whole
      // reason this listener runs in the capture phase).
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable) &&
        !target.classList.contains("xterm-helper-textarea")
      ) {
        return;
      }

      // Windows-Terminal-style split combos (physical-key matches so they are
      // layout-independent; kept as fixed aliases beside the rebindable ones).
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) {
        // Right / side-by-side. `e.code === "Equal"` is layout-independent.
        if (e.key === "+" || e.key === "=" || e.code === "Equal") {
          e.preventDefault();
          e.stopPropagation();
          splitActiveTab("horizontal");
          return;
        }
        // Down / stacked. On French AZERTY the "-" character lives on the Digit6
        // physical key (Shift turns it into "6"), so match Digit6 too.
        if (
          e.key === "-" ||
          e.key === "_" ||
          e.code === "Minus" ||
          e.code === "Digit6"
        ) {
          e.preventDefault();
          e.stopPropagation();
          splitActiveTab("vertical");
          return;
        }
      }

      const mod = e.ctrlKey || e.metaKey;
      // Fixed aliases (not in the rebindable canon): Ctrl+Shift+W mirrors
      // Windows Terminal's close-pane; Ctrl+Shift+G toggles the gallery.
      if (mod && e.shiftKey && !e.altKey && e.code === "KeyW") {
        e.preventDefault();
        e.stopPropagation();
        closeActiveTab();
        return;
      }
      if (mod && e.shiftKey && !e.altKey && e.code === "KeyG") {
        e.preventDefault();
        e.stopPropagation();
        setGalleryOpen((v) => !v);
        return;
      }

      // Rebindable actions — falls back to the factory canon until the
      // config store hydrates so shortcuts work from the very first frame.
      const list =
        parsedBindingsRef.current.length > 0
          ? parsedBindingsRef.current
          : FALLBACK_BINDINGS;
      for (const { action, combo } of list) {
        if (matchEvent(e, combo)) {
          e.preventDefault();
          e.stopPropagation();
          dispatchHotkey(action);
          return;
        }
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [splitActiveTab, closeActiveTab, dispatchHotkey]);

  // ── Tauri-level global event listeners ────────────────────────────────
  // IMAGE_ADDED: backend emits this when a paste / drop / capture / sixel
  // image lands. We hydrate the local store cache so any subscribed component
  // (InlineImage, Lightbox, …) sees the new entry without a follow-up IPC.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    on(IMAGE_ADDED, (payload) => {
      void imagesIpc
        .get(payload.imageId)
        .then((meta) => {
          if (meta) hydrateImage(meta);
        })
        .catch(() => undefined);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err: unknown) => {
        console.warn("[layout] IMAGE_ADDED subscribe failed", err);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [hydrateImage]);

  // HOTKEY_TRIGGERED: the backend also publishes hotkey events (e.g. global
  // shortcuts registered via the plugin). Re-dispatch through the same store
  // so the runtime handler map drives both surfaces.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    on(HOTKEY_TRIGGERED, (payload) => {
      dispatchHotkey(payload.action);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err: unknown) => {
        console.warn("[layout] HOTKEY_TRIGGERED subscribe failed", err);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [dispatchHotkey]);

  // CONFIG_CHANGED: the configStore subscribes internally, but we still want
  // a thin listener here so the bindings table stays fresh even if the user
  // never opens settings (the bindings effect above handles propagation).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    on(CONFIG_CHANGED, (payload) => {
      bulkSetBindings(normalizeBindings(payload.settings.hotkeys));
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err: unknown) => {
        console.warn("[layout] CONFIG_CHANGED subscribe failed", err);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [bulkSetBindings]);

  // ── Command palette handler bag (memoised via inline construction) ────
  const paletteHandlers = {
    newTab: () => {
      const shell = pickDefaultShell();
      if (shell) openTab(shell);
    },
    closeTab: closeActiveTab,
    splitHorizontal: () => splitActiveTab("horizontal"),
    splitVertical: () => splitActiveTab("vertical"),
    // Clear = wipe scrollback + viewport (like `clear`/Ctrl+L, but works even
    // when a wedged TUI ignores input). Reset = rewind leaked terminal modes
    // (mouse tracking / bracketed paste / alt screen / hidden cursor).
    clearTerminal: () => {
      const term = activeTerm();
      if (!term) return;
      term.clear();
      term.focus();
    },
    resetTerminal: () => {
      const term = activeTerm();
      if (!term) return;
      healTerminalModes(term);
      term.focus();
      toast.success("Terminal state reset (modes rewound)");
    },
    searchHistory: () => setSearchOpen((v) => !v),
    toggleAiPanel: () => togglePanel(),
    newConversation: paletteNewConversation,
    sendSelectionToAi: paletteSendSelectionToAi,
    switchModel: paletteSwitchModel,
    openSettings: () => setSettingsOpen(true),
    switchTheme: () => {
      void toggleTheme();
    },
    openConfigFile: () => {
      void (async () => {
        try {
          const [{ open }, path] = await Promise.all([
            import("@tauri-apps/plugin-shell"),
            configIpc.path(),
          ]);
          await open(path);
        } catch (err) {
          toast.error(
            err instanceof Error ? err.message : "Could not open config file",
          );
        }
      })();
    },
    openLogs: () => {
      void (async () => {
        try {
          const [{ open }, { appLogDir }] = await Promise.all([
            import("@tauri-apps/plugin-shell"),
            import("@tauri-apps/api/path"),
          ]);
          await open(await appLogDir());
        } catch (err) {
          toast.error(
            err instanceof Error ? err.message : "Could not open logs folder",
          );
        }
      })();
    },
    openDocs: () => {
      void (async () => {
        try {
          const { open } = await import("@tauri-apps/plugin-shell");
          await open("https://github.com/mobel8/vibe-term#readme");
        } catch (err) {
          toast.error(
            err instanceof Error ? err.message : "Could not open documentation",
          );
        }
      })();
    },
    openShortcuts: () => setSettingsOpen(true),
    openAbout: () => {
      void appInfo()
        .then((info) =>
          toast.info(`${info.name} ${info.version} (${info.targetOs}/${info.targetArch})`),
        )
        .catch(() => toast.info("vibe-term"));
    },
    screenshotRegion: () => setRegionPicker(true),
    pasteImage: () => {
      void imagesIpc
        .pasteFromClipboard()
        .then((meta) => {
          if (meta) {
            hydrateImage(meta);
            const inserted = insertIntoActiveTerminal(meta.path);
            toast.success(
              inserted ? `Image ${meta.id} → inserted path` : `Image ${meta.id} attached`,
            );
          } else {
            toast.info("Clipboard has no image");
          }
        })
        .catch((err: unknown) => {
          toast.error(
            err instanceof Error ? err.message : "Failed to paste image",
          );
        });
    },
    screenshotFull: () => {
      void imagesIpc
        .captureScreen({ kind: "fullscreen" })
        .then((meta) => {
          hydrateImage(meta);
          // Drop the path into the active terminal so a running CLI (claude…)
          // can pick the screenshot up immediately.
          const inserted = insertIntoActiveTerminal(meta.path);
          toast.success(
            inserted ? `Captured ${meta.id} → inserted path` : `Captured ${meta.id}`,
          );
        })
        .catch((err: unknown) => {
          toast.error(
            err instanceof Error ? err.message : "Screenshot failed",
          );
        });
    },
    exportSessionMarkdown: () => {
      void runExportDialog("markdown");
    },
    exportSessionHtml: () => {
      void runExportDialog("html");
    },
  };

  // Keep a ref to the latest handler bag so the register effect below can run
  // once (stable closures) yet always dispatch to the current handlers.
  const paletteHandlersRef = useRef(paletteHandlers);
  paletteHandlersRef.current = paletteHandlers;

  // ── Wire the rebindable-action handlers into the hotkeys runtime ──────
  // The hotkeys store dispatches by action NAME via a handler registry. Until
  // now NOTHING called register(), so the registry was always empty and every
  // config-driven (rebindable) binding — and the actions with no hardcoded
  // window combo at all (screenshot_region/full) — was a silent no-op. Register
  // the canonical handler for each action once at mount. (command_palette is
  // intentionally absent: CommandPalette owns its own toggle listener.)
  useEffect(() => {
    const reg = useHotkeysStore.getState().register;
    const h = paletteHandlersRef;
    const unregs = [
      reg("new_tab", () => h.current.newTab()),
      reg("close_tab", () => h.current.closeTab()),
      reg("split_horizontal", () => h.current.splitHorizontal()),
      reg("split_vertical", () => h.current.splitVertical()),
      reg("toggle_ai_panel", () => h.current.toggleAiPanel()),
      reg("search_history", () => setSearchOpen((v) => !v)),
      reg("screenshot_region", () => h.current.screenshotRegion()),
      reg("screenshot_full", () => h.current.screenshotFull()),
      reg("open_settings", () => setSettingsOpen(true)),
      // No default combos, but registered so users can bind them in config.
      reg("clear_terminal", () => h.current.clearTerminal()),
      reg("reset_terminal", () => h.current.resetTerminal()),
    ];
    return () => unregs.forEach((u) => u());
  }, []);

  // Write text straight into the active terminal's PTY stdin (it echoes back
  // like typed input). Used to drop screenshot/image file paths into whatever
  // CLI is running — `claude` and friends auto-detect pasted image paths.
  function insertIntoActiveTerminal(text: string): boolean {
    const id = useTerminalStore.getState().activeTabId;
    if (!id) return false;
    const ptyId = useTerminalStore.getState().tabs.find((t) => t.id === id)?.ptyId;
    if (!ptyId) return false;
    // Serialized writer: inserting a path must never splice into in-flight
    // keystrokes / TUI query replies (the parasitic-characters bug).
    writePty(ptyId, text);
    return true;
  }

  // Resolve the most-recent session, prompt for a save path via the Tauri
  // dialog, then write it through `export_session_to_file`. We avoid pulling
  // in a session picker UI for now — the typical workflow is "export the
  // session I just ran", which is the most recent.
  async function runExportDialog(format: "markdown" | "html") {
    try {
      const sessions = await storeIpc.sessionList(1);
      if (sessions.length === 0) {
        toast.info(
          "No session to export yet. Sessions persist once command blocks are recorded.",
        );
        return;
      }
      const session = sessions[0];
      const dialog = await import("@tauri-apps/plugin-dialog");
      const ext = format === "markdown" ? "md" : "html";
      const defaultName = `${session.name.replace(/[^\w.-]+/g, "_")}.${ext}`;
      const outputPath = await dialog.save({
        title: `Export "${session.name}" as ${format.toUpperCase()}`,
        defaultPath: defaultName,
        filters: [
          {
            name: format === "markdown" ? "Markdown" : "HTML",
            extensions: [ext],
          },
        ],
      });
      if (!outputPath) return; // user cancelled
      await exportSessionIpc.toFile({
        sessionId: session.id,
        outputPath,
        format,
      });
      toast.success(`Exported "${session.name}" → ${outputPath}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Export failed: ${String(err)}`);
    }
  }

  const showHero = tabs.length === 0;

  return (
    <div className="flex h-full w-full flex-col bg-bg text-fg">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-bg-subtle px-3">
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs font-semibold text-accent">
            vibe-term
          </span>
          {!showHero && (
            <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
              {tabs.length} tab{tabs.length === 1 ? "" : "s"}
              {activeTabId ? "" : " · idle"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!showHero && (
            <ShellPicker
              onSelect={(shell) => openTab(shell)}
              hideLabel
              variant="compact"
            />
          )}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="rounded border border-border px-2 py-0.5 font-mono text-[11px] text-fg-muted hover:bg-bg-elevated"
            title="Open settings (Ctrl+,)"
            aria-label="Open settings"
          >
            ⚙
          </button>
          <button
            type="button"
            onClick={() => setGalleryOpen((v) => !v)}
            className="rounded border border-border px-2 py-0.5 font-mono text-[11px] text-fg-muted hover:bg-bg-elevated"
            aria-pressed={galleryOpen}
            title="Toggle image gallery (Ctrl+Shift+G)"
            aria-label="Toggle image gallery"
          >
            🖼
          </button>
          <button
            type="button"
            onClick={() => togglePanel()}
            className="rounded border border-border px-2 py-0.5 font-mono text-[11px] text-fg-muted hover:bg-bg-elevated"
            aria-pressed={aiOpen}
            title="Toggle AI sidebar (Ctrl+I)"
          >
            AI
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="relative flex-1 overflow-hidden">
          {showHero ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-6 px-6 text-center">
              <div className="flex flex-col items-center gap-1">
                <h1 className="font-mono text-2xl font-semibold text-accent">
                  vibe-term
                </h1>
                <p className="max-w-md text-sm text-fg-muted">
                  Pick a shell to spawn your first session. New tabs with{" "}
                  <kbd className="rounded border border-border px-1 font-mono text-[10px]">
                    Ctrl+T
                  </kbd>
                  , splits with{" "}
                  <kbd className="rounded border border-border px-1 font-mono text-[10px]">
                    Ctrl+Shift+D
                  </kbd>
                  /
                  <kbd className="rounded border border-border px-1 font-mono text-[10px]">
                    E
                  </kbd>
                  .
                </p>
              </div>
              <ShellPicker
                onSelect={(shell) => openTab(shell)}
                variant="hero"
              />
            </div>
          ) : (
            <SplitContainer
              onReady={(handle) => {
                splitRef.current = handle;
              }}
            />
          )}
        </main>

        {aiOpen && (
          <AISidebar
            sessionId={
              tabs.find((t) => t.id === activeTabId)?.sessionId ?? null
            }
          />
        )}

        {galleryOpen && (
          <ImageGallery onClose={() => setGalleryOpen(false)} />
        )}
      </div>

      <StatusBar />

      {/* ── App-level overlays ──────────────────────────────────────── */}
      <DropZoneOverlay />
      <CommandPalette handlers={paletteHandlers} bindings={hotkeyBindings} />
      <ToastContainer />

      {lightboxId !== null && (
        <Lightbox
          onSendToAi={(id) => {
            const meta = useImageStore.getState().cache.get(id);
            if (meta) stageImage(meta);
          }}
        />
      )}

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />

      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />

      {firstRun.needsOnboarding && (
        <FirstRunWizard
          open
          onFinish={firstRun.completeOnboarding}
          onSkip={firstRun.completeOnboarding}
        />
      )}

      {regionPicker && (
        <ScreenshotRegion
          onSelect={(mode) => {
            setRegionPicker(false);
            void imagesIpc
              .captureScreen(mode)
              .then((meta) => {
                hydrateImage(meta);
                const inserted = insertIntoActiveTerminal(meta.path);
                toast.success(
                  inserted ? `Captured ${meta.id} → inserted path` : `Captured ${meta.id}`,
                );
              })
              .catch((err: unknown) => {
                toast.error(
                  err instanceof Error ? err.message : "Screenshot failed",
                );
              });
          }}
          onCancel={() => setRegionPicker(false)}
        />
      )}

    </div>
  );
}

export default Layout;
