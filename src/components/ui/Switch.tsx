// vibe-term — Switch (iOS-style toggle).
//
// Implemented on top of a hidden `<input type="checkbox">` so it stays
// keyboard accessible and screen-readers announce the role/state for free.
// The visual track + thumb are pure Tailwind.

import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";

import { clsx } from "clsx";

export type SwitchProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "size"
> & {
  label?: string;
};

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { className, checked, onChange, disabled, label, id, ...rest },
  ref,
) {
  return (
    <label
      htmlFor={id}
      className={clsx(
        "inline-flex cursor-pointer items-center gap-2 select-none",
        disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <span className="relative inline-flex">
        <input
          id={id}
          ref={ref}
          type="checkbox"
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          className="peer sr-only"
          {...rest}
        />
        <span
          aria-hidden
          className={clsx(
            "block h-5 w-9 rounded-full bg-bg-elevated border border-border",
            "transition-colors duration-150",
            "peer-checked:bg-accent peer-checked:border-accent",
            "peer-focus-visible:ring-2 peer-focus-visible:ring-accent/60 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-bg",
          )}
        />
        <span
          aria-hidden
          className={clsx(
            "pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-zinc-100 shadow",
            "transition-transform duration-150",
            "peer-checked:translate-x-4",
          )}
        />
      </span>
      {label && <span className="font-mono text-sm text-zinc-300">{label}</span>}
    </label>
  );
});

export default Switch;
