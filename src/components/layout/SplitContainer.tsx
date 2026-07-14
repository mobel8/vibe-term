import { useCallback, useEffect, useRef } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanel,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";

import { TerminalView } from "@/components/terminal/TerminalView";
import { debugRegisterDockview, debugRegisterStore } from "@/lib/debug-hook";
import { useTerminalStore } from "@/state/terminalStore";

import { TerminalTabHeader } from "./TabBar";

export type SplitDirection = "horizontal" | "vertical";

export interface SplitContainerHandle {
  /** Open a brand-new tab in the active group. */
  newTab(tabId: string, title: string): void;
  /** Split the active panel along the given direction with a new tab. */
  split(tabId: string, title: string, direction: SplitDirection): void;
  /** Programmatically close a tab (also clears it from the store). */
  closeTab(tabId: string): void;
}

interface SplitContainerProps {
  onReady?: (handle: SplitContainerHandle) => void;
}

interface TerminalPanelParams {
  tabId: string;
}

/**
 * Persisted Dockview layout (groups, splits, sizes, active panel per group).
 * Restoring tabs WITHOUT their layout used to re-add every pane as an
 * `inactive` panel in a fresh group — a group whose content is never
 * activated renders BLANK (React mounts it but Dockview never attaches its
 * DOM), which looked like "restored tabs are dead". Restoring the serialized
 * layout brings back the exact split arrangement AND a live active panel per
 * group; the reconcile effect stays as the fallback for id mismatches.
 */
const LAYOUT_KEY = "vibe-term:layout:v1";

function TerminalPanel(props: IDockviewPanelProps<TerminalPanelParams>) {
  return <TerminalView tabId={props.params.tabId} />;
}

const panelComponents: Record<string, React.FunctionComponent<IDockviewPanelProps>> =
  {
    terminal: TerminalPanel as React.FunctionComponent<IDockviewPanelProps>,
  };

const tabComponents: Record<
  string,
  React.FunctionComponent<IDockviewPanelHeaderProps>
> = {
  terminalTab: TerminalTabHeader as React.FunctionComponent<IDockviewPanelHeaderProps>,
};

/**
 * Wraps Dockview with a small imperative façade so the layout-level hotkeys
 * (Ctrl+T, Ctrl+Shift+D/E) don't need to know about the underlying API.
 *
 * INVARIANT: Tab lifecycle is bi-directional. The store is the source of
 * truth for tab metadata (title, shell, status). Dockview owns layout state
 * (which group, which order). We sync:
 *   - store → dockview: spawn `addPanel` when a new tab appears in the store
 *     that doesn't have a panel yet; remove panel when the tab is dropped.
 *   - dockview → store: `onWillRemovePanel` notifies us when the user closes
 *     a tab via the chrome 'x' button so we drop it from the store and kill
 *     the PTY.
 */
