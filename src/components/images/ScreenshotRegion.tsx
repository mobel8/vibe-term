import { useCallback, useEffect, useRef, useState } from "react";

import type { CaptureMode } from "@/ipc";

interface ScreenshotRegionProps {
  /** Called with the absolute pixel rect once the user releases the mouse. */
  onSelect(mode: Extract<CaptureMode, { kind: "region" }>): void;
  /** Called when the user cancels (Esc, right-click, or empty drag). */
  onCancel(): void;
}

const MIN_REGION_PX = 8;

/**
 * Full-screen, transparent overlay that lets the user draw a rectangle and
 * yields its coordinates to the caller. This is the in-window MVP: we render
 * a DOM overlay across `document.body` rather than spawning a dedicated
 * always-on-top Tauri window. Limitations vs a transparent OS window:
 *
 *   - the selection is constrained to the application's viewport (cannot
 *     capture across other apps),
 *   - browser scrollbars are visible during selection.
 *
 * The full OS-wide implementation will land in a follow-up alongside a
 * `screenshot://overlay` Tauri window. The interface stays the same so
 * swapping is mechanical.
 *
 * The actual screen capture is delegated to the parent via `onSelect` —
 * this component is purely about geometry input, not about invoking
 * `images.captureScreen`.
 */
export function ScreenshotRegion({ onSelect, onCancel }: ScreenshotRegionProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);

  // ── Lifecycle: lock cursor + body scroll while picker is active ────
  useEffect(() => {
    const previousCursor = document.body.style.cursor;
    const previousOverflow = document.body.style.overflow;
    document.body.style.cursor = "crosshair";
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // ── Keyboard: Esc cancels ──────────────────────────────────────────
  // CAPTURE phase + stopPropagation: the previously-focused xterm textarea
  // otherwise receives the key FIRST and forwards the raw ESC byte to the
  // shell (PSReadLine interprets a stray ESC as "clear the input line" —
  // user-visible input corruption while the overlay is up).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [onCancel]);

  // Steal focus from the terminal while the overlay is up so plain typing
  // can't reach the shell either, and hand it back on unmount (Modal-style)
  // so the user keeps typing where they were after capture/cancel.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    overlayRef.current?.focus();
    return () => {
      opener?.focus?.();
    };
  }, []);

  // ── Pointer events on the overlay ─────────────────────────────────
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) {
      // Anything other than left-click → bail. Right-click is the natural
      // "cancel" gesture for selection overlays.
      onCancel();
      return;
    }
    startRef.current = { x: e.clientX, y: e.clientY };
    setRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
    overlayRef.current?.setPointerCapture(e.pointerId);
  }, [onCancel]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (!start) return;
    setRect(normaliseRect(start.x, start.y, e.clientX, e.clientY));
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    startRef.current = null;
    overlayRef.current?.releasePointerCapture?.(e.pointerId);
    if (!start) {
      onCancel();
      return;
    }
    const final = normaliseRect(start.x, start.y, e.clientX, e.clientY);
    if (final.w < MIN_REGION_PX || final.h < MIN_REGION_PX) {
      onCancel();
      return;
    }
    // Apply DPR so the backend receives physical pixels — the OS-level
    // capture APIs (xcap, etc.) work in physical coords.
    const dpr = typeof window !== "undefined" && window.devicePixelRatio
      ? window.devicePixelRatio
      : 1;
    onSelect({
      kind: "region",
      x: Math.round(final.x * dpr),
      y: Math.round(final.y * dpr),
      w: Math.round(final.w * dpr),
      h: Math.round(final.h * dpr),
    });
  }, [onCancel, onSelect]);

  return (
    <div
      ref={overlayRef}
      role="region"
      aria-label="Screenshot region picker"
      tabIndex={-1}
      className="fixed inset-0 z-[60] select-none outline-none"
      onContextMenu={(e) => {
        e.preventDefault();
        onCancel();
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        startRef.current = null;
        onCancel();
      }}
      style={{
        // Slightly tinted backdrop so the user sees the picker is active;
        // the selected rect is then cut out with `box-shadow` on the rect.
        backgroundColor: "rgba(0, 0, 0, 0.35)",
      }}
    >
      {rect && rect.w > 0 && rect.h > 0 ? (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute border-2 border-accent shadow-[0_0_0_99999px_rgba(0,0,0,0.55)]"
            style={{
              left: `${rect.x}px`,
              top: `${rect.y}px`,
              width: `${rect.w}px`,
              height: `${rect.h}px`,
            }}
          />
          <div
            aria-live="polite"
            className="pointer-events-none absolute rounded bg-accent px-2 py-0.5 font-mono text-[11px] text-black shadow-md"
            style={{
              left: `${Math.min(rect.x + rect.w + 6, window.innerWidth - 80)}px`,
              top: `${Math.max(rect.y - 22, 4)}px`,
            }}
          >
            {Math.round(rect.w)} × {Math.round(rect.h)}
          </div>
        </>
      ) : (
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-bg-elevated/85 px-4 py-2 font-mono text-xs text-zinc-300 shadow-xl backdrop-blur"
        >
          Drag to capture a region · Esc to cancel
        </div>
      )}
    </div>
  );
}

// ────────── Helpers ───────────────────────────────────────────────────

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Normalise a 2-point rect so width / height are always positive. */
function normaliseRect(x1: number, y1: number, x2: number, y2: number): Rect {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  return { x, y, w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

export default ScreenshotRegion;
