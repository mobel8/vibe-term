// vibe-term — First-run wizard.
//
// Four steps:
//   1. Welcome  : friendly intro, single CTA.
//   2. Shell    : choose default shell from `pty.listShells()`.
//   3. Theme    : pick from the five bundled palettes.
//   4. AI key   : optional — paste an Anthropic key or skip.
//
// The wizard always renders as a modal (no escape — only the explicit Finish
// button or top-right Skip closes it) so it can't be accidentally dismissed.
// All persistent state goes through `configStore.update` so the rest of the
// app sees the choices immediately via the CONFIG_CHANGED listener.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ai, pty } from "@/ipc";
import type { ShellInfo, ThemeName } from "@/ipc";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useConfigStore } from "@/state/configStore";
import { THEMES, XTERM_THEMES } from "@/styles/themes";
import { clsx } from "clsx";

export interface FirstRunWizardProps {
  open: boolean;
  onFinish: () => void;
  /** Optional override of the persisted "skip" handler for tests. */
  onSkip?: () => void;
}

type Step = 0 | 1 | 2 | 3;

export function FirstRunWizard({ open, onFinish, onSkip }: FirstRunWizardProps) {
  const update = useConfigStore((s) => s.update);
  const load = useConfigStore((s) => s.load);
  const settings = useConfigStore((s) => s.settings);

  const [step, setStep] = useState<Step>(0);
  const [shells, setShells] = useState<ShellInfo[] | null>(null);
  const [shellError, setShellError] = useState<string | null>(null);
  const [shellPath, setShellPath] = useState<string>("");
  const [theme, setTheme] = useState<ThemeName>("dark");
  const [apiKey, setApiKey] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the theme from settings only once per open so a later config change
  // (CONFIG_CHANGED / a slow async load) can't clobber the user's in-progress pick.
  const seededTheme = useRef(false);

  // Hydrate config once when the wizard is shown so we can seed defaults.
  useEffect(() => {
    if (!open) return;
    void load().catch(() => undefined);
  }, [open, load]);

  // Initial discovery of shells (we always need this for step 1).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    pty
      .listShells()
      .then((list) => {
        if (cancelled) return;
        setShells(list);
        // Seed a default only if the user hasn't picked one yet; the functional
        // updater reads the latest value so we don't need shellPath as a dep.
        if (list.length > 0) {
          setShellPath((cur) => cur || list[0].path);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setShellError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Seed theme from existing settings (in case the user already tweaked it
  // via `config.toml` before triggering the wizard). Run once per open: reset
  // the guard while closed so reopening the wizard re-seeds.
  useEffect(() => {
    if (!open) {
      seededTheme.current = false;
      return;
    }
    if (!settings || seededTheme.current) return;
    seededTheme.current = true;
    const t = settings.appearance.theme;
    if (THEMES.includes(t as ThemeName)) setTheme(t as ThemeName);
  }, [open, settings]);

  const stepCount = 4;

  const next = useCallback(() => {
    setStep((s) => (Math.min(stepCount - 1, s + 1) as Step));
  }, []);
  const back = useCallback(() => {
    setStep((s) => (Math.max(0, s - 1) as Step));
  }, []);

  const persistAndFinish = useCallback(async () => {
    setError(null);
    setSaving(true);
    try {
      // Build the patch progressively so we only touch keys the user actually
      // chose (the store still merges them into the existing tree).
      const patch: Parameters<typeof update>[0] = {};
      if (shellPath) {
        patch.general = settings
          ? { ...settings.general, defaultShell: shellPath }
          : {
              defaultShell: shellPath,
              workingDirectory: null,
              scrollbackLines: 10_000,
              confirmOnClose: true,
            };
      }
      if (theme) {
        patch.appearance = settings
          ? { ...settings.appearance, theme }
          : {
              theme,
              fontFamily: "JetBrains Mono",
              fontSize: 13,
              lineHeight: 1.3,
              cursorStyle: "block",
              cursorBlink: true,
            };
      }
      await update(patch);

      if (apiKey.trim()) {
        try {
          // Onboarding only collects the default provider's key (Anthropic);
          // the other providers are configured later from Settings → AI.
          await ai.setApiKey("anthropic", apiKey.trim());
        } catch (err) {
          // Don't block onboarding on a keyring failure — surface it but still
          // mark the user as onboarded so they aren't stuck in a loop.
          console.warn("[onboarding] failed to save API key:", err);
        }
      }

      onFinish();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [apiKey, onFinish, settings, shellPath, theme, update]);

  const skip = useCallback(() => {
    (onSkip ?? onFinish)();
  }, [onSkip, onFinish]);

  const progress = useMemo(
    () => Math.round(((step + 1) / stepCount) * 100),
    [step],
  );

  return (
    <Modal
      open={open}
      onClose={() => {
        /* prevent backdrop dismiss — user must press Skip explicitly */
      }}
      dismissible={false}
      labelledBy="onboarding-title"
      panelClassName="flex w-[92vw] max-w-2xl flex-col"
    >
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex flex-col">
          <h2 id="onboarding-title" className="font-mono text-lg font-semibold text-zinc-100">
            Welcome to vibe-term
          </h2>
          <p className="font-mono text-[11px] text-zinc-500">
            Step {step + 1} of {stepCount}
          </p>
        </div>
        <button
          type="button"
          onClick={skip}
          className="rounded px-2 py-1 font-mono text-xs text-zinc-400 hover:bg-bg-elevated hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          Skip
        </button>
      </header>

      <div className="h-1 w-full bg-bg-elevated">
        <div
          className="h-full bg-accent transition-all duration-200"
          style={{ width: `${progress}%` }}
          aria-hidden
        />
      </div>

      <div className="flex min-h-[280px] flex-col gap-4 p-6">
        {step === 0 && (
          <WelcomeStep />
        )}
        {step === 1 && (
          <ShellStep
            shells={shells}
            error={shellError}
            value={shellPath}
            onChange={setShellPath}
          />
        )}
        {step === 2 && (
          <ThemeStep value={theme} onChange={setTheme} />
        )}
        {step === 3 && (
          <ApiKeyStep value={apiKey} onChange={setApiKey} />
        )}
        {error && (
          <p className="text-xs text-red-400" role="alert">
            {error}
          </p>
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-border px-6 py-3">
        <Button
          variant="ghost"
          onClick={back}
          disabled={step === 0}
        >
          Back
        </Button>
        {step < stepCount - 1 ? (
          <Button
            variant="primary"
            onClick={next}
            disabled={step === 1 && (shells?.length ?? 0) > 0 && !shellPath}
          >
            Next
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={persistAndFinish}
            disabled={saving}
          >
            {saving ? "Saving…" : "Finish"}
          </Button>
        )}
      </footer>
    </Modal>
  );
}

function WelcomeStep() {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <div className="text-5xl">▮</div>
      <h3 className="font-mono text-lg text-zinc-100">Welcome to vibe-term.</h3>
      <p className="max-w-md text-sm text-zinc-400">
        A modern cross-platform terminal with native image support and an
        integrated AI assistant. Let&apos;s set things up in about 30 seconds.
      </p>
    </div>
  );
}

function ShellStep({
  shells,
  error,
  value,
  onChange,
}: {
  shells: ShellInfo[] | null;
  error: string | null;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <header>
        <h3 className="font-mono text-base font-semibold text-zinc-100">Pick your default shell</h3>
        <p className="text-sm text-zinc-400">
          New tabs will spawn this shell by default. You can override it per-tab later.
        </p>
      </header>
      {error ? (
        <p className="text-sm text-red-400">Failed to enumerate shells: {error}</p>
      ) : !shells ? (
        <p className="text-sm text-zinc-500">Discovering shells…</p>
      ) : shells.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No shells found on PATH. You can configure one later in Settings.
        </p>
      ) : (
        <div className="grid gap-2">
          {shells.map((s) => (
            <button
              key={s.path}
              type="button"
              onClick={() => onChange(s.path)}
              aria-pressed={value === s.path}
              className={clsx(
                "flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                value === s.path
                  ? "border-accent bg-accent/10"
                  : "border-border bg-bg-elevated hover:border-zinc-500",
              )}
            >
              <span className="font-mono text-sm text-zinc-100">{s.name}</span>
              <span className="font-mono text-[11px] text-zinc-500">{s.path}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ThemeStep({
  value,
  onChange,
}: {
  value: ThemeName;
  onChange: (next: ThemeName) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <header>
        <h3 className="font-mono text-base font-semibold text-zinc-100">Pick a theme</h3>
        <p className="text-sm text-zinc-400">
          Switch any time from Settings → Appearance.
        </p>
      </header>
      <div className="grid grid-cols-3 gap-3">
        {THEMES.map((t) => {
          const palette = XTERM_THEMES[t];
          return (
            <button
              key={t}
              type="button"
              onClick={() => onChange(t)}
              aria-pressed={value === t}
              className={clsx(
                "flex flex-col gap-2 rounded-lg border p-2 transition-colors",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                value === t ? "border-accent" : "border-border hover:border-zinc-500",
              )}
            >
              <div
                className="h-20 rounded-md border border-black/30"
                style={{ backgroundColor: palette.background }}
              >
                <div className="flex h-full items-end gap-1 p-2">
                  {(["red", "green", "yellow", "blue", "magenta", "cyan"] as const).map(
                    (k) => (
                      <span
                        key={k}
                        className="h-2 w-2 rounded-sm"
                        style={{ backgroundColor: palette[k] }}
                      />
                    ),
                  )}
                </div>
              </div>
              <span className="text-center font-mono text-xs text-zinc-300">{t}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ApiKeyStep({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <header>
        <h3 className="font-mono text-base font-semibold text-zinc-100">AI assistant (optional)</h3>
        <p className="text-sm text-zinc-400">
          Paste your Anthropic API key to enable Claude inside the terminal. You
          can add or change this later in Settings → AI.
        </p>
      </header>
      <Input
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="sk-ant-…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="text-[11px] text-zinc-500">
        Keys live in your OS keyring — never on disk or in logs.
      </p>
    </div>
  );
}

export default FirstRunWizard;
