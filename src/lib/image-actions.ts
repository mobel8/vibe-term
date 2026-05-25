// High-level orchestration helpers that string together IPC calls + store
// updates. Components (TerminalView, command palette, hotkeys handler, …)
// should always go through these wrappers rather than calling `images.*` and
// the stores by hand: this keeps the "intent → side effects" graph in one
// auditable place and makes it trivial to mock for tests.
//
// We intentionally take the stores as arguments (instead of importing them
// directly) so the helpers can be unit-tested without spinning up Zustand
// singletons. The runtime callers pass `useImageStore.getState()` / etc.

import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import { images } from "@/ipc";
import type { CaptureMode, ImageId, ImageMeta } from "@/ipc";

// ────────── Store shapes (structural; the concrete stores live next door) ──

export interface ImageStoreApi {
  hydrate(meta: ImageMeta): void;
  remove(id: ImageId): void;
  setLightbox(id: ImageId | null): void;
}

export interface TerminalStoreApi {
  attachImageToTab(tabId: string, image: ImageMeta): void;
}

/**
 * AI staging surface — the concrete implementation lives in Phase 6's
 * `aiStore.ts`. We type it structurally so this helper compiles before the
 * store exists, and the caller passes whatever value is currently wired
 * (typically `useAiStore.getState()`).
 */
export interface AiStoreApi {
  stageImage(imageId: ImageId): void;
}

// ────────── Core actions ────────────────────────────────────────────────

/**
 * Probe the OS clipboard for an image and, when one is present, persist it
 * via the backend, update both stores, and return the new meta so the caller
 * can do something with it (e.g. inject `[img_xxx]` into the prompt).
 *
 * Returns `null` when the clipboard contains no image — callers should then
 * fall through to a plain text paste. Errors propagate so the calling
 * `useEffect` can surface them.
 */
export async function pasteFromClipboardAndAttach(
  tabId: string,
  store: ImageStoreApi,
  terminalStore: TerminalStoreApi,
): Promise<ImageMeta | null> {
  const meta = await images.pasteFromClipboard();
  if (!meta) return null;
  store.hydrate(meta);
  terminalStore.attachImageToTab(tabId, meta);
  return meta;
}

/**
 * Trigger a screen capture (fullscreen / monitor / region) and attach the
 * resulting image to the given tab.
 */
export async function screenshotAndAttach(
  mode: CaptureMode,
  tabId: string,
  store: ImageStoreApi,
  terminalStore: TerminalStoreApi,
): Promise<ImageMeta> {
  const meta = await images.captureScreen(mode);
  store.hydrate(meta);
  terminalStore.attachImageToTab(tabId, meta);
  return meta;
}

/**
 * Stage an existing image in the AI sidebar's prompt composer (does NOT
 * re-fetch meta — the id alone is enough, the sidebar will resolve it).
 */
export async function attachToAi(
  imageId: ImageId,
  aiStore: AiStoreApi,
): Promise<void> {
  aiStore.stageImage(imageId);
}

/**
 * Delete an image both server-side and from the local cache. Silently no-ops
 * when the id was already missing — useful when a tab is being torn down and
 * the delete events may race the unmount.
 */
export async function deleteImage(
  imageId: ImageId,
  store: ImageStoreApi,
): Promise<void> {
  await images.delete(imageId);
  store.remove(imageId);
}

/**
 * Copy the textual id (`img_xxxx`) to the OS clipboard. Used by all the
 * "click the badge to copy" affordances. We delegate to the Tauri clipboard
 * plugin first (works in webviews where `navigator.clipboard` is blocked)
 * and fall back to the browser API only when the plugin throws — that path
 * exists mostly so vitest (jsdom) can exercise the call site.
 */
export async function copyImageId(imageId: ImageId): Promise<void> {
  try {
    await writeText(imageId);
    return;
  } catch {
    // Tauri plugin may be unavailable in the test environment — fall through.
  }
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(imageId);
  }
}

/**
 * Run OCR on a stored image and copy the extracted text. Returns the text so
 * the UI can toast a preview. The backend caches the OCR string on the
 * `ImageMeta`, so subsequent calls are effectively free.
 */
export async function ocrAndCopy(imageId: ImageId): Promise<string> {
  const text = await images.ocrExtract(imageId);
  if (text.length > 0) {
    try {
      await writeText(text);
    } catch {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
    }
  }
  return text;
}

/**
 * Save the image to a user-selected path via the OS native dialog. Returns
 * the chosen path (or `null` when the user cancelled). The bytes are pulled
 * from the backend in base64 then decoded once on the client — no extra
 * trip through disk.
 */
export async function saveImageAs(meta: ImageMeta): Promise<string | null> {
  const extension = mimeToExtension(meta.mime);
  const path = await saveDialog({
    title: "Save image",
    defaultPath: `${meta.id}.${extension}`,
    filters: [
      {
        name: extension.toUpperCase(),
        extensions: [extension],
      },
    ],
  });
  if (!path) return null;

  const base64 = await images.getBase64(meta.id);
  const bytes = decodeBase64ToBytes(base64);
  await writeFile(path, bytes);
  return path;
}

// ────────── Internals ─────────────────────────────────────────────────

function mimeToExtension(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/bmp":
      return "bmp";
    default:
      return "png";
  }
}

/**
 * Pure-JS base64 → Uint8Array decoder. We avoid `atob()` for binary data
 * because it's reliable in jsdom yet brittle on the latin-1 boundary for
 * larger images; this implementation handles arbitrary byte values.
 */
export function decodeBase64ToBytes(base64: string): Uint8Array {
  // Strip the data-URL prefix if it slipped in (defensive).
  const clean = base64.includes(",") ? base64.split(",", 2)[1] : base64;
  // `atob` is universally available in browser + jsdom; we then read each
  // 16-bit char code as a single byte (latin-1 round-trips losslessly).
  const binary = atob(clean);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
