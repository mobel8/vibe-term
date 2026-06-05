import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import clsx from "clsx";

import { images, type ImageMeta } from "@/ipc";
import { useImageStore } from "@/state/imageStore";
import { useTerminalStore } from "@/state/terminalStore";
import { copyImageToClipboard, deleteImage } from "@/lib/image-actions";
import { insertImageIntoTerminal } from "@/lib/image-insert";
import { toast } from "@/state/toastStore";

interface ImageGalleryProps {
  /** Collapse the panel (the retract control). */
  onClose: () => void;
}

// Bound the number of thumbnails we mount at once. `loading="lazy"` already
// defers off-screen decodes, but capping keeps the DOM + memory sane when a
// user has hundreds of screenshots on disk.
const MAX_THUMBS = 200;

// Width is persisted at module scope so it survives the panel being collapsed
// and re-opened within a session (the component unmounts on collapse).
const MIN_WIDTH = 200;
const MAX_WIDTH = 620;
let savedWidth = 300;

// Movement (px) past which a press becomes a drag rather than a click.
const DRAG_THRESHOLD = 6;

/**
 * Retractable, resizable right-side panel recapping every screenshot / pasted /
 * dropped image. Sourced from `useImageStore.cache` — hydrated live by the
 * global `image://added` listener (Layout) AND seeded once on mount from
 * `images.listAll()` (the on-disk sidecars) so images from previous sessions
 * show up too. (`db_image_list` is intentionally NOT used: its writer is only
 * exercised by Rust tests, so it's empty in production.)
 *
 * Per thumbnail:
 *   - drag onto a terminal pane → insert a functional `@path` mention there
 *     (SSH-aware, identical to the clipboard-paste flow). Implemented with mouse
 *     events, NOT HTML5 DnD, because Tauri's `dragDropEnabled` swallows native
 *     drag-drop inside the webview on Windows.
 *   - click → copy the real PNG bytes to the clipboard for a manual paste.
 *   - ↵ → insert into the ACTIVE pane.  ⤢ → lightbox.  ✕ → delete.
 *
 * The panel width is drag-resizable via the handle on its left edge.
 */
