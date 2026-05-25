// Manually-written TypeScript counterparts of the Rust DTOs.
// Once the backend compiles, `ts-rs` regenerates these in `./bindings/` and we
// can re-export them from here. Until then, keep this file in sync with the
// agent prompts in /home/moi/.claude/plans/peppy-bouncing-duckling.md.

// ────────── PTY (Phase 1) ──────────

export type PtyId = string;

export interface SpawnOptions {
  shell: string;
  args: string[];
  cwd: string | null;
  cols: number;
  rows: number;
  env: Array<[string, string]>;
}

export interface PtyDataEvent {
  ptyId: PtyId;
  data: string;
}

export interface PtyExitEvent {
  ptyId: PtyId;
  code: number | null;
}

export interface ShellInfo {
  name: string;
  path: string;
  args: string[];
}

// ────────── Sessions / Blocks / Search (Phase 5) ──────────

export type SessionId = string;
export type BlockId = string;
export type ConversationId = string;
export type MessageId = string;

export interface SessionMeta {
  id: SessionId;
  name: string;
  createdAt: number;
  updatedAt: number;
  metadataJson: string | null;
}

export type BlockKind =
  | "command"
  | "output"
  | "ai_user"
  | "ai_assistant"
  | "system";

export interface Block {
  id: BlockId;
  sessionId: SessionId;
  ptyId: string | null;
  kind: BlockKind;
  content: string;
  ansiRaw: number[] | null;
  exitCode: number | null;
  durationMs: number | null;
  createdAt: number;
  sequence: number;
}

export interface AppendBlockParams {
  sessionId: SessionId;
  ptyId?: string;
  kind: BlockKind;
  content: string;
  exitCode?: number;
  durationMs?: number;
}

export interface SearchHit {
  blockId: BlockId;
  sessionId: SessionId;
  snippet: string;
  rank: number;
}

// ────────── Images / OCR (Phase 4) ──────────

export type ImageId = string;

export type ImageSourceKind =
  | "clipboard"
  | "screenshot"
  | "drop"
  | "terminal";

export interface ImageMeta {
  id: ImageId;
  sha256: string;
  path: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  source: ImageSourceKind;
  ocrText: string | null;
  createdAt: number;
}

export type CaptureMode =
  | { kind: "fullscreen" }
  | { kind: "activeMonitor" }
  | { kind: "region"; x: number; y: number; w: number; h: number };

export interface MonitorInfo {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isPrimary: boolean;
}

// ────────── AI / Claude (Phase 6) ──────────

export type ClaudeModelId = "claude-opus-4-7" | "claude-sonnet-4-6" | "claude-haiku-4-5-20251001";

export type ClaudeModel = "Opus47" | "Sonnet46" | "Haiku45";

export type Role = "user" | "assistant";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { mediaType: string; data: string } };

export interface ChatMessage {
  role: Role;
  content: ContentBlock[];
}

export interface SendRequest {
  conversationId: ConversationId;
  messageId: MessageId;
  model: ClaudeModel;
  maxTokens: number;
  systemPrompt: string | null;
  messages: ChatMessage[];
  apiKey: string;
  temperature: number | null;
}

export interface AiDeltaEvent {
  conversationId: ConversationId;
  messageId: MessageId;
  text: string;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface AiMessageCompleteEvent {
  conversationId: ConversationId;
  messageId: MessageId;
  usage: AiUsage;
}

export interface AiErrorEvent {
  conversationId: ConversationId;
  messageId: MessageId;
  error: string;
}

// ────────── Config (Phase 7) ──────────

export type CursorStyle = "block" | "bar" | "underline";
export type AiProvider = "anthropic" | "openai";
export type ThemeName = "dark" | "light" | "dracula" | "nord" | "tokyo-night";

export interface GeneralSettings {
  defaultShell: string | null;
  workingDirectory: string | null;
  scrollbackLines: number;
  confirmOnClose: boolean;
}

export interface AppearanceSettings {
  theme: ThemeName | string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
}

export interface AiSettings {
  provider: AiProvider;
  model: string;
  maxContextBlocks: number;
  autoSummarizeThresholdTokens: number;
}

export interface TerminalSettings {
  bell: boolean;
  copyOnSelect: boolean;
  rightClickPaste: boolean;
}

export interface Settings {
  general: GeneralSettings;
  appearance: AppearanceSettings;
  hotkeys: Record<string, string>;
  ai: AiSettings;
  terminal: TerminalSettings;
}

// ────────── App info / misc ──────────

export interface AppInfo {
  name: string;
  version: string;
  targetOs: string;
  targetArch: string;
}

// ────────── Hotkeys events ──────────

export interface HotkeyTriggeredEvent {
  action: string;
}

export interface ImageAddedEvent {
  imageId: ImageId;
  source: ImageSourceKind;
  w: number;
  h: number;
}

export interface ConfigChangedEvent {
  settings: Settings;
}
