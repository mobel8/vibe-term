import { useEffect } from "react";

import { useImageStore } from "@/state/imageStore";

/**
 * Whole-window visual cue that lights up while the user drags a file over
 * the application. The actual file ingestion happens in Rust via Tauri's
 * `WindowEvent::FileDrop` (pitfall #10: WebView2 on Windows intercepts the
 * drop *before* the renderer ever sees it — relying on DOM `drop` events
 * would silently break on that platform), so this component is purely
 * cosmetic: it watches the DOM `dragenter`/`dragleave`/`dragover`/`drop`
 * events to flip `isDragOver`, then renders a glowing border + label when
 * the flag is true.
 *
 * Why we still call `preventDefault` on the DOM events:
 *   - On Windows + WebView2 the OS drop is handled in Rust and the WebView
 *     event never fires for image MIMEs, but it *does* fire for text files
 *     and we don't want the browser to navigate away.
 *   - On macOS + Linux WebKitGTK the WebView's default drop opens the file
 *     in the navigator; preventing it keeps the user inside the app while
 *     the backend processes the file.
 */
export function DropZoneOverlay() {
  const isDragOver = useImageStore((s) => s.isDragOver);
  const setDragOver = useImageStore((s) => s.setDragOver);

  useEffect(() => {
    let depth = 0;

    const hasFiles = (e: DragEvent): boolean => {
      const items = e.dataTransfer?.items;
      if (items) {
        for (let i = 0; i < items.length; i += 1) {
          if (items[i].kind === "file") return true;
        }
      }
      const types = e.dataTransfer?.types;
      if (types) {
        for (let i = 0; i < types.length; i += 1) {
          if (types[i] === "Files") return true;
        }
      }
      return false;
    };

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      setDragOver(true);
    };

    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragOver(false);
    };

    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // Required for `drop` to fire in the WebView; we then let Tauri handle
      // the actual file ingestion in Rust.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };

    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // Block the browser default (navigate to file) — the Tauri FileDrop
      // event listener on the backend has already received the paths.
      e.preventDefault();
      depth = 0;
      setDragOver(false);
    };

    document.addEventListener("dragenter", onDragEnter);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragenter", onDragEnter);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, [setDragOver]);

  if (!isDragOver) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center"
    >
      <div className="absolute inset-3 rounded-2xl border-2 border-dashed border-accent bg-accent/5" />
      <div className="relative flex flex-col items-center gap-2 rounded-xl border border-accent/40 bg-bg-elevated/90 px-6 py-4 font-mono text-sm text-accent shadow-2xl backdrop-blur">
        <IconImageDrop />
        <span>Drop image to attach</span>
        <span className="text-[11px] text-zinc-400">
          PNG · JPG · WebP · GIF · BMP
        </span>
      </div>
    </div>
  );
}

function IconImageDrop() {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-8 w-8"
      aria-hidden
    >
      <rect x="5" y="6" width="22" height="16" rx="2" />
      <circle cx="11" cy="12" r="1.8" />
      <path d="M5 19l5-5 5 5 4-4 8 8" />
      <path d="M16 24v6m0 0l-3-3m3 3l3-3" />
    </svg>
  );
}

export default DropZoneOverlay;
