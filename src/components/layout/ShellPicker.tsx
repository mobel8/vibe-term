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
  const [selected, setSelected] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    pty
      .listShells()
      .then((list) => {
        if (cancelled) return;
        setShells(list);
        if (list.length > 0) setSelected(list[0].path);
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
    return <div className="text-xs text-zinc-500">Discovering shells…</div>;
  }
  if (shells.length === 0) {
    return (
      <div className="text-xs text-zinc-500">
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
          className="font-mono text-zinc-400"
        >
          Shell
        </label>
      )}
      <select
        id="vibe-shell-picker"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="rounded border border-border bg-bg-subtle px-2 py-1 font-mono text-xs text-zinc-100 outline-none focus:border-accent"
      >
        {shells.map((s) => (
          <option key={s.path} value={s.path}>
            {s.name} — {s.path}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => {
          const shell = shells.find((s) => s.path === selected);
          if (shell) onSelect(shell);
        }}
        className="rounded bg-accent-subtle px-3 py-1 font-mono text-xs text-zinc-100 hover:bg-accent"
      >
        {buttonLabel}
      </button>
    </div>
  );
}

export default ShellPicker;
