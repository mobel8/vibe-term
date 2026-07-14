import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

import { ai } from "@/ipc";
import type { AiProvider, ProviderModels } from "@/ipc";

// Anthropic per-million-token USD costs, used only for the sidebar's running
// cost estimate. The OpenAI-compatible providers aren't priced here (returns 0).
const ANTHROPIC_COST: Record<string, { in: number; out: number }> = {
  "claude-opus-4-7": { in: 15, out: 75 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5-20251001": { in: 0.8, out: 4 },
};

/** Per-million-token in/out cost for the sidebar estimate (0 when unknown). */
export function modelCost(model: string): { in: number; out: number } {
  return ANTHROPIC_COST[model] ?? { in: 0, out: 0 };
}

// One catalogue fetch per session, shared across every ModelPicker instance.
let catalogueCache: ProviderModels[] | null = null;
let cataloguePromise: Promise<ProviderModels[]> | null = null;
function loadCatalogue(): Promise<ProviderModels[]> {
  if (catalogueCache) return Promise.resolve(catalogueCache);
  if (!cataloguePromise) {
    cataloguePromise = ai
      .listModels()
      .then((c) => {
        catalogueCache = c;
        return c;
      })
      .catch((err) => {
        cataloguePromise = null; // allow a retry on a later mount
        throw err;
      });
  }
  return cataloguePromise;
}

interface ModelPickerProps {
  provider: AiProvider;
  model: string;
  onChange: (provider: AiProvider, model: string) => void;
}

export function ModelPicker({ provider, model, onChange }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [catalogue, setCatalogue] = useState<ProviderModels[]>(
    catalogueCache ?? [],
  );
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    void loadCatalogue()
      .then((c) => {
        if (active) setCatalogue(c);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node | null;
      if (buttonRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const providerLabel =
    catalogue.find((p) => p.provider === provider)?.label ?? provider;
  // Short model label (drop any "namespace/" prefix) for the compact button.
  const shortModel = model.split("/").pop() ?? model;

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          "flex items-center gap-2 rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs text-fg transition-colors hover:border-accent-subtle/80",
          open && "border-accent-subtle",
        )}
        title={`${providerLabel} · ${model}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="max-w-[180px] truncate font-mono text-accent">
          {shortModel}
        </span>
        <svg
          aria-hidden="true"
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className={clsx("shrink-0 transition-transform", open && "rotate-180")}
        >
          <path
            d="M1.5 3.5 L5 7 L8.5 3.5"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          ref={menuRef}
          role="listbox"
          className="absolute left-0 top-full z-30 mt-1 max-h-[60vh] w-72 overflow-y-auto rounded-md border border-border bg-bg-elevated p-1 shadow-xl"
        >
          {catalogue.length === 0 && (
            <div className="px-2 py-2 text-xs text-fg-subtle">Loading models…</div>
          )}
          {catalogue.map((grp) => (
            <div key={grp.provider}>
              <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
                {grp.label}
              </div>
              {grp.models.map((mid) => {
                const selected = grp.provider === provider && mid === model;
                return (
                  <button
                    key={`${grp.provider}:${mid}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onChange(grp.provider, mid);
                      setOpen(false);
                    }}
                    className={clsx(
                      "flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs transition-colors",
                      selected
                        ? "bg-accent-subtle/40 text-fg"
                        : "text-fg-muted hover:bg-bg-muted",
                    )}
                  >
                    <span className="truncate font-mono">{mid}</span>
                    {selected && (
                      <span className="shrink-0 text-[10px] uppercase text-accent">
                        active
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
