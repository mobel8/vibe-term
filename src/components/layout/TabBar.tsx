import { useMemo } from "react";
import type { IDockviewPanelHeaderProps } from "dockview-react";

import { requestTabClose } from "@/lib/tab-close";
import { useTerminalStore } from "@/state/terminalStore";
import type { TerminalStatus } from "@/state/terminalStore";

interface TabParams {
  tabId: string;
}

function statusColor(status: TerminalStatus): string {
  switch (status) {
    case "running":
      return "bg-emerald-400";
    case "spawning":
      return "bg-amber-400";
    case "exited":
      return "bg-fg-subtle";
    case "error":
      return "bg-red-500";
  }
}

function shellGlyph(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("zsh")) return "Z";
  if (lower.includes("bash")) return "B";
  if (lower.includes("fish")) return "F";
  if (lower.includes("pwsh") || lower.includes("powershell")) return "P";
  if (lower.includes("cmd")) return "C";
  if (lower.includes("nu")) return "N";
  return lower.charAt(0).toUpperCase() || "S";
}

export function TerminalTabHeader(props: IDockviewPanelHeaderProps<TabParams>) {
  const tabId = props.params.tabId;
  const tab = useTerminalStore((s) => s.tabs.find((t) => t.id === tabId));
  const closeTabAction = useTerminalStore((s) => s.closeTab);

  const glyph = useMemo(() => (tab ? shellGlyph(tab.shell.name) : "·"), [tab]);

  if (!tab) {
    return (
      <div className="vibe-tab-header flex items-center gap-2 px-3 py-1 text-xs text-fg-subtle">
        unknown
      </div>
    );
  }

  return (
    <div className="vibe-tab-header group flex items-center gap-2 px-3 py-1 text-xs">
      <span
        aria-hidden
        className="flex h-4 w-4 items-center justify-center rounded bg-bg-elevated font-mono text-[10px] text-accent"
      >
        {glyph}
      </span>
      <span
        className={[
          "h-1.5 w-1.5 rounded-full",
          statusColor(tab.status),
        ].join(" ")}
        aria-label={`status: ${tab.status}`}
      />
      <span className="max-w-[160px] truncate font-mono text-fg">
        {tab.title}
      </span>
      <button
        type="button"
        className="ml-1 hidden h-4 w-4 items-center justify-center rounded text-fg-subtle hover:bg-bg-elevated hover:text-fg group-hover:flex"
        onClick={(e) => {
          e.stopPropagation();
          // Confirm-on-close gate first (live child processes), then close the
          // Dockview panel — the panel close handler wired in Layout mirrors
          // the change into the store. The extra closeTabAction is defensive:
          // if Dockview swallows the close (already detached), still drop the
          // tab from our store.
          void requestTabClose(tab.id, () => {
            props.api.close();
            closeTabAction(tab.id);
          });
        }}
        aria-label={`Close ${tab.title}`}
      >
        ×
      </button>
    </div>
  );
}

export default TerminalTabHeader;
