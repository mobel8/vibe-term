// Global state for the Claude AI panel.
//
// Responsibilities:
//  - Track conversations keyed by their conversation id.
//  - Hold the staging images that the user has captured but not yet sent.
//  - Provide a `sendCurrent` action that converts the staged context into the
//    multimodal `ChatMessage` array Claude expects and dispatches `ai.send`.
//    When the conversation is bound to a session and `ai.maxContextBlocks` is
//    set, the newest terminal blocks are folded into the outgoing payload as a
//    <terminal_context> preamble (request-only; never rendered or persisted).
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
  type AiProvider,
  type ContentBlock,
  type ConversationId,
  type ImageMeta,
  type MessageId,
} from "@/ipc";
import { useConfigStore } from "@/state/configStore";

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
  /**
   * True once a backing DB row exists. When persisted, `id` IS the backend
   * `conv_…` id (the live id is re-keyed to it on first send), so streaming
   * events, store key, and DB row id all coincide and loadHistoryForSession
   * dedupes cleanly instead of duplicating the conversation.
   */
  persisted: boolean;
  /** Which provider this conversation routes to. */
  provider: AiProvider;
  title: string;
  /** Provider-specific model id (e.g. "claude-opus-4-7", "llama-3.3-70b-versatile"). */
  model: string;
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
  setModel(id: ConversationId, model: string): void;
  setProviderModel(id: ConversationId, provider: AiProvider, model: string): void;
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
  setHasApiKey(value: boolean | null): void;
  resetConversation(convId: ConversationId): void;
  /** Pull AI conversations + exchanges from the SQLite store for this
   *  session id and replace any in-memory conversation that already binds to
   *  the same `sessionId`. Safe to call multiple times — repeated invocations
   *  are deduplicated against the active conversations map. */
  loadHistoryForSession(sessionId: string): Promise<void>;
}

const DEFAULT_PROVIDER: AiProvider = "anthropic";
const DEFAULT_MODEL = "claude-opus-4-7";

/** The DB has no provider column, so a restored conversation infers its
 *  provider from the stored model id. Best-effort — only matters if the user
 *  CONTINUES a restored chat (they can switch providers in the picker). */
function providerFromModel(model: string): AiProvider {
  const m = model.toLowerCase();
  if (m.startsWith("claude") || m === "opus47" || m === "sonnet46" || m === "haiku45")
    return "anthropic";
  if (m === "deepseek-chat" || m === "deepseek-reasoner") return "deepseek";
  if (/^(mistral|magistral|codestral|ministral|pixtral|devstral|open-mistral)/.test(m))
    return "mistral";
  // llama / qwen / gemma / gpt-oss / kimi are offered by both Groq and Cerebras;
  // default to Groq (more common). The user can re-pick the provider.
  return "groq";
}
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

/** Hard cap on the inlined terminal context (~1k tokens) so a chatty session
 *  can't blow the request budget no matter how large maxContextBlocks is. */
const MAX_CONTEXT_CHARS = 4000;

/**
 * Assemble the `<terminal_context>` preamble for an outgoing request: the
 * newest `settings.ai.maxContextBlocks` blocks of the bound session, joined
 * oldest→newest so the model reads the transcript in natural order. Returns
 * null when the feature is off (maxContextBlocks <= 0 or config not loaded),
 * the conversation is unbound, or the store is unreachable — context is
 * best-effort and must never block or fail a send.
 */
