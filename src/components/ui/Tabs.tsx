// vibe-term — Tabs primitive (sidebar variant).
//
// Controlled component. The parent owns the active tab id; we just render the
// nav + active panel. Arrow Up/Down moves selection inside the nav, matching
// the WAI-ARIA Authoring Practices guidance for vertical tablists.
//
// Usage:
//   <Tabs items={[{id:"general", label:"General"}, ...]}
//         active="general" onChange={setActive} >
//     {active === "general" && <GeneralTab />}
//     ...
//   </Tabs>

import { useCallback, useId, useRef } from "react";
import type { ReactNode } from "react";

import { clsx } from "clsx";

export interface TabItem {
  id: string;
  label: string;
  /** Optional badge (e.g. "•" for unsaved). */
  hint?: ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  active: string;
  onChange: (id: string) => void;
  children: ReactNode;
  /** Tailwind classes appended to the outer flex container. */
  className?: string;
}

export function Tabs({
  items,
  active,
  onChange,
  children,
  className,
}: TabsProps) {
  const navId = useId();
  const listRef = useRef<HTMLDivElement | null>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown" && e.key !== "Home" && e.key !== "End") {
        return;
      }
      e.preventDefault();
      const idx = items.findIndex((i) => i.id === active);
      let next = idx;
      if (e.key === "ArrowDown") next = (idx + 1) % items.length;
      else if (e.key === "ArrowUp") next = (idx - 1 + items.length) % items.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = items.length - 1;
      const nextId = items[next]?.id;
      if (nextId) {
        onChange(nextId);
        const btn = listRef.current?.querySelector<HTMLButtonElement>(
          `[data-tab-id="${nextId}"]`,
        );
        btn?.focus();
      }
    },
    [active, items, onChange],
  );

  return (
    <div className={clsx("flex h-full min-h-0", className)}>
      <div
        ref={listRef}
        role="tablist"
        aria-orientation="vertical"
        className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-border bg-bg-muted/40 p-2"
      >
        {items.map((item) => {
          const isActive = item.id === active;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`${navId}-panel-${item.id}`}
              id={`${navId}-tab-${item.id}`}
              tabIndex={isActive ? 0 : -1}
              data-tab-id={item.id}
              onClick={() => onChange(item.id)}
              onKeyDown={handleKeyDown}
              className={clsx(
                "flex items-center justify-between gap-2 rounded px-3 py-1.5",
                "text-left font-mono text-sm transition-colors",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                isActive
                  ? "bg-bg-elevated text-zinc-100"
                  : "text-zinc-400 hover:bg-bg-elevated/70 hover:text-zinc-200",
              )}
            >
              <span>{item.label}</span>
              {item.hint && (
                <span className="text-xs text-accent/80">{item.hint}</span>
              )}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${navId}-panel-${active}`}
        aria-labelledby={`${navId}-tab-${active}`}
        className="min-h-0 flex-1 overflow-y-auto p-6"
      >
        {children}
      </div>
    </div>
  );
}

export default Tabs;
