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

      // The event subscriptions are owned by us. DockviewReact discards the
      // value returned from onReady, so we stash the disposables on a ref and
      // tear them down in a real React cleanup effect (see below) instead.
      subsRef.current.push(removeSub, activeSub);

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
    // dockview's addPanel activates the new panel by default, so on a
    // multi-tab restore the last tab would clobber the persisted activeTabId.
    // Suppress activation for every restored tab except the persisted one.
    const wantActive = useTerminalStore.getState().activeTabId;
    for (const tab of tabs) {
      if (!api.getPanel(tab.id)) {
        api.addPanel<TerminalPanelParams>({
          id: tab.id,
          component: "terminal",
          tabComponent: "terminalTab",
          title: tab.title,
          params: { tabId: tab.id },
          inactive: tab.id !== wantActive,
        });
      }
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
