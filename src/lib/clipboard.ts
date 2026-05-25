// vibe-term — Clipboard helpers.
//
// Tauri's clipboard plugin is the canonical path: it bypasses webview sandbox
// limitations (no user-gesture required, full text/image read access). When
// the plugin is not reachable — vitest, browser preview, or an OS where the
// plugin failed to register — we fall back to the standard `navigator.clipboard`
// API which is text-only and gated on a transient user gesture.
//
// Reads can fail silently in the fallback path (Firefox does not implement
// `clipboard.readText`); both helpers therefore return `null` instead of
// throwing so callers can branch on availability.

import {
  readText as tauriReadText,
  writeText as tauriWriteText,
} from "@tauri-apps/plugin-clipboard-manager";

/* eslint-disable @typescript-eslint/no-explicit-any */

function tauriIsAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as any;
  return Boolean(
    w.__TAURI_INTERNALS__ ||
      w.__TAURI__ ||
      w.__TAURI_IPC__ ||
      // Tauri 2 exposes a `isTauri` flag once the IPC handshake completes.
      w.isTauri,
  );
}

/**
 * Copy a UTF-8 string to the system clipboard. Tries Tauri first, then the
 * browser API. Resolves to true on success.
 */
export async function copyText(text: string): Promise<boolean> {
  if (tauriIsAvailable()) {
    try {
      await tauriWriteText(text);
      return true;
    } catch (err) {
       
      console.warn("[clipboard] tauri writeText failed, trying navigator", err);
    }
  }
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
       
      console.warn("[clipboard] navigator writeText failed", err);
    }
  }
  return false;
}

/**
 * Read the clipboard as UTF-8 text. Returns null when no text is available or
 * when every backend rejected (e.g. permission denied in the browser path).
 */
export async function readText(): Promise<string | null> {
  if (tauriIsAvailable()) {
    try {
      return await tauriReadText();
    } catch (err) {
       
      console.warn("[clipboard] tauri readText failed, trying navigator", err);
    }
  }
  if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText();
    } catch (err) {
       
      console.warn("[clipboard] navigator readText failed", err);
    }
  }
  return null;
}

/**
 * Copy the short, human-shoutable image id used in the terminal flow
 * (e.g. "img_a3f2zx") to the clipboard. Returns true on success.
 */
export async function copyImageId(imageId: string): Promise<boolean> {
  return copyText(imageId);
}
