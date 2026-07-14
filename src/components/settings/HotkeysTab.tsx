// vibe-term — Settings → Hotkeys tab.
//
// Renders a table of `(action, current-binding, reset)` rows. Clicking the
// binding cell switches it into "capture" mode — the next keydown is parsed
// into a canonical "Ctrl+Shift+T"-style chord and persisted through `onPatch`.
//
// We compare bindings against a small list of OS combos that are known to
// trigger desktop actions (e.g. Ubuntu's Ctrl+Alt+T spawning a terminal,
// macOS's Cmd+Q quitting the app) and surface a warning so the user can
// pick a non-conflicting alternative.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Settings } from "@/ipc";
import { Button } from "@/components/ui/Button";
import { defaultSettings } from "@/state/configStore";

import { clsx } from "clsx";

interface Props {
  value: Record<string, string>;
  onPatch: (patch: Partial<Settings>) => void;
}

// Human-readable labels for our well-known actions. Anything not in this map
// falls back to its raw action id (so config.toml extensions are visible).
// Keys MUST match the backend canon (schema.rs::default_hotkeys) + the runtime
// handler ids registered in Layout.tsx — snake_case. The old dotted ids never
// matched a handler, so rebinding any of those rows did nothing.
const ACTION_LABELS: Record<string, string> = {
  new_tab: "New terminal tab",
  close_tab: "Close terminal tab",
  split_horizontal: "Split horizontally",
  split_vertical: "Split vertically",
  toggle_ai_panel: "Toggle AI panel",
  search_history: "Search scrollback",
  screenshot_region: "Screenshot region",
  screenshot_full: "Screenshot fullscreen",
  command_palette: "Open command palette",
  open_settings: "Open settings",
  clear_terminal: "Clear terminal",
  reset_terminal: "Reset terminal state",
};

const KNOWN_OS_CONFLICTS: Array<{ chord: string; reason: string }> = [
  { chord: "Ctrl+Alt+T", reason: "Ubuntu default — launches gnome-terminal." },
  { chord: "Ctrl+Alt+Del", reason: "Reserved by the OS." },
  { chord: "Alt+F4", reason: "Standard window-close shortcut on Windows/Linux." },
  { chord: "Meta+Q", reason: "Quits the application on macOS." },
  { chord: "Meta+Space", reason: "Spotlight / system search on macOS." },
  { chord: "Meta+Tab", reason: "App switcher on macOS." },
  { chord: "Alt+Tab", reason: "Window switcher on Windows/Linux." },
];

/** Normalize a keyboard event into a canonical chord string. */
function chordFromEvent(e: KeyboardEvent | React.KeyboardEvent): string | null {
  const key = e.key;
  // Ignore plain modifier presses — we wait for the user to add a regular key.
  if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") {
    return null;
  }
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  // Special keys we render with friendly labels.
  const labelMap: Record<string, string> = {
    " ": "Space",
    Escape: "Esc",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Enter: "Enter",
  };
  const friendly = labelMap[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  parts.push(friendly);
  return parts.join("+");
}

function useKeyCapture(
  active: boolean,
  onCapture: (chord: string) => void,
  onCancel: () => void,
) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Escape CANCELS capture — it must not be bound as the "Esc" chord. This
      // window listener runs in the capture phase and so consumed Escape before
      // the button's own onKeyDown cancel handler could ever fire, which is why
      // pressing Esc used to silently rebind the action to Esc.
      if (e.key === "Escape") {
        onCancel();
        return;
      }
      const chord = chordFromEvent(e);
      if (chord) onCapture(chord);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => {
      window.removeEventListener("keydown", handler, { capture: true });
    };
  }, [active, onCapture, onCancel]);
}

