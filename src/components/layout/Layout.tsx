import { useCallback, useEffect, useRef, useState } from "react";

import type { ShellInfo } from "@/ipc";
import {
  CONFIG_CHANGED,
  HOTKEY_TRIGGERED,
  IMAGE_ADDED,
  images as imagesIpc,
  on,
  pty,
} from "@/ipc";
import { useTerminalStore } from "@/state/terminalStore";
import { useAiStore } from "@/state/aiStore";
import { useImageStore } from "@/state/imageStore";
import { useConfigStore } from "@/state/configStore";
import { useHotkeysStore } from "@/state/hotkeysStore";
import { useTheme } from "@/lib/theme";
import { setupHotkeys } from "@/lib/hotkeys";
import { toast } from "@/state/toastStore";

import { AISidebar } from "@/components/ai/AISidebar";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { DropZoneOverlay } from "@/components/images/DropZoneOverlay";
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
  const defaultShellRef = useRef<ShellInfo | null>(null);

  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const newTabAction = useTerminalStore((s) => s.newTab);
  const closeTabAction = useTerminalStore((s) => s.closeTab);

  const aiOpen = useAiStore((s) => s.isOpen);
  const togglePanel = useAiStore((s) => s.togglePanel);
  const stageImage = useAiStore((s) => s.stageImage);

  const hydrateImage = useImageStore((s) => s.hydrate);
  const lightboxId = useImageStore((s) => s.lightboxId);

  const loadConfig = useConfigStore((s) => s.load);
  const settings = useConfigStore((s) => s.settings);

  const hotkeyBindings = useHotkeysStore((s) => s.bindings);
  const bulkSetBindings = useHotkeysStore((s) => s.bulkSetBindings);
  const dispatchHotkey = useHotkeysStore((s) => s.dispatch);

  // Theme runtime — applies the persisted theme to `document.documentElement`
  // and reconciles with the OS scheme. Side-effect only at this level.
  useTheme();

  const firstRun = useFirstRun();

  // ── App-level UI state ────────────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [regionPicker, setRegionPicker] = useState(false);

  // Preload the first available shell — used by Ctrl+T / Ctrl+Shift+D|E if
  // the user hasn't picked one yet.
  useEffect(() => {
    let cancelled = false;
    pty
      .listShells()
      .then((list) => {
        if (cancelled) return;
        defaultShellRef.current = list[0] ?? null;
      })
      .catch((err: unknown) => {
        console.warn("[layout] pty.listShells failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Hydrate config once at mount; the store auto-subscribes to CONFIG_CHANGED.
  useEffect(() => {
    void loadConfig().catch((err: unknown) => {
      console.warn("[layout] failed to load config", err);
    });
  }, [loadConfig]);

  // Mirror config.hotkeys into the runtime hotkeys store the first time the
  // settings tree resolves (subsequent edits flow through the same path).
  useEffect(() => {
    if (!settings) return;
    bulkSetBindings(settings.hotkeys);
  }, [settings, bulkSetBindings]);

  const openTab = useCallback(
    (shell: ShellInfo, cwd: string | null = null) => {
      const tab = newTabAction(shell, cwd);
      // Dockview reconciliation runs via the effect inside SplitContainer; we
      // still proactively open the panel for snappy UX.
      splitRef.current?.newTab(tab.id, tab.title);
      return tab;
    },
    [newTabAction],
  );

  const splitActiveTab = useCallback(
    (direction: SplitDirection) => {
      const active = useTerminalStore
        .getState()
        .tabs.find((t) => t.id === useTerminalStore.getState().activeTabId);
      const shell = active?.shell ?? defaultShellRef.current;
      if (!shell) {
        console.warn("[layout] no shell available to split");
        return;
      }
      const tab = newTabAction(shell, active?.cwd ?? null);
      splitRef.current?.split(tab.id, tab.title, direction);
    },
    [newTabAction],
  );

  const closeActiveTab = useCallback(() => {
    const id = useTerminalStore.getState().activeTabId;
    if (!id) return;
    const handle = splitRef.current;
    if (handle) handle.closeTab(id);
    else closeTabAction(id);
    const ptyId = useTerminalStore
      .getState()
      .tabs.find((t) => t.id === id)?.ptyId;
    if (ptyId) {
      pty.kill(ptyId).catch(() => undefined);
    }
  }, [closeTabAction]);

  // ── Window-level hotkeys (raw, non-rebindable) ────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      // Ctrl+T → new tab
      if (!e.shiftKey && !e.altKey && (e.key === "t" || e.key === "T")) {
        e.preventDefault();
        const shell = defaultShellRef.current;
        if (shell) openTab(shell);
        return;
      }
      // Ctrl+W → close active tab
      if (!e.shiftKey && !e.altKey && (e.key === "w" || e.key === "W")) {
        e.preventDefault();
        closeActiveTab();
        return;
      }
      // Ctrl+Shift+D → split horizontal (right pane)
      if (e.shiftKey && !e.altKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        splitActiveTab("horizontal");
        return;
      }
      // Ctrl+Shift+E → split vertical (below pane)
      if (e.shiftKey && !e.altKey && (e.key === "E" || e.key === "e")) {
        e.preventDefault();
        splitActiveTab("vertical");
        return;
      }
      // Ctrl+I → toggle AI sidebar
      if (!e.shiftKey && !e.altKey && (e.key === "i" || e.key === "I")) {
        e.preventDefault();
        togglePanel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openTab, splitActiveTab, closeActiveTab, togglePanel]);

  // ── Config-driven (rebindable) hotkeys runtime ────────────────────────
  useEffect(() => {
    if (Object.keys(hotkeyBindings).length === 0) return;
    const teardown = setupHotkeys(hotkeyBindings, (action) => {
      dispatchHotkey(action);
    });
    return teardown;
  }, [hotkeyBindings, dispatchHotkey]);

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
      bulkSetBindings(payload.settings.hotkeys);
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
      const shell = defaultShellRef.current;
      if (shell) openTab(shell);
    },
    closeTab: closeActiveTab,
    splitHorizontal: () => splitActiveTab("horizontal"),
    splitVertical: () => splitActiveTab("vertical"),
    toggleAiPanel: () => togglePanel(),
    openSettings: () => setSettingsOpen(true),
    screenshotRegion: () => setRegionPicker(true),
    pasteImage: () => {
      void imagesIpc
        .pasteFromClipboard()
        .then((meta) => {
          if (meta) {
            hydrateImage(meta);
            toast.success(`Image ${meta.id} attached`);
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
          toast.success(`Captured ${meta.id}`);
        })
        .catch((err: unknown) => {
          toast.error(
            err instanceof Error ? err.message : "Screenshot failed",
          );
        });
    },
  };

  const showHero = tabs.length === 0;

  return (
    <div className="flex h-full w-full flex-col bg-bg text-zinc-100">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-bg-subtle px-3">
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs font-semibold text-accent">
            vibe-term
          </span>
          {!showHero && (
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
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
            className="rounded border border-border px-2 py-0.5 font-mono text-[11px] text-zinc-300 hover:bg-bg-elevated"
            title="Open settings (Ctrl+,)"
            aria-label="Open settings"
          >
            ⚙
          </button>
          <button
            type="button"
            onClick={() => togglePanel()}
            className="rounded border border-border px-2 py-0.5 font-mono text-[11px] text-zinc-300 hover:bg-bg-elevated"
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
                <p className="max-w-md text-sm text-zinc-400">
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
          <AISidebar sessionId={activeTabId} />
        )}
      </div>

      <StatusBar />

      {/* ── App-level overlays ──────────────────────────────────────── */}
      <DropZoneOverlay />
      <CommandPalette handlers={paletteHandlers} />
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
                toast.success(`Captured ${meta.id}`);
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
