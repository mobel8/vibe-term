// vibe-term — Settings → Appearance tab.
//
// Drives the `appearance.*` keys: theme tiles, font family/size/line-height,
// cursor style + blink. Each control patches the parent through `onPatch` —
// same debounced sink as the other tabs.

import { useEffect, useMemo, useState } from "react";

import type { AppearanceSettings, CursorStyle, Settings } from "@/ipc";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { XTERM_THEMES, THEMES, type ThemeName } from "@/styles/themes";

import { clsx } from "clsx";

interface Props {
  value: AppearanceSettings;
  onPatch: (patch: Partial<Settings>) => void;
}

// Curated whitelist of common monospace fonts. We don't enumerate the OS
// font list (no portable API in the webview); users can still type any
// custom value if they want and the browser will fall back gracefully.
const FONT_CHOICES = [
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "Hack",
  "Source Code Pro",
  "IBM Plex Mono",
  "Iosevka",
  "SF Mono",
  "Menlo",
  "Consolas",
  "monospace",
] as const;

const CURSOR_STYLES: Array<{ value: CursorStyle; label: string; glyph: string }> = [
  { value: "block", label: "Block", glyph: "█" },
  { value: "bar", label: "Bar", glyph: "▎" },
  { value: "underline", label: "Underline", glyph: "_" },
];

const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 24;
const LINE_HEIGHT_MIN = 1.0;
const LINE_HEIGHT_MAX = 2.0;

export function AppearanceTab({ value, onPatch }: Props) {
  function patchAppearance(patch: Partial<AppearanceSettings>) {
    onPatch({ appearance: { ...value, ...patch } });
  }

  const fontOptions = useMemo(() => {
    // Ensure the user's current font shows up even if it's outside our preset list.
    const all = new Set<string>([...FONT_CHOICES, value.fontFamily]);
    return Array.from(all).map((f) => ({ value: f, label: f }));
  }, [value.fontFamily]);

  return (
    <div className="flex flex-col gap-6">
      <Section title="Theme" hint="Switch between the bundled palettes or follow the OS preference.">
        <div className="grid grid-cols-3 gap-3 md:grid-cols-5 lg:grid-cols-6">
          {THEMES.map((t) => (
            <ThemeTile
              key={t}
              name={t}
              active={value.theme === t}
              onSelect={() => patchAppearance({ theme: t })}
            />
          ))}
          <SystemTile
            active={value.theme === "system"}
            onSelect={() => patchAppearance({ theme: "system" })}
          />
        </div>
      </Section>

      <Section title="Font family" hint="Any installed monospace font will work — fallbacks are baked in.">
        <Select
          value={value.fontFamily}
          onChange={(e) => patchAppearance({ fontFamily: e.target.value })}
          options={fontOptions}
        />
        <div
          className="mt-3 rounded border border-border bg-bg p-3 text-sm"
          style={{ fontFamily: value.fontFamily }}
        >
          <span className="text-zinc-500">$ </span>
          <span className="text-zinc-100">
            vibe-term --preview &ldquo;The quick brown fox jumps over 13 lazy dogs.&rdquo;
          </span>
        </div>
      </Section>

      <Section title="Font size" hint={`Pixels (${FONT_SIZE_MIN}–${FONT_SIZE_MAX}).`}>
        <Stepper
          value={value.fontSize}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          onChange={(n) => patchAppearance({ fontSize: n })}
        />
      </Section>

      <Section title="Line height" hint={`Multiplier (${LINE_HEIGHT_MIN.toFixed(1)}–${LINE_HEIGHT_MAX.toFixed(1)}).`}>
        <Stepper
          value={value.lineHeight}
          min={LINE_HEIGHT_MIN}
          max={LINE_HEIGHT_MAX}
          step={0.1}
          decimals={1}
          onChange={(n) => patchAppearance({ lineHeight: n })}
        />
      </Section>

      <Section title="Cursor">
        <div className="flex flex-wrap items-center gap-2">
          {CURSOR_STYLES.map((c) => {
            const active = value.cursorStyle === c.value;
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => patchAppearance({ cursorStyle: c.value })}
                aria-pressed={active}
                className={clsx(
                  "flex items-center gap-2 rounded border px-3 py-1.5 font-mono text-sm",
                  "transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                  active
                    ? "border-accent bg-accent/10 text-zinc-100"
                    : "border-border bg-bg-elevated text-zinc-300 hover:bg-bg-muted",
                )}
              >
                <span className="text-accent">{c.glyph}</span>
                {c.label}
              </button>
            );
          })}
        </div>
        <div className="mt-3">
          <Switch
            id="appearance-cursor-blink"
            checked={value.cursorBlink}
            onChange={(e) => patchAppearance({ cursorBlink: e.target.checked })}
            label="Blink cursor"
          />
        </div>
      </Section>
    </div>
  );
}

