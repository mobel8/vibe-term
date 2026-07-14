import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import clsx from "clsx";

import { images, type ImageMeta } from "@/ipc";
import { useImageStore } from "@/state/imageStore";
import {
  copyImageId,
  deleteImage,
  ocrAndCopy,
  saveImageAs,
} from "@/lib/image-actions";

interface LightboxProps {
  /** Optional ordered list of ids the user can navigate through with ← / →.
   * When omitted, navigation is disabled and only the active image shows. */
  orderedIds?: readonly string[];
  /** Wired by the caller when an aiStore is available — enables Send-to-AI. */
  onSendToAi?: (imageId: string) => void;
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.15; // 15% per wheel tick

/**
 * Full-screen modal viewer. Subscribes to `useImageStore.lightboxId` — there
 * is at most one instance mounted (App-level) and consumers open/close it by
 * mutating that piece of state.
 *
 * Interaction matrix:
 *   - wheel       → zoom in/out around the cursor
 *   - pointer drag → pan when zoomed in
 *   - dbl-click   → reset zoom + pan
 *   - Esc         → close
 *   - ← / →       → navigate (only when `orderedIds` provided & length > 1)
 *   - +/-/0       → zoom in / out / reset
 *
 * Body scroll is locked while the modal is open so background scrollbars
 * don't twitch behind the backdrop.
 */
export function Lightbox({ orderedIds, onSendToAi }: LightboxProps) {
  const lightboxId = useImageStore((s) => s.lightboxId);
  const cached = useImageStore((s) => (lightboxId ? s.cache.get(lightboxId) ?? null : null));
  const hydrate = useImageStore((s) => s.hydrate);
  const setLightbox = useImageStore((s) => s.setLightbox);

  const [meta, setMeta] = useState<ImageMeta | null>(cached);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState<null | "ocr" | "save" | "delete">(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Reset transform whenever the active image changes.
  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setLoadError(null);
  }, [lightboxId]);

  // Auto-dismiss toasts.
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

