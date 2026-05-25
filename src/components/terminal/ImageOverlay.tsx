import { useEffect, useState } from "react";

import { images } from "@/ipc";
import type { ImageMeta } from "@/ipc";

interface ImageOverlayProps {
  image: ImageMeta;
  onDismiss?: () => void;
}

/**
 * Placeholder overlay shown above the terminal viewport when an inline image is
 * staged in the current tab. The full decoration API plumbing lands in Phase 4
 * (`@xterm/addon-image` integration + xterm marker positioning). For now this
 * just confirms the image round-trip works: we fetch the base64 payload via
 * IPC and render a thumbnail with the short id badge.
 */
export function ImageOverlay({ image, onDismiss }: ImageOverlayProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    images
      .getBase64(image.id)
      .then((b64) => {
        if (cancelled) return;
        setDataUrl(`data:${image.mime};base64,${b64}`);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [image.id, image.mime]);

  return (
    <div className="pointer-events-auto absolute right-4 top-4 z-10 flex max-w-xs flex-col gap-2 rounded-lg border border-border bg-bg-elevated/95 p-3 shadow-xl backdrop-blur-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-accent">{image.id}</span>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="text-xs text-zinc-400 hover:text-zinc-100"
            aria-label="Dismiss image preview"
          >
            ×
          </button>
        )}
      </div>
      {error ? (
        <div className="text-xs text-red-400">failed to load: {error}</div>
      ) : dataUrl ? (
        <img
          src={dataUrl}
          alt={`${image.id} (${image.width}×${image.height})`}
          className="max-h-40 rounded border border-border-muted object-contain"
        />
      ) : (
        <div className="h-24 animate-pulse rounded bg-bg-muted" />
      )}
      <div className="font-mono text-[10px] leading-snug text-zinc-500">
        {image.width}×{image.height} · {(image.bytes / 1024).toFixed(1)} KB ·{" "}
        {image.source}
      </div>
    </div>
  );
}
