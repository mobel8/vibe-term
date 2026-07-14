import { useTerminalStore } from "@/state/terminalStore";
import type { TerminalStatus } from "@/state/terminalStore";

function statusLabel(status: TerminalStatus, code: number | null): string {
  switch (status) {
    case "running":
      return "running";
    case "spawning":
      return "spawning…";
    case "exited":
      return code !== null ? `exited (${code})` : "exited";
    case "error":
      return "error";
  }
}

function statusColor(status: TerminalStatus): string {
  switch (status) {
    case "running":
      return "text-emerald-400";
    case "spawning":
      return "text-amber-400";
    case "exited":
      return "text-fg-muted";
    case "error":
      return "text-red-400";
  }
}

export function StatusBar() {
  const activeTab = useTerminalStore((s) => {
    if (!s.activeTabId) return null;
    return s.tabs.find((t) => t.id === s.activeTabId) ?? null;
  });
  const totalTabs = useTerminalStore((s) => s.tabs.length);

  return (
    <footer className="flex h-7 shrink-0 items-center justify-between gap-4 border-t border-border bg-bg-subtle px-4 font-mono text-[11px] text-fg-muted">
      <div className="flex items-center gap-3 truncate">
        {activeTab ? (
          <>
            <span className="text-fg">{activeTab.shell.name}</span>
            <span className="text-fg-subtle">·</span>
            <span className="truncate text-fg-subtle">
              {activeTab.cwd ?? "~"}
            </span>
          </>
        ) : (
          <span>No active terminal</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {activeTab && (
          <span className={statusColor(activeTab.status)}>
            {statusLabel(activeTab.status, activeTab.exitCode)}
          </span>
        )}
        <span className="text-fg-subtle">tabs: {totalTabs}</span>
      </div>
    </footer>
  );
}

export default StatusBar;
