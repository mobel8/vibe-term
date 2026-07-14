// vibe-term — Settings → Terminal tab.
//
// Terminal behaviour toggles:
//   - `bell`: many CLIs ring the BEL (\x07) on tab-completion / errors, which
//     produces the "beep beep" some users want gone.
//   - `copyOnSelect` / `rightClickPaste`: consumed live by TerminalView (the
//     runtime always honoured them — they just had no UI until now).
// All three keys round-trip through the config IPC as-is (schema.rs renames
// every settings struct to camelCase), so each toggle persists correctly.

import type { Settings, TerminalSettings } from "@/ipc";
import { Switch } from "@/components/ui/Switch";

interface Props {
  value: TerminalSettings;
  onPatch: (patch: Partial<Settings>) => void;
}

export function TerminalTab({ value, onPatch }: Props) {
  // Spread the live `value` so its existing keys are preserved verbatim in the
  // patch (each Switch mutates exactly one field).
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

      <section className="flex flex-col gap-2">
        <header className="flex flex-col gap-0.5">
          <h3 className="font-mono text-sm font-semibold text-zinc-200">
            Copy on select
          </h3>
          <p className="text-xs text-zinc-500">
            Copy text to the clipboard as soon as a selection settles — no
            explicit copy needed. X11 / macOS Terminal muscle-memory.
          </p>
        </header>
        <Switch
          id="terminal-copy-on-select"
          checked={!!value.copyOnSelect}
          onChange={(e) => patchTerminal({ copyOnSelect: e.target.checked })}
          label="Copy selection to clipboard"
        />
      </section>

      <section className="flex flex-col gap-2">
        <header className="flex flex-col gap-0.5">
          <h3 className="font-mono text-sm font-semibold text-zinc-200">
            Right-click paste
          </h3>
          <p className="text-xs text-zinc-500">
            Paste the clipboard on right-click instead of opening a context
            menu (Windows-Terminal-style).
          </p>
        </header>
        <Switch
          id="terminal-right-click-paste"
          checked={!!value.rightClickPaste}
          onChange={(e) => patchTerminal({ rightClickPaste: e.target.checked })}
          label="Paste clipboard on right-click"
        />
      </section>
    </div>
  );
}

export default TerminalTab;
