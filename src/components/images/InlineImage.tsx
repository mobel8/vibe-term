import { memo, useCallback, useEffect, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import clsx from "clsx";

import { images, type ImageMeta } from "@/ipc";
import { useImageStore } from "@/state/imageStore";
import {
  copyImageId,
  deleteImage,
  ocrAndCopy,
} from "@/lib/image-actions";

interface InlineImageProps {
  imageId: string;
  /** Optional: when set, clicking "Send to AI" calls this instead of being
   * disabled. Wired by parents that have access to `aiStore.stageImage`. */
  onSendToAi?: (imageId: string) => void;
  /** Width override for layouts that want narrower thumbs (default 480). */
  maxWidthPx?: number;
}

/**
 * The hero image surface inside the terminal flow. Renders a thumbnail with
 * the `img_xxxx` badge plus a hover-revealed toolbar (copy id, expand to
 * lightbox, send to AI, OCR, delete). Lazy-fetches its own meta when the
 * store cache misses, then keeps it warm via the Zustand subscription so
 * sibling components share the same payload.
 *
 * The image source is resolved with `convertFileSrc` so the WebView serves
 * the file through the `asset:` protocol instead of paying a base64 round
 * trip — much faster for 1080p paste/screenshots. The Tauri capability
 * `core:asset:allow` must list the images directory (configured in
 * `tauri.conf.json` by Agent J).
 */
function InlineImageImpl({
  imageId,
  onSendToAi,
  maxWidthPx = 480,
}: InlineImageProps) {
  const cached = useImageStore((s) => s.cache.get(imageId) ?? null);
  const hydrate = useImageStore((s) => s.hydrate);
  const setLightbox = useImageStore((s) => s.setLightbox);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "ocr" | "delete">(null);
  const [toast, setToast] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [naturalLoaded, setNaturalLoaded] = useState(false);

  // ── Hydrate from backend on cache miss ──────────────────────────────
  useEffect(() => {
    if (cached || deleted) return;
    let cancelled = false;
    images
      .get(imageId)
      .then((meta) => {
        if (cancelled) return;
        if (!meta) {
          setLoadError("not found");
          return;
        }
        hydrate(meta);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [cached, deleted, hydrate, imageId]);

  // ── Auto-dismiss the inline toast ──────────────────────────────────
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const handleCopyId = useCallback(async () => {
    try {
      await copyImageId(imageId);
      setToast(`copied ${imageId}`);
    } catch (err) {
      setToast(err instanceof Error ? `copy failed: ${err.message}` : "copy failed");
    }
  }, [imageId]);

  const handleExpand = useCallback(() => {
    setLightbox(imageId);
  }, [imageId, setLightbox]);

  const handleSendToAi = useCallback(() => {
    onSendToAi?.(imageId);
    setToast("sent to AI");
  }, [imageId, onSendToAi]);

  const handleOcr = useCallback(async () => {
    if (busy) return;
    setBusy("ocr");
    try {
      const text = await ocrAndCopy(imageId);
      setToast(text.length === 0 ? "no text detected" : `OCR copied (${text.length} chars)`);
    } catch (err) {
      setToast(err instanceof Error ? `OCR failed: ${err.message}` : "OCR failed");
    } finally {
      setBusy(null);
    }
  }, [busy, imageId]);

  const handleDelete = useCallback(async () => {
    if (busy) return;
    setBusy("delete");
    try {
      await deleteImage(imageId, useImageStore.getState());
      setDeleted(true);
    } catch (err) {
      setToast(err instanceof Error ? `delete failed: ${err.message}` : "delete failed");
      setBusy(null);
    }
  }, [busy, imageId]);

  // ── Render branches ────────────────────────────────────────────────
  if (deleted) {
    return (
      <div className="my-2 inline-block rounded border border-border-muted bg-bg-subtle px-3 py-1 font-mono text-xs text-zinc-500">
        {imageId} deleted
      </div>
    );
  }

  if (loadError) {
    return (
      <div
        role="alert"
        className="my-2 inline-block rounded border border-red-500/40 bg-red-500/10 px-3 py-1 font-mono text-xs text-red-300"
      >
        {imageId}: {loadError}
      </div>
    );
  }

  if (!cached) {
    return (
      <div
        className="my-2 flex items-center gap-2 rounded border border-border bg-bg-subtle px-3 py-2 font-mono text-xs text-zinc-500"
        aria-busy="true"
      >
        <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden />
        loading {imageId}…
      </div>
    );
  }

  const src = makeAssetSrc(cached);

  return (
    <figure
      className="vibe-inline-image group relative my-2 inline-block max-w-full overflow-hidden rounded-lg border border-border bg-bg-subtle shadow-sm transition-shadow hover:shadow-lg"
      style={{ maxWidth: `${maxWidthPx}px` }}
      data-image-id={cached.id}
    >
      <button
        type="button"
        onClick={handleExpand}
        className="block w-full cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-label={`Open ${cached.id} in lightbox`}
      >
        <img
          src={src}
          alt={cached.ocrText?.slice(0, 200) || cached.id}
          width={cached.width}
          height={cached.height}
          loading="lazy"
          decoding="async"
          onLoad={() => setNaturalLoaded(true)}
          onError={() => setLoadError("failed to decode image")}
          className={clsx(
            "block h-auto w-full bg-bg-muted object-contain transition-opacity",
            naturalLoaded ? "opacity-100" : "opacity-0",
          )}
          style={{ aspectRatio: `${cached.width} / ${cached.height}` }}
        />
      </button>

      {/* Bottom badge — click to copy id */}
      <button
        type="button"
        onClick={handleCopyId}
        className="absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] leading-snug text-accent backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-zinc-100"
        aria-label={`Copy ${cached.id} to clipboard`}
      >
        {cached.id}
      </button>

      {/* Hover toolbar */}
      <div className="pointer-events-none absolute right-1.5 top-1.5 flex translate-y-[-4px] gap-1 opacity-0 transition-all duration-150 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100">
        <ToolbarButton label="Copy id" onClick={handleCopyId} icon={IconCopy} />
        <ToolbarButton label="Expand" onClick={handleExpand} icon={IconExpand} />
        <ToolbarButton
          label="Send to AI"
          onClick={handleSendToAi}
          disabled={!onSendToAi}
          icon={IconSparkles}
        />
        <ToolbarButton
          label="OCR & copy"
          onClick={handleOcr}
          disabled={busy === "ocr"}
          icon={IconText}
          busy={busy === "ocr"}
        />
        <ToolbarButton
          label="Delete"
          onClick={handleDelete}
          disabled={busy === "delete"}
          icon={IconTrash}
          busy={busy === "delete"}
          variant="danger"
        />
      </div>

      {/* Toast — inline so we don't depend on a global notif system */}
      {toast && (
        <div
          className="pointer-events-none absolute inset-x-1.5 bottom-8 rounded bg-black/75 px-2 py-1 text-center font-mono text-[10px] text-zinc-100 backdrop-blur-sm"
          role="status"
        >
          {toast}
        </div>
      )}

      <figcaption className="sr-only">
        {cached.id} — {cached.width}×{cached.height} ({(cached.bytes / 1024).toFixed(1)} KB,{" "}
        {cached.source})
      </figcaption>
    </figure>
  );
}

// ────────── Toolbar primitives ───────────────────────────────────────

interface ToolbarButtonProps {
  label: string;
  onClick: () => void;
  icon: (props: { className?: string }) => ReactNode;
  disabled?: boolean;
  busy?: boolean;
  variant?: "default" | "danger";
}

function ToolbarButton({
  label,
  onClick,
  icon: Icon,
  disabled,
  busy,
  variant = "default",
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={clsx(
        "pointer-events-auto flex h-7 w-7 items-center justify-center rounded-md border backdrop-blur-sm transition-all",
        "border-border bg-bg-elevated/90 text-zinc-200 hover:border-accent hover:text-accent",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-zinc-200",
        variant === "danger" && "hover:border-red-500 hover:text-red-400",
        busy && "animate-pulse",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

// ────────── Inline SVG icons (no extra dep) ───────────────────────────

function IconCopy({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden>
      <rect x="5" y="5" width="8" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-5A1.5 1.5 0 0 0 3 3.5v7A1.5 1.5 0 0 0 4.5 12H5" />
    </svg>
  );
}
function IconExpand({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={className} aria-hidden>
      <path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" />
    </svg>
  );
}
function IconSparkles({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 1.5l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3zM12.5 9l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6.6-1.6z" />
    </svg>
  );
}
function IconText({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={className} aria-hidden>
      <path d="M4 4h8M8 4v8M5 12h6" />
    </svg>
  );
}
function IconTrash({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M3 4.5h10M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5 4.5l.5 8a1.5 1.5 0 0 0 1.5 1.4h3a1.5 1.5 0 0 0 1.5-1.4l.5-8" />
    </svg>
  );
}

// ────────── Helpers ───────────────────────────────────────────────────

/**
 * Build an `<img src>` for an `ImageMeta`. We prefer the Tauri asset:// scheme
 * because it streams the raw bytes without a base64 round trip and reuses the
 * WebView's image cache. If `convertFileSrc` throws (e.g. tests without the
 * Tauri runtime) we synthesise a sensible fallback that won't crash render.
 */
function makeAssetSrc(meta: ImageMeta): string {
  try {
    return convertFileSrc(meta.path);
  } catch {
    return `file://${meta.path}`;
  }
}

export const InlineImage = memo(InlineImageImpl);
export default InlineImage;
