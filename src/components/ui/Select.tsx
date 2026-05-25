// vibe-term — Select primitive.
//
// Native `<select>` — accessible by default, no portal acrobatics, and looks
// fine in dark mode once we strip the system chrome (Linux/macOS render very
// differently otherwise). We layer a chevron via background-image so we don't
// need an extra icon dependency.

import { forwardRef } from "react";
import type { SelectHTMLAttributes } from "react";

import { clsx } from "clsx";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  hint?: string;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  options: SelectOption[];
  placeholder?: string;
}

const CHEVRON =
  "url(\"data:image/svg+xml;charset=US-ASCII,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='%23a1a1aa'%3E%3Cpath d='M4 6l4 4 4-4z'/%3E%3C/svg%3E\")";

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, options, placeholder, value, defaultValue, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      value={value}
      defaultValue={defaultValue ?? (placeholder ? "" : undefined)}
      className={clsx(
        "w-full appearance-none rounded border border-border bg-bg-subtle pr-8 pl-2.5 py-1.5",
        "font-mono text-sm text-zinc-100",
        "focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/40",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      style={{
        backgroundImage: CHEVRON,
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 8px center",
        backgroundSize: "16px",
      }}
      {...rest}
    >
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.hint ? `${o.label} — ${o.hint}` : o.label}
        </option>
      ))}
    </select>
  );
});

export default Select;
