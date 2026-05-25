// vibe-term — Tauri window helpers.
//
// Thin async wrappers around `@tauri-apps/api/window` and `plugin-os`. They
// exist so non-Tauri consumers (vitest, vite preview) don't crash: every
// helper degrades to a sensible no-op or default when the Tauri runtime is
// missing.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform as osPlatform, type Platform } from "@tauri-apps/plugin-os";

/* eslint-disable @typescript-eslint/no-explicit-any */

function tauriIsAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as any;
  return Boolean(
    w.__TAURI_INTERNALS__ ||
      w.__TAURI__ ||
      w.__TAURI_IPC__ ||
      w.isTauri,
  );
}

/** Return whether the current window is maximised. False when not in Tauri. */
export async function isMaximized(): Promise<boolean> {
  if (!tauriIsAvailable()) return false;
  try {
    return await getCurrentWindow().isMaximized();
  } catch {
    return false;
  }
}

/** Flip between maximised and restored. No-op outside Tauri. */
export async function toggleMaximize(): Promise<void> {
  if (!tauriIsAvailable()) return;
  try {
    await getCurrentWindow().toggleMaximize();
  } catch {
    /* swallow — UI shouldn't break if the call fails */
  }
}

/** Update the OS window title (visible in taskbar, dock, alt-tab). */
export async function setWindowTitle(title: string): Promise<void> {
  if (!tauriIsAvailable()) return;
  try {
    await getCurrentWindow().setTitle(title);
  } catch {
    /* swallow */
  }
}

let cachedPlatform: Platform | null = null;

/**
 * Read the OS platform string. Cached after the first successful read. Falls
 * back to a UA-derived guess outside Tauri so consumers don't need a separate
 * branch in their feature checks.
 */
export function getPlatform(): Platform {
  if (cachedPlatform) return cachedPlatform;
  if (tauriIsAvailable()) {
    try {
      cachedPlatform = osPlatform();
      return cachedPlatform;
    } catch {
      /* fall through to UA detection */
    }
  }
  cachedPlatform = guessPlatformFromUA();
  return cachedPlatform;
}

function guessPlatformFromUA(): Platform {
  if (typeof navigator === "undefined") return "linux";
  const ua = navigator.userAgent ?? "";
  if (/Win(dows|32|64)/i.test(ua)) return "windows";
  if (/Mac|iPhone|iPad|iPod/i.test(ua)) return "macos";
  if (/Android/i.test(ua)) return "android";
  return "linux";
}

/** Test seam: reset the platform cache between tests. */
export function __resetWindowCacheForTests(): void {
  cachedPlatform = null;
}
