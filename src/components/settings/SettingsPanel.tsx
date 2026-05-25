// vibe-term — Settings panel container.
//
// Full-screen modal that wraps the five tabs. Owns:
//   • hydration kick-off if the configStore is still empty,
//   • the active tab,
//   • debouncing of per-field patches into a single `config.update` round trip,
//   • surfacing a save toast at the bottom of the panel.
//
// Each tab is purely controlled (no internal config copy) so changes feel
// instant — we mutate the local working draft, debounce-sync to the backend,
// and let the store's `CONFIG_CHANGED` listener reconcile any drift.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { config } from "@/ipc";
import type { Settings } from "@/ipc";
import { Modal } from "@/components/ui/Modal";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { useConfigStore } from "@/state/configStore";

import { AdvancedTab } from "./AdvancedTab";
import { AiTab } from "./AiTab";
import { AppearanceTab } from "./AppearanceTab";
import { GeneralTab } from "./GeneralTab";
import { HotkeysTab } from "./HotkeysTab";

export type SettingsTabId =
  | "general"
  | "appearance"
  | "hotkeys"
  | "ai"
  | "advanced";

const TABS: TabItem[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "hotkeys", label: "Hotkeys" },
  { id: "ai", label: "AI" },
  { id: "advanced", label: "Advanced" },
];

const DEBOUNCE_MS = 500;
const TOAST_TIMEOUT_MS = 2_500;

export interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  /** Optional initial tab override (e.g. command palette deep-link). */
  initialTab?: SettingsTabId;
}

type Toast =
  | { kind: "none" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/**
 * Deep-merges a partial Settings patch into a Settings draft. Only one level
 * deep is needed because every sub-object in `Settings` has primitive leaves.
 */
function applyPatch(draft: Settings, patch: Partial<Settings>): Settings {
  return {
    general: patch.general ? { ...draft.general, ...patch.general } : draft.general,
    appearance: patch.appearance
      ? { ...draft.appearance, ...patch.appearance }
      : draft.appearance,
    hotkeys: patch.hotkeys ?? draft.hotkeys,
    ai: patch.ai ? { ...draft.ai, ...patch.ai } : draft.ai,
    terminal: patch.terminal
      ? { ...draft.terminal, ...patch.terminal }
      : draft.terminal,
  };
}

export function SettingsPanel({
  open,
  onClose,
  initialTab = "general",
}: SettingsPanelProps) {
  const settings = useConfigStore((s) => s.settings);
  const load = useConfigStore((s) => s.load);
  const isLoading = useConfigStore((s) => s.isLoading);
  const error = useConfigStore((s) => s.error);

  const [active, setActive] = useState<SettingsTabId>(initialTab);
  const [draft, setDraft] = useState<Settings | null>(settings);
  const [toast, setToast] = useState<Toast>({ kind: "none" });
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied">("idle");

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset draft to upstream whenever the modal is (re)opened OR the upstream
  // copy first arrives.
  useEffect(() => {
    if (open) setDraft(settings);
  }, [open, settings]);

  // Trigger a hydration if the store is empty and we just opened.
  useEffect(() => {
    if (!open) return;
    if (settings || isLoading) return;
    void load().catch(() => undefined);
  }, [open, settings, isLoading, load]);

  // Sync active tab when reopened with a different initialTab.
  useEffect(() => {
    if (open) setActive(initialTab);
  }, [open, initialTab]);

  useEffect(() => {
    let cancelled = false;
    config
      .path()
      .then((p) => {
        if (!cancelled) setConfigPath(p);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Cleanup outstanding timers on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  function flashToast(next: Toast, autoDismissMs?: number) {
    setToast(next);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    if (autoDismissMs) {
      toastTimerRef.current = setTimeout(() => {
        setToast({ kind: "none" });
      }, autoDismissMs);
    }
  }

  const flushSave = useCallback(
    async (patch: Partial<Settings>) => {
      flashToast({ kind: "saving" });
      try {
        await useConfigStore.getState().update(patch);
        flashToast({ kind: "saved" }, TOAST_TIMEOUT_MS);
      } catch (err) {
        flashToast({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        }, TOAST_TIMEOUT_MS * 2);
      }
    },
    [],
  );

  const onPatch = useCallback(
    (patch: Partial<Settings>) => {
      setDraft((cur) => (cur ? applyPatch(cur, patch) : cur));
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        void flushSave(patch);
      }, DEBOUNCE_MS);
    },
    [flushSave],
  );

  async function copyConfigPath() {
    if (!configPath) return;
    try {
      await navigator.clipboard.writeText(configPath);
      setCopyStatus("copied");
      setTimeout(() => setCopyStatus("idle"), 1_500);
    } catch {
      // Clipboard write can fail under restrictive policies; fail silently.
    }
  }

  const tabContent = useMemo(() => {
    if (!draft) return null;
    switch (active) {
      case "general":
        return <GeneralTab value={draft.general} onPatch={onPatch} />;
      case "appearance":
        return <AppearanceTab value={draft.appearance} onPatch={onPatch} />;
      case "hotkeys":
        return <HotkeysTab value={draft.hotkeys} onPatch={onPatch} />;
      case "ai":
        return <AiTab value={draft.ai} onPatch={onPatch} />;
      case "advanced":
        return <AdvancedTab />;
    }
  }, [active, draft, onPatch]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="settings-title"
      panelClassName="flex h-[88vh] w-[92vw] max-w-6xl flex-col"
    >
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex flex-col">
          <h2 id="settings-title" className="font-mono text-lg font-semibold text-zinc-100">
            Settings
          </h2>
          {configPath && (
            <button
              type="button"
              onClick={copyConfigPath}
              className="text-left font-mono text-[11px] text-zinc-500 hover:text-zinc-300"
              title="Copy path to clipboard"
            >
              {copyStatus === "copied" ? "Copied ✓" : configPath}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          className="rounded p-1 text-zinc-400 transition-colors hover:bg-bg-elevated hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {draft ? (
          <Tabs
            items={TABS}
            active={active}
            onChange={(id) => setActive(id as SettingsTabId)}
          >
            {tabContent}
          </Tabs>
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-zinc-500">
            {error ? `Failed to load settings: ${error}` : "Loading settings…"}
          </div>
        )}
      </div>

      <SaveToast toast={toast} />
    </Modal>
  );
}

function SaveToast({ toast }: { toast: Toast }) {
  if (toast.kind === "none") return null;
  const baseClasses =
    "pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md border px-3 py-1.5 font-mono text-xs shadow-lg";
  if (toast.kind === "saving") {
    return (
      <div
        className={`${baseClasses} border-border bg-bg-elevated text-zinc-300`}
        role="status"
      >
        Saving…
      </div>
    );
  }
  if (toast.kind === "saved") {
    return (
      <div
        className={`${baseClasses} border-emerald-500/40 bg-emerald-500/10 text-emerald-300`}
        role="status"
      >
        Settings saved ✓
      </div>
    );
  }
  return (
    <div
      className={`${baseClasses} border-red-500/40 bg-red-500/10 text-red-300`}
      role="alert"
    >
      Failed: {toast.message}
    </div>
  );
}

export default SettingsPanel;