  // Hydrate meta from cache, then fetch on miss.
  useEffect(() => {
    if (!lightboxId) {
      setMeta(null);
      return;
    }
    if (cached) {
      setMeta(cached);
      return;
    }
    let cancelled = false;
    images
      .get(lightboxId)
      .then((m) => {
        if (cancelled) return;
        if (!m) {
          setLoadError("image not found");
          return;
        }
        setMeta(m);
        hydrate(m);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "failed to load image");
      });
    return () => {
      cancelled = true;
    };
  }, [lightboxId, cached, hydrate]);

  const close = useCallback(() => setLightbox(null), [setLightbox]);

  const navIndex = useMemo(() => {
    if (!orderedIds || !lightboxId) return -1;
    return orderedIds.indexOf(lightboxId);
  }, [orderedIds, lightboxId]);

  const goPrev = useCallback(() => {
    if (!orderedIds || navIndex < 0) return;
    const prev = orderedIds[(navIndex - 1 + orderedIds.length) % orderedIds.length];
    if (prev) setLightbox(prev);
  }, [navIndex, orderedIds, setLightbox]);

  const goNext = useCallback(() => {
    if (!orderedIds || navIndex < 0) return;
    const next = orderedIds[(navIndex + 1) % orderedIds.length];
    if (next) setLightbox(next);
  }, [navIndex, orderedIds, setLightbox]);

  // ── Keyboard ───────────────────────────────────────────────────────
  // CAPTURE phase + stopPropagation on every handled key: without it, the
  // still-focused xterm textarea receives the key FIRST and the raw bytes
  // (ESC, arrow CSI sequences, +/-/0 characters) leak into the shell while
  // the lightbox is up — stray characters typed into the user's prompt.
  useEffect(() => {
    if (!lightboxId) return;
    const handler = (e: KeyboardEvent) => {
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      switch (e.key) {
        case "Escape":
          consume();
          close();
          break;
        case "ArrowLeft":
          if (orderedIds && orderedIds.length > 1) {
            consume();
            goPrev();
          }
          break;
        case "ArrowRight":
          if (orderedIds && orderedIds.length > 1) {
            consume();
            goNext();
          }
          break;
        case "+":
        case "=":
          consume();
          setZoom((z) => clamp(z + ZOOM_STEP * 2, ZOOM_MIN, ZOOM_MAX));
          break;
        case "-":
        case "_":
          consume();
          setZoom((z) => {
            const next = clamp(z - ZOOM_STEP * 2, ZOOM_MIN, ZOOM_MAX);
            if (next <= 1) setOffset({ x: 0, y: 0 });
            return next;
          });
          break;
        case "0":
          consume();
          setZoom(1);
          setOffset({ x: 0, y: 0 });
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [lightboxId, close, goNext, goPrev, orderedIds]);

  // ── Body scroll lock ──────────────────────────────────────────────
  useEffect(() => {
    if (!lightboxId) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [lightboxId]);

  // ── Wheel zoom (cursor-anchored) ──────────────────────────────────
  const onWheel = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      const direction = e.deltaY < 0 ? 1 : -1;
      const factor = 1 + direction * ZOOM_STEP;
      setZoom((current) => {
        const next = clamp(current * factor, ZOOM_MIN, ZOOM_MAX);
        // Pan is disabled at zoom <= 1, so snap the offset back to origin
        // to avoid leaving the image stuck off-center.
        if (next <= 1) setOffset({ x: 0, y: 0 });
        return next;
      });
    },
    [],
  );

  // ── Pointer pan ────────────────────────────────────────────────────
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (zoom <= 1) return;
      dragRef.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    [offset.x, offset.y, zoom],
  );
  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      setOffset({
        x: e.clientX - dragRef.current.x,
        y: e.clientY - dragRef.current.y,
      });
    },
    [],
  );
  const onPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  // ── Action callbacks ───────────────────────────────────────────────
  const handleCopyId = useCallback(async () => {
    if (!meta) return;
    try {
      await copyImageId(meta.id);
      setToast(`copied ${meta.id}`);
    } catch {
      setToast("copy failed");
    }
  }, [meta]);

  const handleSave = useCallback(async () => {
    if (!meta || busy) return;
    setBusy("save");
    try {
      const path = await saveImageAs(meta);
      setToast(path ? `saved to ${truncatePath(path)}` : "save cancelled");
    } catch (err) {
      setToast(err instanceof Error ? `save failed: ${err.message}` : "save failed");
    } finally {
      setBusy(null);
    }
  }, [busy, meta]);

  const handleOcr = useCallback(async () => {
    if (!meta || busy) return;
    setBusy("ocr");
    try {
      const text = await ocrAndCopy(meta.id);
      setToast(text.length === 0 ? "no text detected" : `OCR copied (${text.length} chars)`);
    } catch (err) {
      setToast(err instanceof Error ? `OCR failed: ${err.message}` : "OCR failed");
    } finally {
      setBusy(null);
    }
  }, [busy, meta]);

  const handleDelete = useCallback(async () => {
    if (!meta || busy) return;
    setBusy("delete");
    try {
      await deleteImage(meta.id, useImageStore.getState());
      close();
    } catch (err) {
      setToast(err instanceof Error ? `delete failed: ${err.message}` : "delete failed");
      setBusy(null);
    }
  }, [busy, close, meta]);

  const handleAi = useCallback(() => {
    if (!meta || !onSendToAi) return;
    onSendToAi(meta.id);
    setToast("sent to AI");
  }, [meta, onSendToAi]);

  if (!lightboxId) return null;

  const src = meta ? safeAssetSrc(meta.path) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={meta ? `Image ${meta.id}` : "Image viewer"}
      tabIndex={-1}
      // Steal focus from the terminal while open so plain typing can't leak
      // into the shell underneath (same guard as ScreenshotRegion/Modal); the
      // ref callback's cleanup returns focus to the opener on unmount.
      ref={(el) => {
        if (!el) return;
        const opener = document.activeElement as HTMLElement | null;
        el.focus();
        return () => opener?.focus?.();
      }}
      className="fixed inset-0 z-50 flex flex-col bg-black/85 outline-none backdrop-blur-sm"
      onClick={(e) => {
        // Click on the backdrop dismisses; clicks bubbling up from the
        // content stop on their own buttons / handlers.
        if (e.target === e.currentTarget) close();
      }}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 px-4 py-2 text-xs text-zinc-300">
        <div className="flex items-center gap-3 font-mono">
          <button
            type="button"
            className="rounded border border-border bg-bg-elevated/80 px-2 py-1 text-accent hover:text-zinc-100"
            onClick={handleCopyId}
            title="Copy id"
          >
            {meta?.id ?? lightboxId}
          </button>
          {meta && (
            <span className="text-zinc-400">
              {meta.width}×{meta.height} · {(meta.bytes / 1024).toFixed(1)} KB · {meta.source}
            </span>
          )}
          {orderedIds && orderedIds.length > 1 && navIndex >= 0 && (
            <span className="text-zinc-500">
              {navIndex + 1} / {orderedIds.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <ActionBtn label="Save" busy={busy === "save"} onClick={handleSave} />
          <ActionBtn label="OCR" busy={busy === "ocr"} onClick={handleOcr} />
          <ActionBtn label="Send to AI" disabled={!onSendToAi} onClick={handleAi} />
          <ActionBtn label="Delete" variant="danger" busy={busy === "delete"} onClick={handleDelete} />
          <button
            type="button"
            onClick={close}
            aria-label="Close lightbox"
            className="ml-1 rounded border border-border bg-bg-elevated/80 px-2 py-1 text-zinc-300 hover:border-accent hover:text-accent"
          >
            ×
          </button>
        </div>
      </div>

      {/* Viewport */}
      <div
        ref={viewportRef}
        className="relative flex-1 overflow-hidden"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => {
          setZoom(1);
          setOffset({ x: 0, y: 0 });
        }}
        style={{ cursor: zoom > 1 ? (dragRef.current ? "grabbing" : "grab") : "zoom-in" }}
      >
        {orderedIds && orderedIds.length > 1 && (
          <>
            <NavArrow direction="left" onClick={goPrev} />
            <NavArrow direction="right" onClick={goNext} />
          </>
        )}
        {loadError ? (
          <div
            role="alert"
            className="absolute inset-0 flex items-center justify-center text-sm text-zinc-400"
          >
            {loadError}
          </div>
        ) : src && meta ? (
          <img
            src={src}
            alt={meta.ocrText?.slice(0, 200) || meta.id}
            draggable={false}
            className="absolute left-1/2 top-1/2 max-h-full max-w-full select-none object-contain"
            style={{
              transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
              transformOrigin: "center center",
              transition: dragRef.current ? "none" : "transform 80ms ease-out",
            }}
            onError={() => setToast("failed to decode image")}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-500">
            loading…
          </div>
        )}
      </div>

      {/* Footer — zoom control */}
      <div className="flex items-center justify-center gap-3 border-t border-border-muted bg-black/40 px-4 py-2 text-[11px] font-mono text-zinc-400">
        <button
          type="button"
          onClick={() =>
            setZoom((z) => {
              const next = clamp(z - ZOOM_STEP * 2, ZOOM_MIN, ZOOM_MAX);
              if (next <= 1) setOffset({ x: 0, y: 0 });
              return next;
            })
          }
          className="rounded px-2 py-0.5 hover:bg-bg-elevated hover:text-zinc-100"
          aria-label="Zoom out"
        >
          −
        </button>
        <span className="w-12 text-center text-zinc-300">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          onClick={() => setZoom((z) => clamp(z + ZOOM_STEP * 2, ZOOM_MIN, ZOOM_MAX))}
          className="rounded px-2 py-0.5 hover:bg-bg-elevated hover:text-zinc-100"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(1);
            setOffset({ x: 0, y: 0 });
          }}
          className="rounded px-2 py-0.5 hover:bg-bg-elevated hover:text-zinc-100"
        >
          reset
        </button>
        <span className="ml-4 text-zinc-600">
          esc · ← → · wheel / +– · drag · dbl-click
        </span>
      </div>

      {toast && (
        <div
          role="status"
          className="pointer-events-none absolute left-1/2 top-14 -translate-x-1/2 rounded border border-border bg-bg-elevated/95 px-3 py-1 font-mono text-xs text-accent shadow-lg"
        >
          {toast}
        </div>
      )}
    </div>
  );
}

