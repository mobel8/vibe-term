// vibe-term — Toast queue.
//
// A small append-only queue. `push` returns the generated id so callers can
// `dismiss` programmatically (e.g. an AI request that completes before the
// "thinking…" toast auto-dismisses).
//
// Auto-dismissal lives in this module rather than in `<Toast>` so dismissal
// keeps working even if the component is unmounted mid-flight (theme change,
// route change, etc.). Timers are tracked in a module-level Map and cleared on
// explicit `dismiss` to avoid stale set-state.

import { create } from "zustand";
import { customAlphabet } from "nanoid";

export type ToastVariant = "info" | "success" | "warn" | "error";

export interface ToastAction {
  label: string;
  onClick(): void;
}

export interface Toast {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
  duration?: number;
  action?: ToastAction;
  createdAt: number;
}

const TOAST_ID = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);
const newToastId = () => `toast_${TOAST_ID()}`;

const DEFAULT_DURATION_MS = 4000;
/** Pass this duration to keep a toast on screen until explicitly dismissed. */
export const TOAST_PERSISTENT = 0;

/** Module-scoped timers — survive component re-renders. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

interface ToastState {
  toasts: Toast[];
  /** Enqueue a new toast. Returns its id for programmatic dismissal. */
  push(toast: Omit<Toast, "id" | "createdAt"> & { id?: string }): string;
  /** Remove a toast by id. Cancels the pending auto-dismiss timer. */
  dismiss(id: string): void;
  /** Drop every toast. Useful at logout / route change. */
  clear(): void;
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  push(toast) {
    const id = toast.id ?? newToastId();
    const next: Toast = {
      id,
      variant: toast.variant,
      title: toast.title,
      description: toast.description,
      duration: toast.duration,
      action: toast.action,
      createdAt: Date.now(),
    };
    set((state) => ({ toasts: [...state.toasts, next] }));

    const duration = toast.duration ?? DEFAULT_DURATION_MS;
    if (duration > 0) {
      const timer = setTimeout(() => {
        get().dismiss(id);
      }, duration);
      timers.set(id, timer);
    }
    return id;
  },

  dismiss(id) {
    const t = timers.get(id);
    if (t) {
      clearTimeout(t);
      timers.delete(id);
    }
    set((state) => ({ toasts: state.toasts.filter((x) => x.id !== id) }));
  },

  clear() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    set({ toasts: [] });
  },
}));

// Convenience helpers — read nicer at call sites than `useToastStore.getState().push(...)`.
export const toast = {
  info: (title: string, opts?: Partial<Omit<Toast, "id" | "title" | "variant" | "createdAt">>) =>
    useToastStore.getState().push({ variant: "info", title, ...opts }),
  success: (title: string, opts?: Partial<Omit<Toast, "id" | "title" | "variant" | "createdAt">>) =>
    useToastStore.getState().push({ variant: "success", title, ...opts }),
  warn: (title: string, opts?: Partial<Omit<Toast, "id" | "title" | "variant" | "createdAt">>) =>
    useToastStore.getState().push({ variant: "warn", title, ...opts }),
  error: (title: string, opts?: Partial<Omit<Toast, "id" | "title" | "variant" | "createdAt">>) =>
    useToastStore.getState().push({ variant: "error", title, ...opts }),
  dismiss: (id: string) => useToastStore.getState().dismiss(id),
};
