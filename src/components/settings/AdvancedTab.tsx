// vibe-term — Settings → Advanced tab.
//
// Power-user escape hatches: open the raw config file or logs folder, reset
// the whole settings tree, and surface the app/runtime version info.
//
// We rely on the dynamic import of `@tauri-apps/plugin-shell` so the tab is
// safe to render in the Vitest jsdom environment (the plugin would otherwise
// blow up because `window.__TAURI__` is not present).

import { useEffect, useState } from "react";

import { appInfo, config, dataPaths } from "@/ipc";
import type { AppInfo, DataPaths } from "@/ipc";
import { Button } from "@/components/ui/Button";
import { useConfigStore } from "@/state/configStore";

interface Props {
  onResetRequested?: () => void;
}

export function AdvancedTab({ onResetRequested }: Props) {
  const reset = useConfigStore((s) => s.reset);
  const [confirming, setConfirming] = useState(false);
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [paths, setPaths] = useState<DataPaths | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    config
      .path()
      .then((p) => {
        if (!cancelled) setConfigPath(p);
      })
      .catch(() => {
        if (!cancelled) setConfigPath(null);
      });
    appInfo()
      .then((i) => {
        if (!cancelled) setInfo(i);
      })
      .catch(() => undefined);
    dataPaths()
      .then((p) => {
        if (!cancelled) setPaths(p);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function openInShell(target: string | null) {
    if (!target) return;
    setActionError(null);
    try {
      const shell = await import("@tauri-apps/plugin-shell");
      await shell.open(target);
      setActionStatus(`Opened: ${target}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  function deriveLogsDir(cfgPath: string | null): string | null {
    if (!cfgPath) return null;
    // Heuristic: vibe-term/config.toml lives next to vibe-term/logs/. Strip
    // the trailing "config.toml" segment. Handle both separators — Windows
    // PathBuf renders with "\\", POSIX with "/".
    const idx = Math.max(cfgPath.lastIndexOf("/"), cfgPath.lastIndexOf("\\"));
    if (idx <= 0) return null;
    const sep = cfgPath[idx];
    return `${cfgPath.slice(0, idx)}${sep}logs`;
  }

  async function doReset() {
    setActionError(null);
    try {
      await reset();
      setConfirming(false);
      setActionStatus("Settings reset to defaults.");
      onResetRequested?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Section title="Configuration file" hint="Edit the raw TOML file in your default editor.">
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded border border-border bg-bg-elevated px-2 py-1 font-mono text-xs text-fg">
            {configPath ?? "(unknown)"}
          </code>
          <Button
            variant="subtle"
            onClick={() => openInShell(configPath)}
            disabled={!configPath}
          >
            Open in editor
          </Button>
        </div>
      </Section>

      <Section title="Logs" hint="Application logs are written next to the config file.">
        <Button
          variant="subtle"
          onClick={() => openInShell(deriveLogsDir(configPath))}
          disabled={!configPath}
        >
          Open logs folder
        </Button>
      </Section>

      <Section
        title="Reset to defaults"
        hint="Restores every setting to the factory values. Your terminal tabs and history are preserved."
      >
        {confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-amber-400">
              This will overwrite your settings. Are you sure?
            </span>
            <Button variant="danger" onClick={doReset}>
              Yes, reset everything
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Reset all to defaults
          </Button>
        )}
      </Section>

      <Section title="Data paths" hint="Where vibe-term stores history, images, and OCR models.">
        {paths ? (
          <dl className="grid grid-cols-[max-content,1fr] gap-x-4 gap-y-1 font-mono text-xs">
            <dt className="text-fg-subtle">config</dt>
            <dd className="text-fg break-all">{paths.configPath}</dd>
            <dt className="text-fg-subtle">database</dt>
            <dd className="text-fg break-all">{paths.dbPath}</dd>
            <dt className="text-fg-subtle">images</dt>
            <dd className="text-fg break-all">{paths.imagesDir}</dd>
            <dt className="text-fg-subtle">ocr models</dt>
            <dd className="text-fg break-all">{paths.modelsDir}</dd>
          </dl>
        ) : (
          <p className="text-xs text-fg-subtle">Resolving runtime paths…</p>
        )}
      </Section>

      <Section title="About">
        {info ? (
          <dl className="grid grid-cols-[max-content,1fr] gap-x-4 gap-y-1 font-mono text-xs">
            <dt className="text-fg-subtle">name</dt>
            <dd className="text-fg">{info.name}</dd>
            <dt className="text-fg-subtle">version</dt>
            <dd className="text-fg">{info.version}</dd>
            <dt className="text-fg-subtle">target</dt>
            <dd className="text-fg">
              {info.targetOs}/{info.targetArch}
            </dd>
          </dl>
        ) : (
          <p className="text-xs text-fg-subtle">Loading runtime info…</p>
        )}
      </Section>

      {actionStatus && (
        <p className="text-xs text-emerald-400" role="status">
          {actionStatus}
        </p>
      )}
      {actionError && (
        <p className="text-xs text-red-400" role="alert">
          {actionError}
        </p>
      )}
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
        <h3 className="font-mono text-sm font-semibold text-fg">{title}</h3>
        {hint && <p className="text-xs text-fg-subtle">{hint}</p>}
      </header>
      {children}
    </section>
  );
}

export default AdvancedTab;
