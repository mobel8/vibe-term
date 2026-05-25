// vibe-term — Button primitive.
//
// Three variants kept intentionally short — we are not building Radix here.
//   • primary  : accent-coloured filled
//   • subtle   : flat, hover background
//   • danger   : red-tinted destructive (used by Reset / Delete actions)
//
// All variants share focus-visible ring, disabled cursor + opacity, and a
// consistent 8px-rhythm horizontal padding.

import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";

import { clsx } from "clsx";

export type ButtonVariant = "primary" | "subtle" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-white hover:bg-accent/90 active:bg-accent/80 disabled:bg-accent/40",
  subtle:
    "bg-bg-elevated text-zinc-100 hover:bg-bg-muted active:bg-bg-subtle border border-border",
  danger:
    "bg-red-600/90 text-white hover:bg-red-500 active:bg-red-700 disabled:bg-red-900/40",
  ghost:
    "bg-transparent text-zinc-300 hover:bg-bg-elevated hover:text-zinc-100",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-3.5 py-1.5 text-sm",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "subtle", size = "md", className, type = "button", ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={clsx(
          "inline-flex items-center justify-center gap-1.5 rounded font-mono",
          "transition-colors duration-100 ease-out",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          "disabled:cursor-not-allowed disabled:opacity-60",
          VARIANTS[variant],
          SIZES[size],
          className,
        )}
        {...rest}
      />
    );
  },
);

export default Button;
