import { useState } from "react";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import clsx from "clsx";

import { ai } from "@/ipc";

interface ApiKeyPromptProps {
  /** Called once the key is successfully stored. */
  onSaved: () => void;
  /** Optional dismiss for when the user wants to come back later. */
  onCancel?: () => void;
}

/**
 * Onboarding modal shown the first time the AI panel is opened. We store the
 * key through `ai.setApiKey` which delegates to the OS keyring; the value
 * never lives in JS state once the round-trip completes.
 */
export function ApiKeyPrompt({ onSaved, onCancel }: ApiKeyPromptProps) {
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("API key cannot be empty.");
      return;
    }
    if (!trimmed.startsWith("sk-ant-")) {
      setError("Expected a key starting with sk-ant-…");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await ai.setApiKey(trimmed);
      const stored = await ai.hasKey();
      if (!stored) {
        throw new Error("Backend reported no key after save.");
      }
      setValue("");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const openConsole = async () => {
    try {
      await openUrl("https://console.anthropic.com/settings/keys");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-key-title"
    >
      <div className="w-[90%] max-w-sm rounded-xl border border-border bg-bg-elevated p-5 shadow-2xl">
        <h2 id="ai-key-title" className="text-base font-semibold text-zinc-100">
          Connect to Claude
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-zinc-400">
          Your key is stored in the OS keyring, never sent anywhere except{" "}
          <span className="font-mono text-zinc-300">api.anthropic.com</span>.
        </p>

        <label htmlFor="ai-key-input" className="mt-4 block text-xs text-zinc-300">
          Anthropic API key
        </label>
        <div className="mt-1 flex items-center gap-1.5 rounded-md border border-border bg-bg-subtle focus-within:border-accent-subtle">
          <input
            id="ai-key-input"
            type={reveal ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSave();
              }
            }}
            placeholder="sk-ant-…"
            className="flex-1 bg-transparent px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none placeholder:text-zinc-600"
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            className="px-2 text-[11px] text-zinc-400 hover:text-zinc-100"
            aria-pressed={reveal}
            aria-label={reveal ? "hide key" : "reveal key"}
          >
            {reveal ? "hide" : "show"}
          </button>
        </div>

        {error && (
          <div className="mt-2 rounded border border-red-700/60 bg-red-950/50 px-2 py-1 font-mono text-[11px] text-red-200">
            {error}
          </div>
        )}

        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={openConsole}
            className="text-[11px] text-accent hover:underline"
          >
            Get an API key →
          </button>
          <div className="flex items-center gap-2">
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-bg-muted hover:text-zinc-200"
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={submitting}
              className={clsx(
                "rounded-md bg-accent px-3 py-1 text-xs font-medium text-bg shadow",
                submitting
                  ? "cursor-progress opacity-70"
                  : "hover:bg-accent/90 active:translate-y-px",
              )}
            >
              {submitting ? "Saving…" : "Save & test"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
