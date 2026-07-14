import { useEffect, useState } from "react";

import { pty } from "@/ipc";
import type { ShellInfo } from "@/ipc";

interface ShellPickerProps {
  onSelect(shell: ShellInfo): void;
  /** Optional class names to inject on the wrapping element. */
  className?: string;
  /** When true, render as a large hero panel (cold start without tabs). */
  variant?: "compact" | "hero";
  /** Hide the surrounding label/help text (compact toolbar usage). */
  hideLabel?: boolean;
}

export function ShellPicker({
  onSelect,
  className,
  variant = "compact",
  hideLabel = false,
}: ShellPickerProps) {
  const [shells, setShells] = useState<ShellInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Select by index, not by `path`: WSL distros all share path "wsl.exe" and
  // differ only in `args` (["-d", "<distro>"]), so a path-keyed <select> would
  // collide every distro onto one entry and make only the first selectable.
  const [selected, setSelected] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    pty
      .listShells()
      .then((list) => {
        if (cancelled) return;
        setShells(list);
        if (list.length > 0) setSelected(0);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="text-xs text-red-400" role="alert">
        Failed to list shells: {error}
      </div>
    );
  }
  if (!shells) {
    return <div className="text-xs text-fg-subtle">Discovering shells…</div>;
  }
  if (shells.length === 0) {
    return (
      <div className="text-xs text-fg-subtle">
        No shells detected. Configure one in settings.
      </div>
    );
  }

  const buttonLabel = variant === "hero" ? "Open terminal" : "Spawn";

  return (
    <div
      className={[
        "flex items-center gap-2",
        variant === "hero" ? "flex-col text-base" : "flex-row text-xs",
        className ?? "",
      ].join(" ")}
    >
      {!hideLabel && (
        <label
          htmlFor="vibe-shell-picker"
          className="font-mono text-fg-muted"
        >
          Shell
        </label>
      )}
      <select
        id="vibe-shell-picker"
        value={selected}
        onChange={(e) => setSelected(Number(e.target.value))}
        className="rounded border border-border bg-bg-subtle px-2 py-1 font-mono text-xs text-fg outline-none focus:border-accent"
      >
        {shells.map((s, i) => (
          <option key={i} value={i}>
            {s.name} — {s.path}
            {s.args.length > 0 ? ` ${s.args.join(" ")}` : ""}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => {
          const shell = shells[selected];
          if (shell) onSelect(shell);
        }}
        className="rounded bg-accent-subtle px-3 py-1 font-mono text-xs text-fg hover:bg-accent"
      >
        {buttonLabel}
      </button>
    </div>
  );
}

export default ShellPicker;
