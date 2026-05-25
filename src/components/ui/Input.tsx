// vibe-term — Input primitive.
//
// Native `<input>` with our consistent border/ring treatment. Forwards refs so
// callers can focus() or measure the underlying element (e.g. the hotkey
// capture cell that needs to call `inputRef.current?.focus()`).

import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";

import { clsx } from "clsx";

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid = false, type = "text", ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      aria-invalid={invalid || undefined}
      className={clsx(
        "w-full rounded border bg-bg-subtle px-2.5 py-1.5 font-mono text-sm text-zinc-100",
        "placeholder:text-zinc-500",
        "transition-colors duration-100",
        "focus:outline-none focus:ring-2 focus:ring-accent/40",
        invalid
          ? "border-red-500/70 focus:ring-red-500/40"
          : "border-border focus:border-accent",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...rest}
    />
  );
});

export default Input;
