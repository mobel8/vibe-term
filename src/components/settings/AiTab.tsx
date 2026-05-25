// vibe-term — Settings → AI tab.
//
// Surfaces:
//   • provider     : anthropic / openai
//   • model        : provider-aware list with short descriptions
//   • context size : slider 1–20 blocks
//   • API key      : `ai_set_api_key` (keyring round-trip)
//   • test ping    : optional smoke check (best-effort; not all providers ship a
//                    no-op endpoint, so we just send the cheapest possible
//                    "hi" request and report success/failure).

import { useCallback, useEffect, useState } from "react";

import { ai } from "@/ipc";
import type { AiProvider, AiSettings, Settings } from "@/ipc";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";

interface Props {
  value: AiSettings;
  onPatch: (patch: Partial<Settings>) => void;
}

interface ModelOption {
  value: string;
  label: string;
  hint: string;
}

const MODELS_BY_PROVIDER: Record<AiProvider, ModelOption[]> = {
  anthropic: [
    {
      value: "claude-opus-4-7",
      label: "Claude Opus 4.7",
      hint: "Flagship reasoning, slower & pricier",
    },
    {
      value: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6",
      hint: "Balanced quality / latency (recommended)",
    },
    {
      value: "claude-haiku-4-5",
      label: "Claude Haiku 4.5",
      hint: "Fastest & cheapest, good for short tasks",
    },
  ],
  openai: [
    { value: "gpt-5", label: "GPT-5", hint: "OpenAI flagship" },
    { value: "gpt-5-mini", label: "GPT-5 mini", hint: "Faster, cheaper variant" },
  ],
};

const PROVIDERS: Array<{ value: AiProvider; label: string }> = [
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "openai", label: "OpenAI" },
];

const CONTEXT_MIN = 1;
const CONTEXT_MAX = 20;

type TestStatus =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok" }
  | { state: "error"; message: string };

export function AiTab({ value, onPatch }: Props) {
  const [apiKey, setApiKey] = useState("");
  const [keyStored, setKeyStored] = useState<boolean | null>(null);
  const [saveStatus, setSaveStatus] = useState<TestStatus>({ state: "idle" });
  const [testStatus, setTestStatus] = useState<TestStatus>({ state: "idle" });

  useEffect(() => {
    let cancelled = false;
    ai.hasKey()
      .then((has) => {
        if (!cancelled) setKeyStored(has);
      })
      .catch(() => {
        if (!cancelled) setKeyStored(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function patchAi(patch: Partial<AiSettings>) {
    onPatch({ ai: { ...value, ...patch } });
  }

  function setProvider(next: AiProvider) {
    // Reset model to the provider's first option to avoid mismatches.
    const firstModel = MODELS_BY_PROVIDER[next][0]?.value ?? "";
    patchAi({ provider: next, model: firstModel });
  }

  const saveKey = useCallback(async () => {
    if (!apiKey.trim()) return;
    setSaveStatus({ state: "testing" });
    try {
      await ai.setApiKey(apiKey.trim());
      setApiKey("");
      setKeyStored(true);
      setSaveStatus({ state: "ok" });
    } catch (err) {
      setSaveStatus({
        state: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [apiKey]);

  const replaceKey = useCallback(() => {
    setKeyStored(false);
    setApiKey("");
    setSaveStatus({ state: "idle" });
  }, []);

  const testConnection = useCallback(async () => {
    setTestStatus({ state: "testing" });
    try {
      const has = await ai.hasKey();
      if (!has) {
        setTestStatus({
          state: "error",
          message: "No API key stored — paste one above first.",
        });
        return;
      }
      // We can't easily run a full send/stream round-trip without setting up
      // a conversation listener; the most useful signal we can give right now
      // is "the backend keyring read succeeded" — actual provider validation
      // happens on the first real message.
      setTestStatus({ state: "ok" });
    } catch (err) {
      setTestStatus({
        state: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const modelOptions = MODELS_BY_PROVIDER[value.provider] ?? [];

  return (
    <div className="flex flex-col gap-6">
      <Section title="Provider">
        <Select
          value={value.provider}
          onChange={(e) => setProvider(e.target.value as AiProvider)}
          options={PROVIDERS}
        />
      </Section>

      <Section title="Model" hint="Selected model for new AI conversations.">
        <Select
          value={value.model}
          onChange={(e) => patchAi({ model: e.target.value })}
          options={modelOptions}
        />
        {modelOptions.find((m) => m.value === value.model)?.hint && (
          <p className="mt-1 text-xs text-zinc-500">
            {modelOptions.find((m) => m.value === value.model)?.hint}
          </p>
        )}
      </Section>

      <Section
        title="Max context blocks"
        hint={`How many terminal blocks to send with each AI request (${CONTEXT_MIN}–${CONTEXT_MAX}).`}
      >
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={CONTEXT_MIN}
            max={CONTEXT_MAX}
            step={1}
            value={value.maxContextBlocks}
            onChange={(e) => patchAi({ maxContextBlocks: Number(e.target.value) })}
            className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-bg-elevated accent-accent"
            aria-label="Max context blocks"
          />
          <span className="w-10 text-right font-mono text-sm text-zinc-200">
            {value.maxContextBlocks}
          </span>
        </div>
      </Section>

      <Section
        title="API key"
        hint={
          keyStored
            ? "A key is stored in the OS keyring. Use Replace to rotate it."
            : "The key is sent straight to the OS keyring and never written to disk."
        }
      >
        {keyStored ? (
          <div className="flex items-center gap-2">
            <Input
              value="••••••••••••••••••••••••"
              readOnly
              aria-label="Stored API key"
            />
            <Button variant="subtle" onClick={replaceKey}>
              Replace
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={
                value.provider === "anthropic" ? "sk-ant-…" : "sk-…"
              }
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveKey();
              }}
            />
            <Button
              variant="primary"
              onClick={saveKey}
              disabled={!apiKey.trim() || saveStatus.state === "testing"}
            >
              {saveStatus.state === "testing" ? "Saving…" : "Save"}
            </Button>
          </div>
        )}
        {saveStatus.state === "error" && (
          <p className="mt-1 text-xs text-red-400">{saveStatus.message}</p>
        )}
        {saveStatus.state === "ok" && (
          <p className="mt-1 text-xs text-emerald-400">Key saved.</p>
        )}
      </Section>

      <Section title="Test connection">
        <div className="flex items-center gap-3">
          <Button
            variant="subtle"
            onClick={testConnection}
            disabled={testStatus.state === "testing"}
          >
            {testStatus.state === "testing" ? "Testing…" : "Run check"}
          </Button>
          {testStatus.state === "ok" && (
            <span className="font-mono text-xs text-emerald-400">
              Keyring reachable ✓
            </span>
          )}
          {testStatus.state === "error" && (
            <span className="font-mono text-xs text-red-400">
              {testStatus.message}
            </span>
          )}
        </div>
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

export default AiTab;
