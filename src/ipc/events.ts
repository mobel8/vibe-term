// Typed wrappers around `@tauri-apps/api/event::listen`. Each helper returns
// the unlisten Promise the caller can await in their effect cleanup so we never
// leak listeners on unmount.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AiDeltaEvent,
  AiErrorEvent,
  AiMessageCompleteEvent,
  ConfigChangedEvent,
  HotkeyTriggeredEvent,
  ImageAddedEvent,
  PtyDataEvent,
  PtyExitEvent,
} from "./types";

export const PTY_DATA = "pty://data" as const;
export const PTY_EXIT = "pty://exit" as const;
export const PTY_BELL = "pty://bell" as const;
export const PTY_CWD_CHANGE = "pty://cwd_change" as const;
export const AI_DELTA = "ai://delta" as const;
export const AI_MESSAGE_COMPLETE = "ai://message_complete" as const;
export const AI_ERROR = "ai://error" as const;
export const HOTKEY_TRIGGERED = "hotkey://triggered" as const;
export const IMAGE_ADDED = "image://added" as const;
export const CONFIG_CHANGED = "config://changed" as const;

type EventName = typeof PTY_DATA | typeof PTY_EXIT | typeof PTY_BELL
  | typeof PTY_CWD_CHANGE | typeof AI_DELTA | typeof AI_MESSAGE_COMPLETE
  | typeof AI_ERROR | typeof HOTKEY_TRIGGERED | typeof IMAGE_ADDED
  | typeof CONFIG_CHANGED;

type EventPayload<E extends EventName> =
  E extends typeof PTY_DATA ? PtyDataEvent :
  E extends typeof PTY_EXIT ? PtyExitEvent :
  E extends typeof PTY_BELL ? { ptyId: string } :
  E extends typeof PTY_CWD_CHANGE ? { ptyId: string; cwd: string } :
  E extends typeof AI_DELTA ? AiDeltaEvent :
  E extends typeof AI_MESSAGE_COMPLETE ? AiMessageCompleteEvent :
  E extends typeof AI_ERROR ? AiErrorEvent :
  E extends typeof HOTKEY_TRIGGERED ? HotkeyTriggeredEvent :
  E extends typeof IMAGE_ADDED ? ImageAddedEvent :
  E extends typeof CONFIG_CHANGED ? ConfigChangedEvent :
  never;

/**
 * Subscribe to a Tauri event with a strongly-typed payload.
 * Always await the returned promise inside `useEffect` and call the resolved
 * function in the cleanup branch.
 */
export function on<E extends EventName>(
  event: E,
  handler: (payload: EventPayload<E>) => void,
): Promise<UnlistenFn> {
  return listen<EventPayload<E>>(event, (e) => handler(e.payload));
}
