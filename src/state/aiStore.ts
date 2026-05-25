// Global state for the Claude AI panel.
//
// Responsibilities:
//  - Track conversations keyed by their conversation id.
//  - Hold the staging images that the user has captured but not yet sent.
//  - Provide a `sendCurrent` action that converts the staged context into the
//    multimodal `ChatMessage` array Claude expects and dispatches `ai.send`.
//  - Apply streaming SSE deltas (`AI_DELTA`) and completion/error events to
//    the right message inside the right conversation.
//
// Conversation lifecycle:
//  - A conversation is created lazily by `openConversation(sessionId)`. If a
//    conversation already exists for that session (or for the special
//    "global" key, when sessionId is null), we reuse it.
//  - Each `send` adds one user `ChatMessage` and one streaming-stub assistant
//    `ChatMessage`. The stub's text grows as deltas arrive; we mark it as
//    finalised when the completion event lands and update the usage counters.
//
// The store deliberately stays UI-agnostic: components subscribe to slices
// they need and the backend listeners live in <AISidebar/>'s mount effect.

import { customAlphabet } from "nanoid";
import { create } from "zustand";

import {
  ai,
  images as imagesIpc,
  store as storeIpc,
  type AiConversationRow,
  type AiUsage,
  type ChatMessage,
  type ClaudeModel,
  type ContentBlock,
  type ConversationId,
  type ImageMeta,
  type MessageId,
} from "@/ipc";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const newConvId = customAlphabet(ALPHABET, 10);
const newMsgId = customAlphabet(ALPHABET, 10);

/** UI-facing wrapper around `ChatMessage` so we can track per-message metadata. */
export interface UiMessage {
  /** Stable id used to find the message during streaming. */
  id: MessageId;
  role: "user" | "assistant";
  /** Multimodal payload. For assistants we currently only ever push text blocks. */
  content: ContentBlock[];
  /** Sequence we can use as a stable key. */
  createdAt: number;
  /** When non-null the message is an error stub displayed in red. */
  error: string | null;
  /** Tokens reported by the API once the assistant message is finalised. */
  usage: AiUsage | null;
}

export interface Conversation {
  id: ConversationId;
  /** Linked terminal session id (null = global conv detached from any tab). */
  sessionId: string | null;
  title: string;
  model: ClaudeModel;
  messages: UiMessage[];
  /** Id of the assistant message currently being streamed (if any). */
  streamingMessageId: MessageId | null;
  tokensIn: number;
  tokensOut: number;
}

interface AiState {
  /** All known conversations keyed by id. */
  conversations: Record<ConversationId, Conversation>;
  /** Insertion order; useful if we later expose a switcher. */
  order: ConversationId[];
  activeConversationId: ConversationId | null;
  /** Images staged for the next outgoing message. */
  stagingImages: ImageMeta[];
  /** Whether the sidebar is currently visible. */
  isOpen: boolean;
  /** Sidebar width in pixels (resizable). */
  width: number;
  /** When set, the panel is gated behind the onboarding flow. */
  hasApiKey: boolean | null;

  // ── actions ─────────────────────────────────────────────────────────────
  openConversation(sessionId: string | null): ConversationId;
  setActiveConversation(id: ConversationId): void;
  setModel(id: ConversationId, model: ClaudeModel): void;
  appendStreamingDelta(convId: ConversationId, msgId: MessageId, text: string): void;
  finalizeMessage(convId: ConversationId, msgId: MessageId, usage: AiUsage): void;
  failMessage(convId: ConversationId, msgId: MessageId, error: string): void;
  stageImage(meta: ImageMeta): void;
  removeStaged(imageId: string): void;
  clearStaged(): void;
  /** Send the user's prompt for an already-resolved conversation. */
  sendCurrent(prompt: string, convId: ConversationId): Promise<void>;
  togglePanel(open?: boolean): void;
  setWidth(width: number): void;
  setHasApiKey(value: boolean): void;
  resetConversation(convId: ConversationId): void;
  /** Pull AI conversations + exchanges from the SQLite store for this
   *  session id and replace any in-memory conversation that already binds to
   *  the same `sessionId`. Safe to call multiple times — repeated invocations
   *  are deduplicated against the active conversations map. */
  loadHistoryForSession(sessionId: string): Promise<void>;
}

const DEFAULT_MODEL: ClaudeModel = "Opus47";
const DEFAULT_WIDTH = 380;
export const MIN_SIDEBAR_WIDTH = 280;
export const MAX_SIDEBAR_WIDTH = 600;

/**
 * Build the wire-format `ChatMessage[]` that Claude expects from our
 * UI-friendly messages. Strips any UI-only metadata.
 */
export function toWireMessages(messages: ReadonlyArray<UiMessage>): ChatMessage[] {
  return messages
    .filter((m) => m.content.length > 0)
    .map((m) => ({ role: m.role, content: m.content }));
}

function makeConversation(sessionId: string | null): Conversation {
  return {
    id: newConvId(),
    sessionId,
    title: sessionId ? "Tab chat" : "New conversation",
    model: DEFAULT_MODEL,
    messages: [],
    streamingMessageId: null,
    tokensIn: 0,
    tokensOut: 0,
  };
}

