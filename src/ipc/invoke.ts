// Typed wrappers around `@tauri-apps/api/core::invoke` so component code never
// has to repeat command-name strings or shape its arguments by hand.

import { invoke as rawInvoke } from "@tauri-apps/api/core";

import type {
  AiConversationRow,
  AiExchangeRow,
  AppInfo,
  Block,
  CaptureMode,
  DataPaths,
  DbImageRow,
  ExportFormat,
  ExportOptions,
  HotkeyBinding,
  HotkeyReplaceResult,
  ImageMeta,
  ImageSourceKind,
  MonitorInfo,
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
export const dataPaths = () => rawInvoke<DataPaths>("data_paths");

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
  listShells: () => rawInvoke<ShellInfo[]>("detect_shells"),
  defaultShell: () => rawInvoke<ShellInfo | null>("default_shell"),
};

// ────────── Sessions / Blocks / Search ──────────
export const store = {
  sessionCreate: (name: string) => rawInvoke<SessionMeta>("session_create", { name }),
  sessionList: (limit = 50) => rawInvoke<SessionMeta[]>("session_list", { limit }),
  sessionGet: (id: SessionId) => rawInvoke<SessionMeta | null>("session_get", { id }),
  sessionRename: (id: SessionId, name: string) =>
    rawInvoke<void>("session_rename", { id, name }),
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
  searchImagesFts: (query: string, limit = 50) =>
    rawInvoke<unknown[]>("search_images_fts", { query, limit }),

  // ── AI conversation persistence (Phase 6) ────────────────────────────
  aiConversationCreate: (args: { sessionId: SessionId; model: string; title?: string | null }) =>
    rawInvoke<AiConversationRow>("ai_conversation_create", { args }),
  aiConversationList: (sessionId: SessionId) =>
    rawInvoke<AiConversationRow[]>("ai_conversation_list", { sessionId }),
  aiExchangeAppend: (args: {
    conversationId: ConversationId;
    role: string;
    contentJson: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
  }) => rawInvoke<AiExchangeRow>("ai_exchange_append", { args }),
  aiExchangeList: (conversationId: ConversationId) =>
    rawInvoke<AiExchangeRow[]>("ai_exchange_list", { conversationId }),

  // ── DB image registry (Phase 4) ──────────────────────────────────────
  dbImageList: (limit = 50) => rawInvoke<DbImageRow[]>("db_image_list", { limit }),
  dbImageGet: (id: ImageId) => rawInvoke<DbImageRow | null>("db_image_get", { id }),
  dbImageSetOcr: (id: ImageId, text: string | null) =>
    rawInvoke<void>("db_image_set_ocr", { id, text }),
  dbImageAttachToBlock: (blockId: string, imageId: ImageId, position = 0) =>
    rawInvoke<void>("db_image_attach_to_block", { blockId, imageId, position }),
};

// ────────── Images / OCR ──────────
export const images = {
  pasteFromClipboard: () =>
    rawInvoke<ImageMeta | null>("image_from_clipboard"),
  captureScreen: (mode: CaptureMode) =>
    rawInvoke<ImageMeta>("screenshot_capture", { mode }),
  get: (id: ImageId) => rawInvoke<ImageMeta | null>("image_get", { id }),
  getBase64: (id: ImageId) => rawInvoke<string>("image_read_base64", { id }),
  delete: (id: ImageId) => rawInvoke<void>("image_delete", { id }),
  ocrExtract: (id: ImageId) => rawInvoke<string>("ocr_extract", { imageId: id }),
  listMonitors: () => rawInvoke<MonitorInfo[]>("list_monitors"),
  fromPath: (path: string, source: ImageSourceKind | null = null) =>
    rawInvoke<ImageMeta>("image_from_path", { path, source }),
  fromBytes: (bytes: number[], source: ImageSourceKind | null = null) =>
    rawInvoke<ImageMeta>("image_from_bytes", { bytes, source }),
};

// ────────── AI / Claude ──────────
export const ai = {
  setApiKey: (key: string) => rawInvoke<void>("ai_set_api_key", { key }),
  hasKey: () => rawInvoke<boolean>("ai_has_api_key"),
  send: (req: SendRequest) => rawInvoke<void>("ai_send", { req }),
  stop: (conversationId: ConversationId) =>
    rawInvoke<void>("ai_stop", { conversationId }),
  deleteKey: () => rawInvoke<void>("ai_delete_api_key"),
  keyPreview: () => rawInvoke<string | null>("ai_api_key_preview"),
};

// ────────── Hotkeys (Phase 7 — OS-level) ──────────
export const hotkeys = {
  register: (binding: HotkeyBinding) => rawInvoke<void>("hotkey_register", { binding }),
  unregister: (action: string) => rawInvoke<void>("hotkey_unregister", { action }),
  replaceAll: (bindings: HotkeyBinding[]) =>
    rawInvoke<HotkeyReplaceResult[]>("hotkey_replace_all", { bindings }),
  list: () => rawInvoke<HotkeyBinding[]>("hotkey_list"),
};

// ────────── Export (Phase 5 — session → MD/HTML) ──────────
export const exportSession = {
  render: (args: { sessionId: SessionId; format: ExportFormat; options?: ExportOptions }) =>
    rawInvoke<string>("export_session", { args }),
  toFile: (args: {
    sessionId: SessionId;
    outputPath: string;
    format: ExportFormat;
    options?: ExportOptions;
  }) => rawInvoke<void>("export_session_to_file", { args }),
};

// ────────── Config ──────────
export const config = {
  get: () => rawInvoke<Settings>("config_get"),
  update: (patch: Record<string, unknown>) =>
    rawInvoke<Settings>("config_update", { patch }),
  path: () => rawInvoke<string>("config_path"),
};

// Single curated import surface.
export const cmd = {
  ping,
  appInfo,
  dataPaths,
  pty,
  store,
  images,
  ai,
  config,
  hotkeys,
  exportSession,
};