async function fetchTerminalContext(sessionId: string | null): Promise<string | null> {
  if (!sessionId) return null;
  const max = useConfigStore.getState().settings?.ai.maxContextBlocks ?? 0;
  if (max <= 0) return null;
  try {
    // block_list pages oldest-first (ORDER BY sequence ASC LIMIT/OFFSET), so
    // the newest N live at offset count-N — a plain blockList(sessionId, N)
    // would return the very FIRST blocks of the session instead.
    const count = await storeIpc.blockCount(sessionId);
    if (count <= 0) return null;
    const blocks = await storeIpc.blockList(sessionId, max, Math.max(0, count - max));
    let joined = blocks
      .map((b) => b.content)
      .filter((c) => c.trim().length > 0)
      .join("\n\n");
    if (joined.trim().length === 0) return null;
    if (joined.length > MAX_CONTEXT_CHARS) {
      // Keep the END: the most recent output is what the user is asking about.
      joined = `[…older terminal output truncated…]\n${joined.slice(-MAX_CONTEXT_CHARS)}`;
    }
    return `<terminal_context>\n${joined}\n</terminal_context>`;
  } catch (err) {
    console.warn("[ai] terminal context fetch failed; sending without it", err);
    return null;
  }
}

function makeConversation(sessionId: string | null): Conversation {
  // Seed provider/model from the user's configured defaults (Settings → AI →
  // settings.ai.provider/model) instead of the shipped constants — otherwise
  // the config knobs are dead and every new chat silently reverts to Anthropic.
  // Config may not be hydrated yet on a cold open; fall back to the constants
  // then (the header in <AISidebar/> applies the same fallback chain).
  const cfg = useConfigStore.getState().settings?.ai;
  return {
    id: newConvId(),
    sessionId,
    persisted: false,
    provider: cfg?.provider ?? DEFAULT_PROVIDER,
    title: sessionId ? "Tab chat" : "New conversation",
    // `||` not `??`: a hand-edited empty model string in config.toml must not
    // produce an unroutable request.
    model: cfg?.model || DEFAULT_MODEL,
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

  setProviderModel(id, provider, model) {
    set((s) => {
      const conv = s.conversations[id];
      if (!conv) return s;
      return {
        conversations: {
          ...s.conversations,
          [id]: { ...conv, provider, model },
        },
      };
    });
  },

  appendStreamingDelta(convId, msgId, text) {
    if (!text) return;
    set((s) => {
      const conv = s.conversations[convId];
      if (!conv) {
        // The first delta can land before the optimistic assistant stub has
        // committed to the store, but a missing conversation is genuinely
        // unexpected — surface it so we don't silently drop tokens.
        console.warn(`[ai] streaming delta for unknown conversation ${convId}; dropping ${text.length} chars`);
        return s;
      }
      let appended = false;
      const messages = conv.messages.map((msg) => {
        if (msg.id !== msgId) return msg;
        if (msg.role !== "assistant") {
          console.error(`[ai] refusing to append delta to ${msg.role} message ${msgId}`);
          return msg;
        }
        appended = true;
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
      if (!appended) {
        // Only synthesise a stub when the delta targets the live stream. A
        // stray delta whose msgId no longer matches `streamingMessageId` (e.g.
        // arriving after the conversation was reset/cleared) must be dropped —
        // otherwise we'd resurrect a phantom message and re-enter a fake
        // streaming state below. Early-return so the streamingMessageId reset
        // at the end of this updater can't fire for a cleared conversation.
        if (conv.streamingMessageId !== msgId) {
          console.warn(`[ai] dropping stray delta for msgId ${msgId} (not the live stream)`);
          return s;
        }
        // Stream-before-stub race: the assistant placeholder hasn't reached
        // the store yet (commits between `sendCurrent` and the first delta).
        // Synthesise the stub so the very first tokens aren't lost.
        console.warn(`[ai] delta arrived for unknown msgId ${msgId}; synthesising assistant stub`);
        messages.push({
          id: msgId,
          role: "assistant",
          content: [{ type: "text", text }],
          createdAt: Date.now(),
          error: null,
          usage: null,
        });
      }
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

    // Persist the finalized assistant message (fire-and-forget). Only for
    // DB-backed conversations with real content — never persist empty/error
    // stubs (failMessage skips persistence entirely), so a reload never
    // resurrects a blank assistant turn.
    const finalized = get().conversations[convId];
    if (finalized?.persisted) {
      const msg = finalized.messages.find((m) => m.id === msgId);
      if (msg && msg.role === "assistant" && msg.content.length > 0) {
        void storeIpc
          .aiExchangeAppend({
            conversationId: convId,
            role: "assistant",
            contentJson: JSON.stringify(msg.content),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          })
          .catch((e) => console.warn("[ai] persist assistant exchange failed", e));
      }
    }
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

    // Title derived from the first user message — used for BOTH the persisted DB
    // row and the live conversation so they agree after a restart.
    const convNow = get().conversations[convId];
    const derivedTitle =
      convNow && convNow.messages.length === 0 && trimmed.length > 0
        ? trimmed.slice(0, 60).replace(/\s+/g, " ").trim() || convNow.title
        : convNow?.title ?? "";

    // ── Persist: create the DB conversation on the FIRST send, then RE-KEY the
    // live conversation to the backend `conv_…` id so the store key, the id sent
    // to `ai.send` (the streaming-event key), and the DB row id all coincide.
    // Only when the conv is bound to a real DB session (sess_…); otherwise stay
    // in-memory only (global/unbound chats still work). Must happen BEFORE the
    // optimistic commit + ai.send so no deltas are routed to a stale key.
    let activeId = convId;
    if (convNow && !convNow.persisted && convNow.sessionId) {
      try {
        const row = await storeIpc.aiConversationCreate({
          sessionId: convNow.sessionId,
          model: convNow.model,
          provider: convNow.provider,
          title: derivedTitle,
        });
        activeId = row.id;
        set((s) => {
          const c = s.conversations[convId];
          if (!c) return s;
          const next: Record<string, Conversation> = { ...s.conversations };
          delete next[convId];
          next[row.id] = { ...c, id: row.id, persisted: true };
          return {
            conversations: next,
            order: s.order.map((id) => (id === convId ? row.id : id)),
            activeConversationId:
              s.activeConversationId === convId ? row.id : s.activeConversationId,
          };
        });
      } catch (err) {
        console.warn("[ai] persist conversation failed; continuing in-memory", err);
      }
    }

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
      const cur = s.conversations[activeId];
      // Atomic double-send guard: the line-301 check happened before the
      // (awaited) image resolution, so a second send can slip through that
      // window. Re-check streamingMessageId here — set callbacks are
      // serialized, so the first send commits the stream and any concurrent
      // second send sees it non-null and no-ops (preserving staging).
      if (!cur || cur.streamingMessageId) return s;
      const updatedMessages = [...cur.messages, userMsg, assistantMsg];
      return {
        conversations: {
          ...s.conversations,
          [activeId]: {
            ...cur,
            title: derivedTitle,
            messages: updatedMessages,
            streamingMessageId: assistantMsg.id,
          },
        },
        stagingImages: [],
      };
    });

    // Persist the user exchange (fire-and-forget; ordering vs the assistant is
    // guaranteed by the DB sequence auto-increment). Never blocks the request.
    if (get().conversations[activeId]?.persisted) {
      void storeIpc
        .aiExchangeAppend({
          conversationId: activeId,
          role: "user",
          contentJson: JSON.stringify(userContent),
        })
        .catch((e) => console.warn("[ai] persist user exchange failed", e));
    }

    try {
      // The api_key field on the request is filled in by the backend from the
      // OS keyring — we send an empty placeholder so the type-checker is happy
      // and so a stale value can never leak through the IPC boundary.
      const post = get().conversations[activeId];
      if (!post) throw new Error("conversation vanished mid-send");
      // If the atomic guard above no-op'd this send (a concurrent send won the
      // race), our optimistic messages were never committed and another stream
      // owns the conversation. Bail without dispatching a duplicate request and
      // without clearing/restoring staging — the winning send already handled it.
      if (post.streamingMessageId !== assistantMsg.id) return;

      // Terminal context (settings.ai.maxContextBlocks): the tail of the
      // session's block stream, injected into the OUTGOING copy of the user
      // turn only. conv.messages and the persisted exchange stay clean — the
      // context is point-in-time and would go stale (and re-bill on every
      // later turn) if it were replayed from the stored history.
      const terminalContext = await fetchTerminalContext(post.sessionId);
      const wireMessages = toWireMessages(
        post.messages.filter((m) => m.id !== assistantMsg.id),
      );
      if (terminalContext) {
        const lastIdx = wireMessages.length - 1;
        const last = wireMessages[lastIdx];
        // The tail wire message is the user turn we just committed (the
        // assistant stub is filtered out above). Guard anyway — skipping the
        // context beats mislabelling it as an assistant turn.
        if (last && last.role === "user") {
          // A SEPARATE leading text block, not a string splice: wire messages
          // share their `content` arrays with the UI messages (toWireMessages
          // copies the envelope only), so mutating in place would leak the
          // context into the rendered chat. Anthropic accepts multi-block
          // content verbatim and build_openai_payload flattens blocks with
          // "\n" joins, so this shape survives every provider unchanged.
          wireMessages[lastIdx] = {
            role: last.role,
            content: [{ type: "text", text: terminalContext }, ...last.content],
          };
        }
      }
      await ai.send({
        conversationId: activeId,
        messageId: assistantMsg.id,
        provider: post.provider,
        model: post.model,
        maxTokens: 4096,
        systemPrompt: null,
        messages: wireMessages,
        apiKey: "",
        temperature: null,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      get().failMessage(activeId, assistantMsg.id, reason);
      // The optimistic update cleared the staging tray; restore it on failure
      // so the user can retry without re-capturing every image. Only restore
      // when nothing new has been staged in the meantime.
      if (staging.length > 0) {
        set((s) => (s.stagingImages.length === 0 ? { stagingImages: staging } : s));
      }
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
      // model is stored verbatim. Provider is now persisted too (legacy rows
      // default to "anthropic"); only fall back to inferring it from the model
      // id if it's somehow absent, since that inference is ambiguous.
      const model = row.model;
      const provider = (row.provider as AiProvider) || providerFromModel(model);
      loaded.push({
        row,
        conv: {
          id: row.id,
          sessionId: row.sessionId,
          persisted: true,
          provider,
          title: row.title ?? "Restored chat",
          model,
          messages,
          streamingMessageId: null,
          tokensIn,
          tokensOut,
        },
      });
    }

    // If every aiExchangeList call threw (transient DB lock / IPC failure) we
    // end up with rows but nothing usable. Bail before the destructive merge,
    // mirroring the `rows.length === 0` guard above, so a transient error can't
    // blank the freshly-opened in-memory conversation for this session.
    if (loaded.length === 0) return;

    // DB rows use backend `conv_...` ids; in-memory conversations use client
    // nanoids, so the id spaces never overlap. We use this set below to avoid
    // dropping unpersisted in-memory conversations that have no DB counterpart.
    const loadedIds = new Set(loaded.map((l) => l.conv.id));

    set((s) => {
      // Drop any in-memory conversation that bound to the same sessionId — the
      // DB rows are authoritative now. Then merge the freshly loaded ones.
      const survivingOrder = s.order.filter((id) => {
        const c = s.conversations[id];
        if (!c) return false;
        // Keep conversations bound to OTHER sessions, and never drop one that
        // is actively streaming for THIS session — replacing it mid-stream
        // would orphan the live assistant message (incoming deltas would target
        // a conversation that no longer exists and the response would be lost).
        // Also keep any in-memory conversation that has no DB counterpart
        // (its client id is absent from loadedIds) so a just-finished,
        // unpersisted chat isn't silently erased by the re-hydrate.
        return (
          c.sessionId !== sessionId ||
          c.streamingMessageId !== null ||
          (!loadedIds.has(c.id) && c.messages.length > 0)
        );
        // NOTE: the `messages.length > 0` guard is essential. openConversation
        // creates an EMPTY placeholder conv for this session when the panel
        // opens; without the guard the placeholder (client id, absent from
        // loadedIds) was KEPT and stayed active, so restored history never
        // surfaced. We still preserve unpersisted chats that have real content.
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
