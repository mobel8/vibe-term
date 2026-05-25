// vibe-term — Toast primitives.
//
// Two exports:
//   • <ToastContainer/> — a fixed-position stack mounted once at app root.
//     Subscribes to the toast queue and renders each item with a fade+slide.
//   • <ToastCard/> — the visual primitive, reusable for storybook-style
//     previews or for custom containers (e.g. inside a modal).
//
// We rely on CSS transitions for enter (the element is just inserted into the
// list) and a CSS-driven leave handled by `data-leaving` flipped via a small
// state slot when the item disappears from the store. For a v1 we keep it
// simple and let the unmount happen instantly; the auto-dismiss duration is
// the user-perceived "stay" time and the leave animation is decorative.

import { useEffect, useState } from "react";
import { clsx } from "clsx";

import {
  type Toast as ToastModel,
  type ToastVariant,
  useToastStore,
} from "@/state/toastStore";

interface ToastCardProps {
  toast: ToastModel;
  onDismiss: (id: string) => void;
}

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  info: "border-accent-subtle/60 bg-bg-elevated/95 text-zinc-100",
  success:
    "border-emerald-500/40 bg-emerald-950/70 text-emerald-100",
  warn: "border-amber-500/40 bg-amber-950/70 text-amber-100",
  error: "border-red-500/40 bg-red-950/70 text-red-100",
};

const VARIANT_DOT: Record<ToastVariant, string> = {
  info: "bg-accent",
  success: "bg-emerald-400",
  warn: "bg-amber-400",
  error: "bg-red-400",
};

export function ToastCard({ toast, onDismiss }: ToastCardProps) {
  const [mounted, setMounted] = useState(false);
  // Trigger the enter transition one frame after mount so the initial state
  // (translated/opaque-0) is actually painted before we transition.
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div
      role={toast.variant === "error" ? "alert" : "status"}
      aria-live={toast.variant === "error" ? "assertive" : "polite"}
      data-toast-id={toast.id}
      className={clsx(
        "pointer-events-auto flex w-80 max-w-[90vw] gap-3 rounded-lg border px-3 py-2.5 shadow-lg backdrop-blur transition-all duration-200 ease-out",
        VARIANT_CLASSES[toast.variant],
        mounted
          ? "translate-y-0 opacity-100"
          : "translate-y-2 opacity-0",
      )}
    >
      <span
        aria-hidden
        className={clsx("mt-1.5 h-2 w-2 shrink-0 rounded-full", VARIANT_DOT[toast.variant])}
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium leading-snug">{toast.title}</div>
        {toast.description && (
          <div className="mt-0.5 text-xs leading-snug text-zinc-300/90">
            {toast.description}
          </div>
        )}
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              onDismiss(toast.id);
            }}
            className="mt-1.5 inline-flex h-6 items-center rounded border border-current/30 px-2 text-[11px] font-medium text-current/90 hover:bg-current/10"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
        className="self-start text-zinc-400 transition-colors hover:text-zinc-100"
      >
        ×
      </button>
    </div>
  );
}

/**
 * Mount this once at the app root. It owns no state of its own — it just
 * mirrors the global toast queue into a fixed-position stack.
 */
export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col-reverse gap-2"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>
  );
}

export default ToastContainer;