export function ImageGallery({ onClose }: ImageGalleryProps) {
  const cache = useImageStore((s) => s.cache);
  const setLightbox = useImageStore((s) => s.setLightbox);
  const hydrateMany = useImageStore((s) => s.hydrateMany);

  const [width, setWidth] = useState(savedWidth);

  // Seed once from disk so previously-captured images appear immediately.
  useEffect(() => {
    let cancelled = false;
    images
      .listAll()
      .then((rows) => {
        if (!cancelled && rows.length) hydrateMany(rows);
      })
      .catch((err: unknown) => {
        console.warn("[gallery] listAll failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [hydrateMany]);

  const items = useMemo(
    () =>
      Array.from(cache.values())
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_THUMBS),
    [cache],
  );

  // ── Drag-to-resize (handle on the left edge) ────────────────────────
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const onResizeMove = useCallback((e: MouseEvent) => {
    const start = dragRef.current;
    if (!start) return;
    // Panel sits on the RIGHT, so dragging the handle left (clientX decreasing)
    // widens it.
    const next = Math.min(
      MAX_WIDTH,
      Math.max(MIN_WIDTH, start.startWidth - (e.clientX - start.startX)),
    );
    savedWidth = next;
    setWidth(next);
  }, []);
  const stopResize = useCallback(() => {
    dragRef.current = null;
    document.removeEventListener("mousemove", onResizeMove);
    document.removeEventListener("mouseup", stopResize);
    document.body.style.userSelect = "";
  }, [onResizeMove]);
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: width };
    document.addEventListener("mousemove", onResizeMove);
    document.addEventListener("mouseup", stopResize);
    document.body.style.userSelect = "none";
  };
  useEffect(() => () => stopResize(), [stopResize]);

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-l border-border bg-bg text-zinc-100"
      style={{ width, minWidth: MIN_WIDTH, maxWidth: MAX_WIDTH }}
      aria-label="Image gallery"
      data-testid="image-gallery"
    >
      {/* resize handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={startResize}
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-accent/30"
        title="Drag to resize"
      />

      <header className="flex items-center justify-between gap-2 border-b border-border bg-bg-subtle px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-semibold text-accent">
            Images
          </span>
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">
            {items.length}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-sm text-zinc-400 hover:bg-bg-muted hover:text-zinc-100"
          title="Collapse gallery (Ctrl+Shift+G)"
          aria-label="Collapse image gallery"
        >
          ×
        </button>
      </header>

      {items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center text-xs text-zinc-500">
          <div className="font-medium text-zinc-300">No images yet</div>
          <div>Paste (Ctrl+V) or screenshot one — it lands here.</div>
        </div>
      ) : (
        <div className="grid flex-1 auto-rows-min grid-cols-2 gap-2 overflow-y-auto p-2">
          {items.map((meta) => (
            <GalleryThumb
              key={meta.id}
              meta={meta}
              onExpand={() => setLightbox(meta.id)}
            />
          ))}
        </div>
      )}

      <footer className="border-t border-border bg-bg-subtle px-3 py-1.5 text-center font-mono text-[10px] leading-tight text-zinc-500">
        Drag → terminal · Click → clipboard
      </footer>
    </aside>
  );
}

// ────────── Thumbnail ─────────────────────────────────────────────────

interface GalleryThumbProps {
  meta: ImageMeta;
  onExpand: () => void;
}

function GalleryThumb({ meta, onExpand }: GalleryThumbProps) {
  const [src, setSrc] = useState<string>(() => assetSrc(meta.path));
  const [gone, setGone] = useState(false);
  // If the asset:// load fails (e.g. asset-scope misconfig), fall back ONCE to a
  // base64 data URL via IPC so the thumbnail always renders.
  const triedB64 = useRef(false);
  const srcRef = useRef(src);
  srcRef.current = src;

  const onImgError = () => {
    if (triedB64.current) {
      setSrc("");
      return;
    }
    triedB64.current = true;
    void images
      .getBase64(meta.id)
      .then((b64) => setSrc(`data:${meta.mime};base64,${b64}`))
      .catch(() => setSrc(""));
  };

  const onCopy = useCallback(() => {
    void copyImageToClipboard(meta.id)
      .then(() => toast.success(`${meta.id} copied — paste anywhere`))
      .catch((err: unknown) =>
        toast.error(err instanceof Error ? err.message : "Copy failed"),
      );
  }, [meta.id]);

  // ── Mouse-driven drag (NOT HTML5 DnD — see component docstring) ──────
  // A press that moves past the threshold becomes a drag: we float a ghost of
  // the thumbnail under the cursor and, on release over a terminal pane, insert
  // the image's @path there. A press that doesn't move is treated as a click
  // (copy to clipboard).
  //
  // Teardown (remove listeners, drop the ghost, reset body styles, clear the
  // pane highlight) is stashed in a ref so a mid-drag unmount — e.g. toggling
  // the gallery via the global Ctrl+Shift+G while pressed — runs it too. The
  // happy-path drop runs the identical teardown via `up`.
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;
      let ghost: HTMLImageElement | null = null;

      const move = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
          dragging = true;
          document.body.style.userSelect = "none";
          document.body.style.cursor = "grabbing";
          ghost = document.createElement("img");
          ghost.src = srcRef.current;
          ghost.style.cssText =
            "position:fixed;z-index:9999;width:128px;height:auto;max-height:128px;object-fit:cover;opacity:.85;pointer-events:none;border-radius:8px;border:2px solid rgba(255,255,255,.3);box-shadow:0 8px 24px rgba(0,0,0,.55)";
          document.body.appendChild(ghost);
        }
        if (dragging && ghost) {
          ghost.style.left = `${ev.clientX + 10}px`;
          ghost.style.top = `${ev.clientY + 10}px`;
          highlightPaneAt(ev.clientX, ev.clientY);
        }
      };

      // Idempotent teardown shared by the mouseup path and the unmount effect.
      const cleanup = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        if (ghost) ghost.remove();
        clearPaneHighlight();
      };

      const up = (ev: MouseEvent) => {
        cleanup();
        dragCleanupRef.current = null;
        if (!dragging) {
          onCopy();
          return;
        }
        const ptyId = panePtyIdAt(ev.clientX, ev.clientY);
        if (!ptyId) return; // dropped outside any terminal → no-op
        const tabId = tabIdAt(ev.clientX, ev.clientY);
        if (tabId) useTerminalStore.getState().attachImageToTab(tabId, meta);
        void insertImageIntoTerminal(ptyId, meta.path);
        toast.success(`${meta.id} → terminal`);
      };

      dragCleanupRef.current = cleanup;
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    },
    [meta, onCopy],
  );

  // If the thumb unmounts mid-drag (e.g. gallery toggled or thumb deleted),
  // `up` never fires — run the stashed teardown so listeners/ghost/body styles
  // don't leak. Mirrors the resize cleanup pattern above.
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const onInsert = () => {
    const ptyId = activePtyId();
    if (!ptyId) {
      toast.info("No active terminal");
      return;
    }
    const activeTab = useTerminalStore.getState().activeTabId;
    if (activeTab) useTerminalStore.getState().attachImageToTab(activeTab, meta);
    void insertImageIntoTerminal(ptyId, meta.path);
  };

  const onDelete = () => {
    void deleteImage(meta.id, useImageStore.getState())
      .then(() => setGone(true))
      .catch((err: unknown) =>
        toast.error(err instanceof Error ? err.message : "Delete failed"),
      );
  };

  if (gone) return null;

  return (
    <figure
      className="group relative aspect-square overflow-hidden rounded-md border border-border bg-bg-subtle"
      data-image-id={meta.id}
    >
      <img
        src={src}
        alt={meta.ocrText?.slice(0, 80) || meta.id}
        title={`${meta.id} — ${meta.width}×${meta.height} · drag to a terminal, click to copy`}
        loading="lazy"
        decoding="async"
        draggable={false}
        onMouseDown={onMouseDown}
        onError={onImgError}
        className="h-full w-full cursor-grab select-none bg-bg-muted object-cover transition-opacity active:cursor-grabbing"
      />

      {/* id badge */}
      <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/60 px-1 py-0.5 font-mono text-[9px] leading-none text-accent backdrop-blur-sm">
        {meta.id.replace(/^img_/, "")}
      </span>

      {/* hover toolbar */}
      <div className="pointer-events-none absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <ThumbButton label="Insert into active terminal" onClick={onInsert}>
          ↵
        </ThumbButton>
        <ThumbButton label="Expand" onClick={onExpand}>
          ⤢
        </ThumbButton>
        <ThumbButton label="Delete" onClick={onDelete} variant="danger">
          ✕
        </ThumbButton>
      </div>
    </figure>
  );
}

interface ThumbButtonProps {
  label: string;
  onClick: () => void;
  variant?: "default" | "danger";
  children: React.ReactNode;
}

function ThumbButton({
  label,
  onClick,
  variant = "default",
  children,
}: ThumbButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={clsx(
        "pointer-events-auto flex h-5 w-5 items-center justify-center rounded border text-[10px] leading-none backdrop-blur-sm transition-colors",
        "border-border bg-bg-elevated/90 text-zinc-200 hover:border-accent hover:text-accent",
        variant === "danger" && "hover:border-red-500 hover:text-red-400",
      )}
    >
      {children}
    </button>
  );
}

