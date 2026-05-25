// vibe-term — Modal primitive.
//
// Lightweight headless dialog. Renders into a portal so it always sits above
// the app tree, dims/blurs the backdrop, traps focus while open, and closes
// on Escape or backdrop click (unless `dismissible={false}`).
//
// We deliberately avoid Radix-Dialog here because the dependency only ships
// to power `cmdk` already; bringing it into our settings flow would double
// the surface API for very little gain.

import { useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { clsx } from "clsx";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Sets aria-labelledby on the dialog. */
  labelledBy?: string;
  /** Sets aria-describedby on the dialog. */
  describedBy?: string;
  /** When false, ignores Escape and backdrop clicks. */
  dismissible?: boolean;
  /**
   * Tailwind classes appended to the panel. Use this to widen or narrow the
   * modal (defaults to a generous w/h that suits the settings panel).
   */
  panelClassName?: string;
  /** Optional extra classes for the backdrop wrapper. */
  backdropClassName?: string;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function Modal({
  open,
  onClose,
  children,
  labelledBy,
  describedBy,
  dismissible = true,
  panelClassName,
  backdropClassName,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Remember the element that opened the modal so we can return focus on close.
  const openerRef = useRef<HTMLElement | null>(null);

  // Capture the opener and restore focus on close — purely a side-effect on
  // the `open` boolean transition.
  useEffect(() => {
    if (open) {
      openerRef.current = document.activeElement as HTMLElement | null;
      // Defer to next tick so the portal is mounted and focusable elements
      // are in the DOM.
      const id = window.requestAnimationFrame(() => {
        const panel = panelRef.current;
        if (!panel) return;
        const focusable = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
        const first = focusable[0];
        // Fall back to focusing the panel itself if no focusable children.
        if (first) first.focus();
        else panel.focus();
      });
      return () => window.cancelAnimationFrame(id);
    }
    // Restore focus to whatever opened us.
    openerRef.current?.focus?.();
    return;
  }, [open]);

  // Lock background scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape" && dismissible) {
        e.stopPropagation();
        onClose();
        return;
      }
      // Minimal focus trap: confine Tab/Shift+Tab to the panel.
      if (e.key === "Tab") {
        const panel = panelRef.current;
        if (!panel) return;
        const focusable = Array.from(
          panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        ).filter((el) => !el.hasAttribute("disabled"));
        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [dismissible, onClose],
  );

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className={clsx(
        "fixed inset-0 z-50 flex items-center justify-center",
        "bg-black/60 backdrop-blur-sm",
        backdropClassName,
      )}
      onMouseDown={(e) => {
        if (!dismissible) return;
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={clsx(
          "relative max-h-[92vh] w-[92vw] max-w-5xl",
          "rounded-xl border border-border bg-bg-subtle shadow-2xl",
          "outline-none",
          panelClassName,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export default Modal;
