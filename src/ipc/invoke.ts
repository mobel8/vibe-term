// Typed wrappers around `@tauri-apps/api/core::invoke` so component code never
// has to repeat command-name strings or shape its arguments by hand.

import { invoke as rawInvoke } from "@tauri-apps/api/core";

import type {
  AppInfo,
  Block,
  CaptureMode,
  ImageMeta,
  PtyId,
  SearchHit,
  SendRequest,
  SessionMeta,
  Settings,
  ShellInfo,
  SessionId,
  ConversationId,
  ImageId,
  AppendBlockParams,
} from "./types";

// ────────── App ──────────
export const ping = () => rawInvoke<string>("ping");
export const appInfo = () => rawInvoke<AppInfo>("app_info");

// ────────── PTY ──────────
export const pty = {
  spawn: (
    shell: string,
    args: string[],
    cwd: string | null,
    cols: number,
    rows: number,
    env: Array<[string, string]> = [],
  ) =>
    rawInvoke<PtyId>("pty_spawn", {
      opts: { shell, args, cwd, cols, rows, env },
    }),
  write: (id: PtyId, data: string) => rawInvoke<void>("pty_write", { id, data }),
  resize: (id: PtyId, cols: number, rows: number) =>
    rawInvoke<void>("pty_resize", { id, cols, rows }),
  kill: (id: PtyId) => rawInvoke<void>("pty_kill", { id }),
  listShells: () => rawInvoke<ShellInfo[]>("pty_list_shells"),
};

// ────────── Sessions / Blocks / Search ──────────
export const store = {
  sessionCreate: (name: string) => rawInvoke<SessionMeta>("session_create", { name }),
  sessionList: (limit = 50) => rawInvoke<SessionMeta[]>("session_list", { limit }),
  sessionGet: (id: SessionId) => rawInvoke<SessionMeta | null>("session_get", { id }),
  sessionTouch: (id: SessionId) => rawInvoke<void>("session_touch", { id }),
  sessionDelete: (id: SessionId) => rawInvoke<void>("session_delete", { id }),

  blockAppend: (params: AppendBlockParams) =>
    rawInvoke<Block>("block_append", { params }),
  blockList: (sessionId: SessionId, limit = 200, offset = 0) =>
    rawInvoke<Block[]>("block_list", { sessionId, limit, offset }),
  blockCount: (sessionId: SessionId) =>
    rawInvoke<number>("block_count", { sessionId }),

  searchFts: (query: string, session: SessionId | null = null, limit = 50) =>
    rawInvoke<SearchHit[]>("search_fts", { query, session, limit }),
};

// ────────── Images / OCR ──────────
export const images = {
  pasteFromClipboard: () =>
    rawInvoke<ImageMeta | null>("image_paste_from_clipboard"),
  captureScreen: (mode: CaptureMode) =>
    rawInvoke<ImageMeta>("image_capture_screen", { mode }),
  get: (id: ImageId) => rawInvoke<ImageMeta | null>("image_get", { id }),
  getBase64: (id: ImageId) => rawInvoke<string>("image_get_base64", { id }),
  delete: (id: ImageId) => rawInvoke<void>("image_delete", { id }),
  ocrExtract: (id: ImageId) => rawInvoke<string>("ocr_extract", { imageId: id }),
  listMonitors: () => rawInvoke<unknown[]>("list_monitors"),
};

// ────────── AI / Claude ──────────
export const ai = {
  setApiKey: (key: string) => rawInvoke<void>("ai_set_api_key", { key }),
  hasKey: () => rawInvoke<boolean>("ai_has_key"),
  send: (req: SendRequest) => rawInvoke<void>("ai_send", { req }),
  stop: (conversationId: ConversationId) =>
    rawInvoke<void>("ai_stop", { conversationId }),
};

// ────────── Config ──────────
export const config = {
  get: () => rawInvoke<Settings>("config_get"),
  update: (patch: Record<string, unknown>) =>
    rawInvoke<Settings>("config_update", { patch }),
  path: () => rawInvoke<string>("config_path"),
};

// Single curated import surface.
export const cmd = { ping, appInfo, pty, store, images, ai, config };