// ────────── Sub-components ─────────────────────────────────────────────

interface ActionBtnProps {
  label: string;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  variant?: "default" | "danger";
}
function ActionBtn({ label, onClick, busy, disabled, variant = "default" }: ActionBtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={clsx(
        "rounded border px-2 py-1 font-mono text-[11px] transition-colors",
        "border-border bg-bg-elevated/80 text-zinc-200",
        "hover:border-accent hover:text-accent",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-zinc-200",
        variant === "danger" && "hover:border-red-500 hover:text-red-400",
        busy && "animate-pulse",
      )}
    >
      {label}
    </button>
  );
}

function NavArrow({ direction, onClick }: { direction: "left" | "right"; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={direction === "left" ? "Previous image" : "Next image"}
      className={clsx(
        "absolute top-1/2 z-10 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-black/40 text-zinc-200 backdrop-blur-sm transition-all hover:border-accent hover:bg-bg-elevated hover:text-accent",
        direction === "left" ? "left-4" : "right-4",
      )}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-5 w-5"
        aria-hidden
        style={{ transform: direction === "right" ? "rotate(180deg)" : undefined }}
      >
        <path d="M15 18l-6-6 6-6" />
      </svg>
    </button>
  );
}

// ────────── Helpers ───────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function safeAssetSrc(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return `file://${path}`;
  }
}

function truncatePath(p: string): string {
  if (p.length <= 48) return p;
  return `…${p.slice(-44)}`;
}

export default Lightbox;
