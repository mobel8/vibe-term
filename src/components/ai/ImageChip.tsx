import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

import { images, type ImageMeta } from "@/ipc";

interface ImageChipProps {
  imageId: string;
  /** Optional click handler — defaults to copying the id to the clipboard. */
  onClick?: (imageId: string) => void;
  /** Show the trailing × affordance (only in the staging tray). */
  onRemove?: (imageId: string) => void;
  /** Override the chip label (defaults to the imageId itself). */
  label?: string;
  /** Compact variant used inside the prompt textarea hint row. */
  size?: "sm" | "md";
}

/**
 * Pill that represents an `img_xxxx` reference. Inside the conversation
 * history it shows the id and a tiny thumbnail; clicking copies the id to
 * the clipboard so it can be re-used in a follow-up message.
 *
 * Resolves the underlying ImageMeta asynchronously through the IPC bridge so
 * we never block the markdown renderer on a Tauri round-trip.
 */
export function ImageChip({
  imageId,
  onClick,
  onRemove,
  label,
  size = "md",
}: ImageChipProps) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [meta, setMeta] = useState<ImageMeta | null>(null);
  const [flashing, setFlashing] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    let active = true;

    images
      .get(imageId)
      .then(async (m) => {
        if (!active || !m) return;
        setMeta(m);
        try {
          const data = await images.getBase64(imageId);
          if (!active) return;
          setThumb(`data:${m.mime};base64,${data}`);
        } catch {
          // best-effort thumbnail; chip still renders without it.
        }
      })
      .catch(() => {
        /* unknown id — keep showing the bare label */
      });

    return () => {
      active = false;
      cancelledRef.current = true;
    };
  }, [imageId]);

  const handleClick = async () => {
    if (onClick) {
      onClick(imageId);
    } else {
      try {
        await navigator.clipboard.writeText(imageId);
      } catch {
        // navigator.clipboard can throw in non-secure contexts; we silently
        // skip since the chip is informative and not critical.
      }
    }
    setFlashing(true);
    window.setTimeout(() => setFlashing(false), 350);
  };

  const tooltip = meta
    ? `${imageId} · ${meta.width}×${meta.height} · ${(meta.bytes / 1024).toFixed(1)} KB`
    : imageId;

  return (
    <span
      className={clsx(
        "inline-flex max-w-full items-center gap-1 rounded-md border border-accent-subtle/60 bg-accent-subtle/20 align-middle font-mono text-accent transition-colors",
        size === "sm" ? "px-1.5 py-0 text-[10px]" : "px-2 py-0.5 text-xs",
        flashing && "ring-1 ring-accent",
      )}
      title={tooltip}
    >
      <button
        type="button"
        onClick={handleClick}
        className={clsx(
          "flex items-center gap-1.5 outline-none focus-visible:ring-1 focus-visible:ring-accent rounded-sm",
          flashing ? "text-zinc-100" : "hover:text-zinc-100",
        )}
        aria-label={`copy ${imageId}`}
      >
        {thumb ? (
          <span
            aria-hidden="true"
            className={clsx(
              "shrink-0 rounded-sm border border-border bg-cover bg-center",
              size === "sm" ? "h-3.5 w-3.5" : "h-5 w-5",
            )}
            style={{ backgroundImage: `url(${thumb})` }}
          />
        ) : (
          <span
            aria-hidden="true"
            className={clsx(
              "shrink-0 animate-pulse rounded-sm bg-zinc-700",
              size === "sm" ? "h-3.5 w-3.5" : "h-5 w-5",
            )}
          />
        )}
        <span className="truncate">{label ?? imageId}</span>
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(imageId);
          }}
          className="ml-0.5 rounded-sm text-zinc-500 hover:bg-bg-elevated hover:text-zinc-200"
          aria-label={`remove ${imageId}`}
        >
          ×
        </button>
      )}
    </span>
  );
}