function ThemeTile({
  name,
  active,
  onSelect,
}: {
  name: ThemeName;
  active: boolean;
  onSelect: () => void;
}) {
  const palette = XTERM_THEMES[name];
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={clsx(
        "group flex flex-col gap-1.5 rounded-lg border p-2",
        "transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
        active ? "border-accent" : "border-border hover:border-zinc-500",
      )}
    >
      <div
        className="h-16 rounded-md border border-black/30 shadow-inner"
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
      <span className="text-center font-mono text-xs text-zinc-300">{name}</span>
    </button>
  );
}

function SystemTile({
  active,
  onSelect,
}: {
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={clsx(
        "flex flex-col gap-1.5 rounded-lg border p-2",
        "transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
        active ? "border-accent" : "border-border hover:border-zinc-500",
      )}
    >
      <div className="relative h-16 overflow-hidden rounded-md border border-black/30">
        <div className="absolute inset-y-0 left-0 w-1/2 bg-[#fafafa]" />
        <div className="absolute inset-y-0 right-0 w-1/2 bg-[#0a0a0b]" />
      </div>
      <span className="text-center font-mono text-xs text-zinc-300">system</span>
    </button>
  );
}

function Stepper({
  value,
  min,
  max,
  step,
  decimals = 0,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  onChange: (n: number) => void;
}) {
  function clamp(n: number): number {
    if (Number.isNaN(n)) return min;
    const factor = 10 ** decimals;
    const rounded = Math.round(n * factor) / factor;
    return Math.min(max, Math.max(min, rounded));
  }

  // Defensive: if the caller hands us undefined (config.toml missing the key,
  // or the Rust deserializer returned a partial AppearanceSettings), fall
  // back to `min` so `.toFixed()` below doesn't blow up the whole settings
  // panel inside an ErrorBoundary.
  const safeValue = typeof value === "number" && Number.isFinite(value) ? value : min;

  // Hold the raw text the user is typing locally so we don't clamp/reformat on
  // every keystroke (which would snap a cleared field to `min` and fight
  // intermediate values like "1" on the way to "1.5"). We commit — clamp +
  // propagate — only on blur/Enter. The +/- buttons keep clamping immediately.
  const display = decimals > 0 ? safeValue.toFixed(decimals) : String(safeValue);
  const [text, setText] = useState(display);

  // Re-sync the local text whenever the upstream value changes (via the +/-
  // buttons or external CONFIG_CHANGED reconciliation), so the box always
  // reflects the committed value once we're not mid-edit.
  useEffect(() => {
    setText(display);
  }, [display]);

  function commit() {
    const next = clamp(Number(text));
    onChange(next);
    // Snap the local text back to the canonical formatting of the committed
    // value (the useEffect above only fires when `value` actually changes, so
    // re-clamping the same value still needs this to reset e.g. an empty box).
    setText(decimals > 0 ? next.toFixed(decimals) : String(next));
  }

  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => onChange(clamp(safeValue - step))}
        className="rounded border border-border bg-bg-elevated px-2 py-1 font-mono text-sm text-zinc-200 hover:bg-bg-muted disabled:opacity-50"
        disabled={safeValue <= min}
        aria-label="Decrease"
      >
        −
      </button>
      <Input
        type="number"
        value={text}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        className="w-20 text-center"
      />
      <button
        type="button"
        onClick={() => onChange(clamp(safeValue + step))}
        className="rounded border border-border bg-bg-elevated px-2 py-1 font-mono text-sm text-zinc-200 hover:bg-bg-muted disabled:opacity-50"
        disabled={safeValue >= max}
        aria-label="Increase"
      >
        +
      </button>
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

export default AppearanceTab;
