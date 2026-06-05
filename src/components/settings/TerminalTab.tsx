// vibe-term — Settings → Terminal tab.
//
// Terminal behaviour toggles. Currently the audible bell — many CLIs ring the
// BEL (\x07) on tab-completion / errors, which produces the "beep beep" some
// users want gone. `bell` round-trips cleanly (single-word key, identical in
// camelCase and the backend's snake_case), so this toggle persists correctly.

import type { Settings, TerminalSettings } from "@/ipc";
import { Switch } from "@/components/ui/Switch";

interface Props {
  value: TerminalSettings;
  onPatch: (patch: Partial<Settings>) => void;
}

export function TerminalTab({ value, onPatch }: Props) {
  // Spread the live `value` so its existing keys are preserved verbatim in the
  // patch (the only field we mutate here is `bell`).
  function patchTerminal(patch: Partial<TerminalSettings>) {
    onPatch({ terminal: { ...value, ...patch } });
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <header className="flex flex-col gap-0.5">
          <h3 className="font-mono text-sm font-semibold text-zinc-200">Bell</h3>
          <p className="text-xs text-zinc-500">
            Play a short beep when a program rings the terminal bell (BEL). Many
            CLIs trigger it on tab-completion or errors — turn this off to
            silence the “beep beep”. A subtle visual flash is shown either way.
          </p>
        </header>
        <Switch
          id="terminal-bell"
          checked={!!value.bell}
          onChange={(e) => patchTerminal({ bell: e.target.checked })}
          label="Audible bell sound"
        />
      </section>
    </div>
  );
}

export default TerminalTab;