export function SplitContainer({ onReady }: SplitContainerProps) {
  const apiRef = useRef<DockviewApi | null>(null);
  const subsRef = useRef<Array<{ dispose(): void }>>([]);
  const tabs = useTerminalStore((s) => s.tabs);
  const closeTabInStore = useTerminalStore((s) => s.closeTab);

  const handleClosePanel = useCallback(
    (tabId: string) => {
      const api = apiRef.current;
      const panel = api?.getPanel(tabId);
      if (panel) api?.removePanel(panel);
      closeTabInStore(tabId);
    },
    [closeTabInStore],
  );

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      const api = event.api;
      debugRegisterDockview(api);
      debugRegisterStore("terminal", () => useTerminalStore.getState());

      const handle: SplitContainerHandle = {
        newTab(tabId, title) {
          api.addPanel<TerminalPanelParams>({
            id: tabId,
            component: "terminal",
            tabComponent: "terminalTab",
            title,
            params: { tabId },
          });
        },
        split(tabId, title, direction) {
          const reference = api.activePanel;
          api.addPanel<TerminalPanelParams>({
            id: tabId,
            component: "terminal",
            tabComponent: "terminalTab",
            title,
            params: { tabId },
            position: reference
              ? {
                  referencePanel: reference,
                  direction:
                    direction === "horizontal" ? "right" : "below",
                }
              : { direction: direction === "horizontal" ? "right" : "below" },
          });
        },
        closeTab(tabId) {
          handleClosePanel(tabId);
        },
      };

      // The user-driven path: when a panel is removed (chrome x, keyboard,
      // drag-out), mirror it into the store so we don't leak a dead PTY.
      const removeSub = api.onDidRemovePanel((panel: IDockviewPanel) => {
        // If the store still has the tab, this came from the UI side; drop it
        // (the close button in TabBar already calls closeTab, but this catches
        // the keyboard / DnD cases too).
        if (useTerminalStore.getState().tabs.some((t) => t.id === panel.id)) {
          closeTabInStore(panel.id);
        }
      });

      const activeSub = api.onDidActivePanelChange(
        (panel: IDockviewPanel | undefined) => {
          useTerminalStore.getState().setActive(panel?.id ?? null);
        },
      );

      // ── Layout persistence ────────────────────────────────────────
      // Restore the saved arrangement when every panel id still maps to a
      // live tab; otherwise clear it and let the reconcile effect rebuild a
      // plain tab row. Restoring BEFORE reconcile means splits survive an
      // app restart exactly as the user left them.
      try {
        const raw = localStorage.getItem(LAYOUT_KEY);
        if (raw) {
          const layout = JSON.parse(raw) as {
            panels?: Record<string, unknown>;
          };
          const ids = Object.keys(layout.panels ?? {});
          const tabIds = new Set(
            useTerminalStore.getState().tabs.map((t) => t.id),
          );
          if (ids.length > 0 && ids.every((id) => tabIds.has(id))) {
            api.fromJSON(layout as Parameters<DockviewApi["fromJSON"]>[0]);
          } else {
            localStorage.removeItem(LAYOUT_KEY);
          }
        }
      } catch (err) {
        console.warn("[layout] restoring saved layout failed; rebuilding", err);
        try {
          localStorage.removeItem(LAYOUT_KEY);
        } catch {
          /* storage unavailable */
        }
      }

      // Save on every layout mutation (split, resize, move, close), trailing-
      // debounced — Dockview fires bursts during drags.
      let saveTimer: ReturnType<typeof setTimeout> | null = null;
      const layoutSub = api.onDidLayoutChange(() => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          try {
            localStorage.setItem(LAYOUT_KEY, JSON.stringify(api.toJSON()));
          } catch (err) {
            console.warn("[layout] persisting layout failed", err);
          }
        }, 400);
      });

      // The event subscriptions are owned by us. DockviewReact discards the
      // value returned from onReady, so we stash the disposables on a ref and
      // tear them down in a real React cleanup effect (see below) instead.
      subsRef.current.push(removeSub, activeSub, layoutSub, {
        dispose() {
          if (saveTimer) clearTimeout(saveTimer);
        },
      });

      onReady?.(handle);
    },
    [closeTabInStore, handleClosePanel, onReady],
  );

  // Dispose our Dockview subscriptions on unmount. Dockview also reaps them via
  // api.dispose(), but this honors the explicit-ownership intent and survives a
  // future refactor that keeps the api alive across remounts.
  useEffect(() => {
    return () => {
      for (const sub of subsRef.current) sub.dispose();
      subsRef.current = [];
    };
  }, []);

  // Reconcile store → dockview: open panels for tabs that don't have one yet.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    // NEVER add panels as `inactive` here: an inactive panel in a fresh group
    // leaves that group with NO active panel → its content renders blank and
    // the terminal never fits (the restored-tabs-look-dead bug). Add panels
    // normally (each activates in its group), then re-activate the persisted
    // active tab once at the end so a multi-tab restore doesn't clobber it.
    const wantActive = useTerminalStore.getState().activeTabId;
    let added = false;
    for (const tab of tabs) {
      if (!api.getPanel(tab.id)) {
        api.addPanel<TerminalPanelParams>({
          id: tab.id,
          component: "terminal",
          tabComponent: "terminalTab",
          title: tab.title,
          params: { tabId: tab.id },
        });
        added = true;
      }
    }
    if (added && wantActive) {
      api.getPanel(wantActive)?.api.setActive();
    }
    // Conversely, drop any panel that has no matching tab (defensive — shouldn't happen).
    for (const panel of api.panels) {
      if (!tabs.some((t) => t.id === panel.id)) {
        api.removePanel(panel);
      }
    }
  }, [tabs]);

  return (
    <div className="h-full w-full">
      <DockviewReact
        components={panelComponents}
        tabComponents={tabComponents}
        defaultTabComponent={tabComponents.terminalTab}
        onReady={handleReady}
        className="dockview-theme-dark h-full"
      />
    </div>
  );
}

export default SplitContainer;