// ────────── Helpers ──────────────────────────────────────────────────

function assetSrc(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return `file://${path}`;
  }
}

function activePtyId(): string | null {
  const state = useTerminalStore.getState();
  const id = state.activeTabId;
  if (!id) return null;
  return state.tabs.find((t) => t.id === id)?.ptyId ?? null;
}

/** Resolve the tab id of the terminal pane under a viewport point, if any. */
function tabIdAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  const pane = el?.closest<HTMLElement>("[data-tab-id]");
  return pane?.getAttribute("data-tab-id") ?? null;
}

/** Resolve the ptyId of the terminal pane under a viewport point, if any. */
function panePtyIdAt(x: number, y: number): string | null {
  const tabId = tabIdAt(x, y);
  if (!tabId) return null;
  return (
    useTerminalStore.getState().tabs.find((t) => t.id === tabId)?.ptyId ?? null
  );
}

// Lightweight drop-target highlight: outline the pane currently under the
// cursor so the user sees where the image will land.
let highlightedPane: HTMLElement | null = null;
function highlightPaneAt(x: number, y: number) {
  const el = document.elementFromPoint(x, y);
  const pane = el?.closest<HTMLElement>("[data-tab-id]") ?? null;
  if (pane === highlightedPane) return;
  clearPaneHighlight();
  if (pane) {
    pane.style.outline = "2px solid var(--color-accent, #6ea8fe)";
    pane.style.outlineOffset = "-2px";
    highlightedPane = pane;
  }
}
function clearPaneHighlight() {
  if (highlightedPane) {
    highlightedPane.style.outline = "";
    highlightedPane.style.outlineOffset = "";
    highlightedPane = null;
  }
}

export default ImageGallery;
