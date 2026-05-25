import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { customAlphabet } from "nanoid";

import type { ImageMeta, PtyId, ShellInfo } from "@/ipc";

const TAB_ID = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 8);
const newTabId = () => `tab_${TAB_ID()}`;

export type TerminalStatus = "spawning" | "running" | "exited" | "error";

export interface TerminalTab {
  id: string;
  /**
   * null while waiting for the backend `pty_spawn` to resolve, or after a
   * restored tab (persisted) has not yet been re-spawned in the current
   * process — caller should treat null as "not yet attached" and call
   * `ensureSpawn` before sending input.
   */
  ptyId: PtyId | null;
  title: string;
  shell: ShellInfo;
  cwd: string | null;
  status: TerminalStatus;
  exitCode: number | null;
  attachedImages: ImageMeta[];
}

interface TerminalState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  newTab(shell: ShellInfo, cwd?: string | null, title?: string): TerminalTab;
  closeTab(tabId: string): void;
  setActive(tabId: string | null): void;
  attachImageToTab(tabId: string, image: ImageMeta): void;
  setStatus(
    tabId: string,
    status: TerminalStatus,
    exitCode?: number | null,
  ): void;
  setPtyId(tabId: string, ptyId: PtyId | null): void;
  setTitle(tabId: string, title: string): void;
  setCwd(tabId: string, cwd: string): void;
  reset(): void;
}

const STORAGE_KEY = "vibe-term:terminal-store:v1";

function shellDisplayName(shell: ShellInfo): string {
  return shell.name || shell.path.split(/[\\/]/).filter(Boolean).pop() || "shell";
}

export const useTerminalStore = create<TerminalState>()(
  persist<TerminalState>(
    (set) => ({
      tabs: [],
      activeTabId: null,

      newTab(shell, cwd = null, title) {
        const tab: TerminalTab = {
          id: newTabId(),
          ptyId: null,
          title: title ?? shellDisplayName(shell),
          shell,
          cwd,
          status: "spawning",
          exitCode: null,
          attachedImages: [],
        };
        set((state) => ({
          tabs: [...state.tabs, tab],
          activeTabId: tab.id,
        }));
        return tab;
      },

      closeTab(tabId) {
        set((state) => {
          const remaining = state.tabs.filter((t) => t.id !== tabId);
          const wasActive = state.activeTabId === tabId;
          const fallback = wasActive
            ? remaining[remaining.length - 1]?.id ?? null
            : state.activeTabId;
          return { tabs: remaining, activeTabId: fallback };
        });
      },

      setActive(tabId) {
        set({ activeTabId: tabId });
      },

      attachImageToTab(tabId, image) {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? { ...t, attachedImages: [...t.attachedImages, image] }
              : t,
          ),
        }));
      },

      setStatus(tabId, status, exitCode = null) {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? { ...t, status, exitCode: exitCode ?? t.exitCode }
              : t,
          ),
        }));
      },

      setPtyId(tabId, ptyId) {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId ? { ...t, ptyId } : t,
          ),
        }));
      },

      setTitle(tabId, title) {
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
        }));
      },

      setCwd(tabId, cwd) {
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, cwd } : t)),
        }));
      },

      reset() {
        set({ tabs: [], activeTabId: null });
      },
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // PtyIds are process-local handles; they become stale across restarts.
      // We persist the rest so we can re-create the tabs and re-spawn lazily.
      partialize: (state) =>
        ({
          ...state,
          tabs: state.tabs.map((t) => ({
            ...t,
            ptyId: null,
            status: "spawning" as TerminalStatus,
            exitCode: null,
            attachedImages: [],
          })),
        }) as TerminalState,
    },
  ),
);