export function HotkeysTab({ value, onPatch }: Props) {
  const [capturingAction, setCapturingAction] = useState<string | null>(null);
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const defaults = useMemo(() => defaultSettings().hotkeys, []);

  // Merge user-defined hotkeys with the factory defaults AND the label
  // catalogue, so built-ins that ship without a default combo (e.g.
  // clear_terminal / reset_terminal) still get a row — rendered "(unbound)"
  // and bindable like any other action.
  const rows = useMemo(() => {
    const ids = new Set<string>([
      ...Object.keys(ACTION_LABELS),
      ...Object.keys(defaults),
      ...Object.keys(value),
    ]);
    return Array.from(ids)
      .sort((a, b) => (ACTION_LABELS[a] ?? a).localeCompare(ACTION_LABELS[b] ?? b))
      .map((id) => ({
        id,
        label: ACTION_LABELS[id] ?? id,
        binding: value[id] ?? defaults[id] ?? "",
        isDefault: !value[id] || value[id] === defaults[id],
      }));
  }, [defaults, value]);

  const setBinding = useCallback(
    (action: string, chord: string) => {
      onPatch({ hotkeys: { ...value, [action]: chord } });
    },
    [onPatch, value],
  );

  const resetBinding = useCallback(
    (action: string) => {
      const next = { ...value };
      delete next[action];
      onPatch({ hotkeys: { ...defaults, ...next } });
    },
    [defaults, onPatch, value],
  );

  useKeyCapture(
    capturingAction !== null,
    (chord) => {
      if (capturingAction) {
        const prev = capturingAction;
        setBinding(prev, chord);
        setCapturingAction(null);
        // Refocus the row so the user can keep tabbing.
        rowRefs.current[prev]?.focus();
      }
    },
    () => {
      // Esc → leave capture mode without rebinding.
      const prev = capturingAction;
      setCapturingAction(null);
      if (prev) rowRefs.current[prev]?.focus();
    },
  );

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h3 className="font-mono text-sm font-semibold text-fg">Keyboard shortcuts</h3>
        <p className="mt-1 text-xs text-fg-subtle">
          Click a binding cell, then press the desired chord. Use <kbd className="kbd">Esc</kbd> to cancel.
        </p>
      </header>

      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full table-fixed text-sm">
          <thead className="bg-bg-elevated text-left text-xs uppercase tracking-wide text-fg-subtle">
            <tr>
              <th className="w-2/3 px-4 py-2 font-mono font-medium">Action</th>
              <th className="w-1/3 px-4 py-2 font-mono font-medium">Binding</th>
              <th className="w-20 px-2 py-2 text-right" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => {
              const conflict = KNOWN_OS_CONFLICTS.find((c) => c.chord === row.binding);
              const capturing = capturingAction === row.id;
              return (
                <tr key={row.id} className="hover:bg-bg-elevated/40">
                  <td className="px-4 py-2 font-mono text-fg">
                    <div className="flex flex-col">
                      <span>{row.label}</span>
                      <span className="text-xs text-fg-subtle">{row.id}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    <button
                      ref={(el) => {
                        rowRefs.current[row.id] = el;
                      }}
                      type="button"
                      onClick={() =>
                        setCapturingAction((cur) => (cur === row.id ? null : row.id))
                      }
                      onKeyDown={(e) => {
                        if (capturing && e.key === "Escape") {
                          e.preventDefault();
                          setCapturingAction(null);
                        }
                      }}
                      aria-pressed={capturing}
                      className={clsx(
                        "w-full rounded border px-2 py-1 text-left font-mono text-xs",
                        "transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                        capturing
                          ? "animate-pulse border-accent bg-accent/15 text-fg"
                          : "border-border bg-bg-subtle text-fg hover:border-fg-subtle",
                      )}
                    >
                      {capturing
                        ? "Press a key combination…"
                        : row.binding || "(unbound)"}
                    </button>
                    {conflict && (
                      <p
                        className="mt-1 text-[11px] text-amber-400"
                        role="status"
                      >
                        Conflict: {conflict.reason}
                      </p>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => resetBinding(row.id)}
                      disabled={row.isDefault}
                      aria-label={`Reset ${row.label}`}
                    >
                      Reset
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-fg-subtle">
        Shortcuts are registered globally inside the app — they will not preempt
        other applications. Some chords (e.g. <kbd className="kbd">Ctrl+Alt+T</kbd> on Ubuntu) are
        intercepted by the desktop environment before the app sees them.
      </p>
    </div>
  );
}

export default HotkeysTab;
