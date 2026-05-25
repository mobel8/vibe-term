// vibe-term — Settings → General tab.
//
// Exposes the four `GeneralSettings` knobs:
//   • default shell  : populated from `pty.listShells()`
//   • working dir    : free-form text + Browse button (Tauri dialog plugin)
//   • scrollback     : 100–100 000 lines
//   • confirmOnClose : toggle
//
// Updates are pushed back via the `onPatch` callback so the parent panel can
// debounce all tabs' changes through a single sink (avoids per-field network
// chatter when the user hammers a stepper).

import { useEffect, useState } from "react";

import { pty } from "@/ipc";
import type { GeneralSettings, ShellInfo, Settings } from "@/ipc";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { Button } from "@/components/ui/Button";

interface Props {
  value: GeneralSettings;
  onPatch: (patch: Partial<Settings>) => void;
}

const SCROLLBACK_MIN = 100;
const SCROLLBACK_MAX = 100_000;

export function GeneralTab({ value, onPatch }: Props) {
  const [shells, setShells] = useState<ShellInfo[] | null>(null);
  const [shellsError, setShellsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    pty
      .listShells()
      .then((list) => {
        if (!cancelled) setShells(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setShellsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function patchGeneral(patch: Partial<GeneralSettings>) {
    onPatch({ general: { ...value, ...patch } });
  }

  function clampScrollback(n: number): number {
    if (Number.isNaN(n)) return SCROLLBACK_MIN;
    return Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, Math.floor(n)));
  }

  async function browseWorkingDirectory() {
    try {
      const dialog = await import("@tauri-apps/plugin-dialog");
      const picked = await dialog.open({
        directory: true,
        multiple: false,
        defaultPath: value.workingDirectory ?? undefined,
      });
      if (typeof picked === "string") {
        patchGeneral({ workingDirectory: picked });
      }
    } catch (err) {
      console.warn("[settings] folder picker failed:", err);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Section title="Default shell" hint="Used when a new tab is opened without an explicit shell.">
        {shellsError ? (
          <p className="text-sm text-red-400">Failed to enumerate shells: {shellsError}</p>
        ) : !shells ? (
          <p className="text-sm text-zinc-500">Discovering shells…</p>
        ) : (
          <Select
            placeholder="Select a shell"
            value={value.defaultShell ?? ""}
            onChange={(e) =>
              patchGeneral({ defaultShell: e.target.value || null })
            }
            options={shells.map((s) => ({
              value: s.path,
              label: s.name,
              hint: s.path,
            }))}
          />
        )}
      </Section>

      <Section title="Working directory" hint="Starting directory for new terminals. Defaults to the user's home if left blank.">
        <div className="flex gap-2">
          <Input
            value={value.workingDirectory ?? ""}
            placeholder="~/"
            onChange={(e) =>
              patchGeneral({ workingDirectory: e.target.value || null })
            }
          />
          <Button variant="subtle" onClick={browseWorkingDirectory}>
            Browse…
          </Button>
        </div>
      </Section>

      <Section
        title="Scrollback lines"
        hint={`How many lines xterm.js keeps in memory per tab (${SCROLLBACK_MIN.toLocaleString()}–${SCROLLBACK_MAX.toLocaleString()}).`}
      >
        <Input
          type="number"
          min={SCROLLBACK_MIN}
          max={SCROLLBACK_MAX}
          step={100}
          value={value.scrollbackLines}
          onChange={(e) =>
            patchGeneral({ scrollbackLines: clampScrollback(Number(e.target.value)) })
          }
          className="w-40"
        />
      </Section>

      <Section title="Confirm on close" hint="Ask before closing a window with active terminals.">
        <Switch
          id="general-confirm-on-close"
          checked={value.confirmOnClose}
          onChange={(e) => patchGeneral({ confirmOnClose: e.target.checked })}
          label={value.confirmOnClose ? "Enabled" : "Disabled"}
        />
      </Section>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <header className="flex flex-col gap-0.5">
        <h3 className="font-mono text-sm font-semibold text-zinc-200">{title}</h3>
        {hint && <p className="text-xs text-zinc-500">{hint}</p>}
      </header>
      {children}
    </section>
  );
}

export default GeneralTab;
