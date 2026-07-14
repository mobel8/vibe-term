// vibe-term — Settings → AI tab.
//
// Surfaces, per provider (Anthropic / Groq / Mistral / Cerebras / DeepSeek):
//   • provider     : which API to route to
//   • model        : provider-specific lineup (from `ai_list_models`)
//   • context size : slider 1–20 blocks
//   • API key      : ONE stored key per provider (`ai_set_api_key(provider,…)`)
//
// Each provider keeps its own key in the OS keyring, so you can configure
// several and switch between them from the chat's model picker.

import { useCallback, useEffect, useState } from "react";

import { ai } from "@/ipc";
import type { AiProvider, AiSettings, ProviderModels, Settings } from "@/ipc";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";

interface Props {
  value: AiSettings;
  onPatch: (patch: Partial<Settings>) => void;
}

const PROVIDER_KEY_HINT: Record<AiProvider, string> = {
  anthropic: "sk-ant-…",
  groq: "gsk_…",
  mistral: "your Mistral key",
  cerebras: "csk-…",
  deepseek: "sk-…",
};

const CONTEXT_MIN = 1;
const CONTEXT_MAX = 20;

type SaveStatus =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "ok" }
  | { state: "error"; message: string };

export function AiTab({ value, onPatch }: Props) {
  const [catalogue, setCatalogue] = useState<ProviderModels[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [keyStored, setKeyStored] = useState<boolean | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ state: "idle" });

  // Load the provider/model catalogue once.
  useEffect(() => {
    let cancelled = false;
    ai.listModels()
      .then((c) => {
        if (!cancelled) setCatalogue(c);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-check the stored-key status whenever the selected provider changes.
  useEffect(() => {
    let cancelled = false;
    setKeyStored(null);
    setApiKey("");
    setSaveStatus({ state: "idle" });
    ai.hasKey(value.provider)
      .then((has) => {
        if (!cancelled) setKeyStored(has);
      })
      .catch(() => {
        if (!cancelled) setKeyStored(false);
      });
    return () => {
      cancelled = true;
    };
  }, [value.provider]);

  function patchAi(patch: Partial<AiSettings>) {
    onPatch({ ai: { ...value, ...patch } });
  }

  function selectProvider(next: AiProvider) {
    // Move to the new provider and default to its first model to avoid a
    // model/provider mismatch.
    const firstModel =
      catalogue.find((c) => c.provider === next)?.models[0] ?? value.model;
    patchAi({ provider: next, model: firstModel });
  }

  const saveKey = useCallback(async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    setSaveStatus({ state: "saving" });
    try {
      await ai.setApiKey(value.provider, trimmed);
      setApiKey("");
      setKeyStored(true);
      setSaveStatus({ state: "ok" });
    } catch (err) {
      setSaveStatus({
        state: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [apiKey, value.provider]);

  const clearKey = useCallback(async () => {
    try {
      await ai.deleteKey(value.provider);
    } catch {
      // best-effort; fall through to the entry form regardless
    }
    setKeyStored(false);
    setApiKey("");
    setSaveStatus({ state: "idle" });
  }, [value.provider]);

  const providerOptions = catalogue.map((c) => ({
    value: c.provider,
    label: c.label,
  }));
  const providerModels =
    catalogue.find((c) => c.provider === value.provider)?.models ?? [];
  // Show the saved model even if it's not in the known lineup (stale id /
  // hand-edited config) so the <select> reflects reality without rewriting it.
  const modelValues = providerModels.includes(value.model)
    ? providerModels
    : value.model
      ? [value.model, ...providerModels]
      : providerModels;
  const modelOptions = modelValues.map((m) => ({ value: m, label: m }));

  return (
    <div className="flex flex-col gap-6">
      <Section title="Provider" hint="Each provider stores its own API key.">
        <Select
          value={value.provider}
          onChange={(e) => selectProvider(e.target.value as AiProvider)}
          options={
            providerOptions.length > 0
              ? providerOptions
              : [{ value: value.provider, label: value.provider }]
          }
        />
      </Section>

      <Section title="Model" hint="Default model for new AI conversations.">
        <Select
          value={value.model}
          onChange={(e) => patchAi({ model: e.target.value })}
          options={
            modelOptions.length > 0
              ? modelOptions
              : [{ value: value.model, label: value.model || "(none)" }]
          }
        />
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
            onChange={(e) =>
              patchAi({ maxContextBlocks: Number(e.target.value) })
            }
            className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-bg-elevated accent-accent"
            aria-label="Max context blocks"
          />
          <span className="w-10 text-right font-mono text-sm text-fg">
            {value.maxContextBlocks}
          </span>
        </div>
      </Section>

      <Section
        title="API key"
        hint={
          keyStored
            ? `A key for this provider is stored in the OS keyring. Use Replace to rotate it.`
            : "Stored straight in the OS keyring; never written to disk."
        }
      >
        {keyStored ? (
          <div className="flex items-center gap-2">
            <Input
              value="••••••••••••••••••••••••"
              readOnly
              aria-label="Stored API key"
            />
            <Button variant="subtle" onClick={() => void clearKey()}>
              Replace
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={PROVIDER_KEY_HINT[value.provider]}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveKey();
              }}
            />
            <Button
              variant="primary"
              onClick={() => void saveKey()}
              disabled={!apiKey.trim() || saveStatus.state === "saving"}
            >
              {saveStatus.state === "saving" ? "Saving…" : "Save"}
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

export default AiTab;