export const useAiStore = create<AiState>()((set, get) => ({
  conversations: {},
  order: [],
  activeConversationId: null,
  stagingImages: [],
  isOpen: false,
  width: DEFAULT_WIDTH,
  hasApiKey: null,

  openConversation(sessionId) {
    const state = get();
    // Reuse an existing conversation bound to the same session (or the
    // global one when sessionId is null).
    const existing = state.order
      .map((id) => state.conversations[id])
      .find((c) => c.sessionId === sessionId);
    if (existing) {
      if (state.activeConversationId !== existing.id) {
        set({ activeConversationId: existing.id });
      }
      return existing.id;
    }
    const conv = makeConversation(sessionId);
    set((s) => ({
      conversations: { ...s.conversations, [conv.id]: conv },
      order: [...s.order, conv.id],
      activeConversationId: conv.id,
    }));
    return conv.id;
  },

  setActiveConversation(id) {
    if (!get().conversations[id]) return;
    set({ activeConversationId: id });
  },

  setModel(id, model) {
    set((s) => {
      const conv = s.conversations[id];
      if (!conv) return s;
      return {
        conversations: { ...s.conversations, [id]: { ...conv, model } },
      };
    });
  },

  appendStreamingDelta(convId, msgId, text) {
    if (!text) return;
    set((s) => {
      const conv = s.conversations[convId];
      if (!conv) return s;
      const messages = conv.messages.map((msg) => {
        if (msg.id !== msgId) return msg;
        // Append to the trailing text block (creating one if needed).
        const blocks = [...msg.content];
        const tail = blocks[blocks.length - 1];
        if (tail && tail.type === "text") {
          blocks[blocks.length - 1] = { type: "text", text: tail.text + text };
        } else {
          blocks.push({ type: "text", text });
        }
        return { ...msg, content: blocks };
      });
      return {
        conversations: {
          ...s.conversations,
          [convId]: { ...conv, messages, streamingMessageId: msgId },
        },
      };
    });
  },

  finalizeMessage(convId, msgId, usage) {
    set((s) => {
      const conv = s.conversations[convId];
      if (!conv) return s;
      const messages = conv.messages.map((msg) =>
        msg.id === msgId ? { ...msg, usage } : msg,
      );
      return {
        conversations: {
          ...s.conversations,
          [convId]: {
            ...conv,
            messages,
            streamingMessageId:
              conv.streamingMessageId === msgId ? null : conv.streamingMessageId,
            tokensIn: conv.tokensIn + usage.inputTokens,
            tokensOut: conv.tokensOut + usage.outputTokens,
          },
        },
      };
    });
  },

  failMessage(convId, msgId, error) {
    set((s) => {
      const conv = s.conversations[convId];
      if (!conv) return s;
      const messages = conv.messages.map((msg) =>
        msg.id === msgId ? { ...msg, error } : msg,
      );
      return {
        conversations: {
          ...s.conversations,
          [convId]: {
            ...conv,
            messages,
            streamingMessageId:
              conv.streamingMessageId === msgId ? null : conv.streamingMessageId,
          },
        },
      };
    });
  },

  stageImage(meta) {
    set((s) =>
      s.stagingImages.some((img) => img.id === meta.id)
        ? s
        : { stagingImages: [...s.stagingImages, meta] },
    );
  },

  removeStaged(imageId) {
    set((s) => ({
      stagingImages: s.stagingImages.filter((img) => img.id !== imageId),
    }));
  },

  clearStaged() {
    set({ stagingImages: [] });
  },

  async sendCurrent(prompt, convId) {
    const state = get();
    const conv = state.conversations[convId];
    if (!conv) throw new Error(`unknown conversation ${convId}`);
    if (conv.streamingMessageId) {
      // Don't overlap requests — caller is expected to disable the send button.
      return;
    }

    const trimmed = prompt.trim();
    const staging = state.stagingImages;
    if (!trimmed && staging.length === 0) return;

    // Resolve every staged image to base64 in parallel. We do this before
    // touching the store so a partial failure doesn't leave a half-built
    // message floating in history.
    const imageBlocks: ContentBlock[] = await Promise.all(
      staging.map(async (img) => {
        const data = await imagesIpc.getBase64(img.id);
        return {
          type: "image" as const,
          source: { mediaType: img.mime, data },
        };
      }),
    );

    const userContent: ContentBlock[] = [];
    if (trimmed.length > 0) {
      userContent.push({ type: "text", text: trimmed });
    }
    userContent.push(...imageBlocks);

    const userMsg: UiMessage = {
      id: newMsgId(),
      role: "user",
      content: userContent,
      createdAt: Date.now(),
      error: null,
      usage: null,
    };
    const assistantMsg: UiMessage = {
      id: newMsgId(),
      role: "assistant",
      content: [],
      createdAt: Date.now() + 1,
      error: null,
      usage: null,
    };

    // Push optimistically and clear staging in one update so the UI flips
    // straight into "streaming" mode.
    set((s) => {
      const cur = s.conversations[convId];
      if (!cur) return s;
      const updatedMessages = [...cur.messages, userMsg, assistantMsg];
      const title =
        cur.messages.length === 0 && trimmed.length > 0
          ? trimmed.slice(0, 60).replace(/\s+/g, " ").trim() || cur.title
          : cur.title;
      return {
        conversations: {
          ...s.conversations,
          [convId]: {
            ...cur,
            title,
            messages: updatedMessages,
            streamingMessageId: assistantMsg.id,
          },
        },
        stagingImages: [],
      };
    });

    try {
      // The api_key field on the request is filled in by the backend from the
      // OS keyring — we send an empty placeholder so the type-checker is happy
      // and so a stale value can never leak through the IPC boundary.
      const post = get().conversations[convId];
      if (!post) throw new Error("conversation vanished mid-send");
      await ai.send({
        conversationId: convId,
        messageId: assistantMsg.id,
        model: post.model,
        maxTokens: 4096,
        systemPrompt: null,
        messages: toWireMessages(post.messages.filter((m) => m.id !== assistantMsg.id)),
        apiKey: "",
        temperature: null,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      get().failMessage(convId, assistantMsg.id, reason);
    }
  },

  togglePanel(open) {
    set((s) => ({ isOpen: open ?? !s.isOpen }));
  },

  setWidth(width) {
    const clamped = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));
    set({ width: clamped });
  },

  setHasApiKey(value) {
    set({ hasApiKey: value });
  },

  resetConversation(convId) {
    set((s) => {
      const conv = s.conversations[convId];
      if (!conv) return s;
      return {
        conversations: {
          ...s.conversations,
          [convId]: {
            ...conv,
            messages: [],
            streamingMessageId: null,
            tokensIn: 0,
            tokensOut: 0,
          },
        },
      };
    });
  },

  async loadHistoryForSession(sessionId) {
    let rows: AiConversationRow[];
    try {
      rows = await storeIpc.aiConversationList(sessionId);
    } catch (err) {
      console.warn("[ai] aiConversationList failed", err);
      return;
    }
    if (rows.length === 0) return;

    const loaded: Array<{ row: AiConversationRow; conv: Conversation }> = [];
    for (const row of rows) {
      let exchanges;
      try {
        exchanges = await storeIpc.aiExchangeList(row.id);
      } catch (err) {
        console.warn("[ai] aiExchangeList failed", err);
        continue;
      }
      const messages: UiMessage[] = exchanges.map((ex) => {
        let content: ContentBlock[];
        try {
          const parsed = JSON.parse(ex.contentJson) as unknown;
          if (Array.isArray(parsed)) {
            content = parsed as ContentBlock[];
          } else if (typeof parsed === "string") {
            content = [{ type: "text", text: parsed }];
          } else {
            content = [{ type: "text", text: JSON.stringify(parsed) }];
          }
        } catch {
          content = [{ type: "text", text: ex.contentJson }];
        }
        return {
          id: ex.id,
          role: ex.role === "assistant" ? "assistant" : "user",
          content,
          createdAt: ex.createdAt,
          error: null,
          usage:
            ex.inputTokens !== null && ex.outputTokens !== null
              ? { inputTokens: ex.inputTokens, outputTokens: ex.outputTokens }
              : null,
        };
      });
      const tokensIn = messages.reduce((acc, m) => acc + (m.usage?.inputTokens ?? 0), 0);
      const tokensOut = messages.reduce((acc, m) => acc + (m.usage?.outputTokens ?? 0), 0);
      // Resolve the model enum from the stored model id. Defaults to Opus when unknown.
      const model: ClaudeModel = (() => {
        if (row.model === "Sonnet46") return "Sonnet46";
        if (row.model === "Haiku45") return "Haiku45";
        return "Opus47";
      })();
      loaded.push({
        row,
        conv: {
          id: row.id,
          sessionId: row.sessionId,
          title: row.title ?? "Restored chat",
          model,
          messages,
          streamingMessageId: null,
          tokensIn,
          tokensOut,
        },
      });
    }

    set((s) => {
      // Drop any in-memory conversation that bound to the same sessionId — the
      // DB rows are authoritative now. Then merge the freshly loaded ones.
      const survivingOrder = s.order.filter((id) => {
        const c = s.conversations[id];
        return c?.sessionId !== sessionId;
      });
      const survivingConvs: Record<ConversationId, Conversation> = {};
      for (const id of survivingOrder) {
        survivingConvs[id] = s.conversations[id]!;
      }
      const mergedOrder = [...survivingOrder];
      for (const { conv } of loaded) {
        if (!survivingConvs[conv.id]) {
          mergedOrder.push(conv.id);
        }
        survivingConvs[conv.id] = conv;
      }
      const activeStillExists =
        s.activeConversationId !== null && survivingConvs[s.activeConversationId];
      return {
        conversations: survivingConvs,
        order: mergedOrder,
        activeConversationId: activeStillExists
          ? s.activeConversationId
          : (loaded[0]?.conv.id ?? null),
      };
    });
  },
}));
