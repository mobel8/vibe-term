import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

import type { ClaudeModel } from "@/ipc";

interface ModelInfo {
  id: ClaudeModel;
  label: string;
  short: string;
  /** Tagline shown under the label inside the dropdown. */
  tagline: string;
  /** USD per million input / output tokens. */
  inputCost: number;
  outputCost: number;
  /** When false, image inputs will be silently dropped from the request. */
  vision: boolean;
}

export const MODELS: readonly ModelInfo[] = [
  {
    id: "Opus47",
    label: "Claude Opus 4.7",
    short: "Opus 4.7",
    tagline: "Vision · slowest, best reasoning",
    inputCost: 15,
    outputCost: 75,
    vision: true,
  },
  {
    id: "Sonnet46",
    label: "Claude Sonnet 4.6",
    short: "Sonnet 4.6",
    tagline: "Vision · balanced quality and speed",
    inputCost: 3,
    outputCost: 15,
    vision: true,
  },
  {
    id: "Haiku45",
    label: "Claude Haiku 4.5",
    short: "Haiku 4.5",
    tagline: "Text-only here · fastest, cheapest",
    inputCost: 0.8,
    outputCost: 4,
    vision: false,
  },
] as const;

export function modelInfo(id: ClaudeModel): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

interface ModelPickerProps {
  value: ClaudeModel;
  onChange: (model: ClaudeModel) => void;
}

function formatCost(usdPerMillion: number) {
  return `$${usdPerMillion.toFixed(usdPerMillion < 1 ? 2 : 0)} / M`;
}

export function ModelPicker({ value, onChange }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const active = modelInfo(value);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node | null;
      if (
        buttonRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
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

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          "flex items-center gap-2 rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs text-zinc-200 transition-colors hover:border-accent-subtle/80",
          open && "border-accent-subtle",
        )}
        title={`${active.label} · ${formatCost(active.inputCost)} in / ${formatCost(
          active.outputCost,
        )} out`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="font-mono text-accent">{active.short}</span>
        <svg
          aria-hidden="true"
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className={clsx("transition-transform", open && "rotate-180")}
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
          className="absolute left-0 top-full z-30 mt-1 w-72 rounded-md border border-border bg-bg-elevated p-1 shadow-xl"
        >
          {MODELS.map((m) => {
            const selected = m.id === value;
            return (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                className={clsx(
                  "flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left text-xs transition-colors",
                  selected
                    ? "bg-accent-subtle/40 text-zinc-100"
                    : "text-zinc-300 hover:bg-bg-muted",
                )}
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <span className="font-medium">{m.label}</span>
                  {selected && (
                    <span className="text-[10px] uppercase text-accent">active</span>
                  )}
                </div>
                <span className="text-[11px] text-zinc-500">{m.tagline}</span>
                <span className="mt-0.5 font-mono text-[10px] text-zinc-600">
                  {formatCost(m.inputCost)} in · {formatCost(m.outputCost)} out
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
