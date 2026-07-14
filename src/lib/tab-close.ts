// vibe-term — Confirm-on-close gate shared by every tab-close entry point
// (Ctrl+W, the tab header ×, palette "Close terminal tab").
//
// Honors `general.confirmOnClose`: when the pane's shell has live child
// processes (a build, an ssh session, claude…), ask before killing; an idle
// prompt closes silently. The child count comes from the backend's process
// -tree walk, so "busy" means real work — not just the shell existing.

import { pty } from "@/ipc";
import { useConfigStore } from "@/state/configStore";
import { useTerminalStore } from "@/state/terminalStore";

/**
 * Run `doClose` immediately when no confirmation is needed; otherwise ask
 * the user first. Never throws — a failed child-count probe fails open
 * (close without prompt) so a backend hiccup can't wedge tab closing.
 */
export async function requestTabClose(
  tabId: string,
  doClose: () => void,
): Promise<void> {
  const tab = useTerminalStore.getState().tabs.find((t) => t.id === tabId);
  const settings = useConfigStore.getState().settings;
  if (!tab?.ptyId || !settings?.general.confirmOnClose) {
    doClose();
    return;
  }
  let busy: number;
  try {
    busy = await pty.childCount(tab.ptyId);
  } catch {
    busy = 0;
  }
  if (busy > 0) {
    let ok: boolean;
    try {
      const { confirm } = await import("@tauri-apps/plugin-dialog");
      ok = await confirm(
        `A process is still running in "${tab.title}". Close it anyway?`,
        { title: "Close tab", kind: "warning" },
      );
    } catch (err) {
      // Dialog unavailable (vitest, missing capability) — fail open.
      console.warn("[tab-close] confirm dialog failed; closing", err);
      ok = true;
    }
    if (!ok) return;
  }
  doClose();
}
