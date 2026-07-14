import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  ai,
  AI_DELTA,
  AI_ERROR,
  AI_MESSAGE_COMPLETE,
  on,
} from "@/ipc";
import type { AiProvider } from "@/ipc";
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  useAiStore,
} from "@/state/aiStore";
import { useConfigStore } from "@/state/configStore";

import { ApiKeyPrompt } from "./ApiKeyPrompt";
import { ChatInput } from "./ChatInput";
import { ChatMessage } from "./ChatMessage";
import { ModelPicker, modelCost } from "./ModelPicker";

interface AISidebarProps {
  /** Optional terminal session id to bind the conversation to. */
  sessionId?: string | null;
}

export function AISidebar({ sessionId = null }: AISidebarProps) {
  // Targeted selectors instead of destructuring the whole store: every
  // streamed token replaces `conversations[id]` (and its messages array), so a
  // selector-less subscription re-rendered the ENTIRE sidebar — header, input,
  // footer, resize handle — per delta. Each selector below returns a primitive
  // or a stable reference, so streaming only re-renders <ConversationMessages/>
  // (which owns the hot messages subscription further down).
  const activeConversationId = useAiStore((s) => s.activeConversationId);
  const stagingImages = useAiStore((s) => s.stagingImages);
  const isOpen = useAiStore((s) => s.isOpen);
  const width = useAiStore((s) => s.width);
  const hasApiKey = useAiStore((s) => s.hasApiKey);
  // Actions are defined once at store creation, so these references are stable.
  const openConversation = useAiStore((s) => s.openConversation);
  const setProviderModel = useAiStore((s) => s.setProviderModel);
  const appendStreamingDelta = useAiStore((s) => s.appendStreamingDelta);
  const finalizeMessage = useAiStore((s) => s.finalizeMessage);
  const failMessage = useAiStore((s) => s.failMessage);
  const removeStaged = useAiStore((s) => s.removeStaged);
  const sendCurrent = useAiStore((s) => s.sendCurrent);
  const togglePanel = useAiStore((s) => s.togglePanel);
  const setWidth = useAiStore((s) => s.setWidth);
  const setHasApiKey = useAiStore((s) => s.setHasApiKey);
  const resetConversation = useAiStore((s) => s.resetConversation);
  const loadHistoryForSession = useAiStore((s) => s.loadHistoryForSession);

  // Per-conversation slices, plucked as primitives so a streaming delta (which
  // swaps the conversation object) doesn't re-render the sidebar chrome: these
  // only change on picker/reset/finalize, never per token.
  const hasActiveConv = useAiStore(
    (s) => !!(s.activeConversationId && s.conversations[s.activeConversationId]),
  );
  const convProvider = useAiStore((s) =>
    s.activeConversationId
      ? s.conversations[s.activeConversationId]?.provider
      : undefined,
  );
  const convModel = useAiStore((s) =>
    s.activeConversationId
      ? s.conversations[s.activeConversationId]?.model
      : undefined,
  );
  const streaming = useAiStore((s) =>
    s.activeConversationId
      ? !!s.conversations[s.activeConversationId]?.streamingMessageId
      : false,
  );
  const tokensIn = useAiStore((s) =>
    s.activeConversationId
      ? (s.conversations[s.activeConversationId]?.tokensIn ?? 0)
      : 0,
  );
  const tokensOut = useAiStore((s) =>
    s.activeConversationId
      ? (s.conversations[s.activeConversationId]?.tokensOut ?? 0)
      : 0,
  );

  // Provider/model of the active conversation. Fall back to the CONFIGURED
  // defaults (Settings → AI) before the shipped constants — mirroring
  // makeConversation — so the header reflects the user's choice even in the
  // brief window before the conversation object exists. Drives the
  // per-provider API-key onboarding gate + the model picker.
  const cfgProvider = useConfigStore((s) => s.settings?.ai.provider);
  const cfgModel = useConfigStore((s) => s.settings?.ai.model);
  const provider: AiProvider = convProvider ?? cfgProvider ?? "anthropic";
  const model = convModel ?? cfgModel ?? "claude-opus-4-7";

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Whether the user is pinned to the bottom — when false (they scrolled up to
  // read history) we must NOT yank the view back down as new content arrives.
  const stickRef = useRef(true);
  const [showOnboarding, setShowOnboarding] = useState(false);

  // Resolve / create the conversation that matches the current tab.
  useEffect(() => {
    if (!isOpen) return;
    openConversation(sessionId);
  }, [isOpen, sessionId, openConversation]);

  // Hydrate persisted AI history (from the SQLite store) the first time we
  // bind to a real session. We do this once per session-id mount; a noisy
  // back-and-forth between tabs would otherwise re-fetch each click.
  useEffect(() => {
    if (!isOpen || !sessionId) return;
    void loadHistoryForSession(sessionId).catch((err) => {
      console.warn("[ai] loadHistoryForSession failed", err);
    });
  }, [isOpen, sessionId, loadHistoryForSession]);

  // Ask the backend whether THIS provider has a stored key — re-checked when
  // the user switches provider, so the onboarding gate tracks the active one.
  // Reset to `null` (pending) FIRST: `hasApiKey` is a single global value, so
  // without this the stale boolean from the previous provider would drive the
  // gate during the async re-check — flashing the onboarding prompt for the
  // WRONG provider (e.g. switching to a keyed provider briefly showed its key
  // prompt until hasKey resolved).
  useEffect(() => {
    let cancelled = false;
    setHasApiKey(null);
    ai.hasKey(provider)
      .then((v) => {
        if (!cancelled) setHasApiKey(v);
      })
      .catch(() => {
        if (!cancelled) setHasApiKey(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setHasApiKey, provider]);

  // Onboarding is shown ONLY when the key is confirmed absent for the active
  // provider. A `null` (pending) state hides it, so a provider switch never
  // surfaces a stale prompt for the wrong provider while the check is in flight.
  useEffect(() => {
    setShowOnboarding(hasApiKey === false && isOpen);
  }, [hasApiKey, isOpen]);

  // Subscribe to streaming events. We keep the listener mounted for as long
  // as the sidebar is rendered, regardless of which conversation is active,
  // so background streams keep updating their respective conversations.
  useEffect(() => {
    const unsubscribers: Array<() => void> = [];
    let alive = true;

    const wire = async () => {
      // Record each unlisten the instant it resolves so the cleanup array
      // always reflects what is actually attached. If a later await rejects we
      // must NOT orphan the listeners that already resolved.
      const attach: typeof on = async (evt, cb) => {
        const u = await on(evt, cb);
        if (!alive) {
          u();
          return u;
        }
        unsubscribers.push(u);
        return u;
      };
      await attach(AI_DELTA, (payload) => {
        appendStreamingDelta(payload.conversationId, payload.messageId, payload.text);
      });
      await attach(AI_MESSAGE_COMPLETE, (payload) => {
        finalizeMessage(payload.conversationId, payload.messageId, payload.usage);
      });
      await attach(AI_ERROR, (payload) => {
        failMessage(payload.conversationId, payload.messageId, payload.error);
      });
    };

    void wire().catch((err) => {
      // Surface listener failures in the console — they would otherwise be
      // silent and we'd assume the stream is just slow.
      console.error("AI listeners failed to attach", err);
      // Tear down any listeners that attached before the failure so they don't
      // leak; splice(0) empties the array so the unmount cleanup below finds
      // nothing and we never double-unlisten.
      for (const u of unsubscribers.splice(0)) u();
    });

    return () => {
      alive = false;
      for (const u of unsubscribers) u();
    };
  }, [appendStreamingDelta, finalizeMessage, failMessage]);

  // Track whether the user is at the bottom so we only auto-scroll when pinned.
  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  // Jump to the bottom (and re-pin) when switching conversations.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    stickRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, [activeConversationId]);

  // Keep the view pinned as content grows. A ResizeObserver on the message
  // container catches BOTH synchronous appends and the ASYNC height changes the
  // old `messages`-array effect missed — the throttled markdown reparse, syntax
  // highlighting and image loads that resize the list AFTER React has committed
  // (so the stream stays glued to the bottom instead of lagging behind).
  useEffect(() => {
    const content = contentRef.current;
    const el = scrollerRef.current;
    if (!content || !el) return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // Drag-to-resize handle living on the left edge of the panel.
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  // Coalesce width writes to at most one per animation frame: a raw mousemove
  // fires ~60+/sec and each setWidth re-renders the whole sidebar (incl. the
  // message list), so without this the resize handle stutters on long chats.
  const rafRef = useRef<number | null>(null);
  const pendingWidthRef = useRef<number | null>(null);
  const flushWidth = useCallback(() => {
    rafRef.current = null;
    const next = pendingWidthRef.current;
    if (next !== null) setWidth(next);
  }, [setWidth]);
  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      const start = dragRef.current;
      if (!start) return;
      // Sidebar grows when the user drags left (toward the centre of the window).
      pendingWidthRef.current = start.startWidth - (e.clientX - start.startX);
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(flushWidth);
      }
    },
    [flushWidth],
  );
  const stopDrag = useCallback(() => {
    dragRef.current = null;
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", stopDrag);
    document.body.style.userSelect = "";
    // Cancel any frame still pending and apply the final width synchronously so
    // the panel settles on the exact position the user released at.
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (pendingWidthRef.current !== null) {
      setWidth(pendingWidthRef.current);
      pendingWidthRef.current = null;
    }
  }, [onMouseMove, setWidth]);
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: width };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", stopDrag);
    document.body.style.userSelect = "none";
  };
  useEffect(() => () => stopDrag(), [stopDrag]);

  const handleSend = useCallback(
    async (prompt: string) => {
      const convId = activeConversationId ?? openConversation(sessionId);
      await sendCurrent(prompt, convId);
    },
    [activeConversationId, openConversation, sendCurrent, sessionId],
  );

  const handleStop = useCallback(() => {
    const convId = activeConversationId;
    if (!convId) return;
    ai.stop(convId).catch((err) => console.error("ai.stop failed", err));
  }, [activeConversationId]);

  const tokenCost = useMemo(() => {
    if (!hasActiveConv) return null;
    const cost = modelCost(model);
    const inUsd = (tokensIn / 1_000_000) * cost.in;
    const outUsd = (tokensOut / 1_000_000) * cost.out;
    return inUsd + outUsd;
  }, [hasActiveConv, model, tokensIn, tokensOut]);

  if (!isOpen) return null;

  return (
    <aside
      className="relative flex h-full flex-col border-l border-border bg-bg text-zinc-100"
      style={{
        width,
        minWidth: MIN_SIDEBAR_WIDTH,
        maxWidth: MAX_SIDEBAR_WIDTH,
      }}
      aria-label="Claude AI panel"
      data-testid="ai-sidebar"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={startDrag}
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-accent/30"
        title="Drag to resize"
      />

      <header className="flex items-center justify-between gap-2 border-b border-border bg-bg-subtle px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <ModelPicker
            provider={provider}
            model={model}
            onChange={(p, m) => {
              if (activeConversationId) setProviderModel(activeConversationId, p, m);
            }}
          />
          {hasActiveConv && activeConversationId && (
            <button
              type="button"
              onClick={() => resetConversation(activeConversationId)}
              className="rounded-md px-2 py-1 text-[11px] text-zinc-500 hover:bg-bg-muted hover:text-zinc-200"
              title="Reset conversation"
            >
              reset
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => togglePanel(false)}
          className="rounded-md px-2 py-1 text-sm text-zinc-400 hover:bg-bg-muted hover:text-zinc-100"
          aria-label="Close AI panel"
        >
          ×
        </button>
      </header>

      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-3 py-3"
        data-testid="ai-messages"
      >
        <ConversationMessages contentRef={contentRef} />
      </div>

      <ChatInput
        staging={stagingImages}
        onSend={handleSend}
        onRemoveStaged={removeStaged}
        streaming={streaming}
        onStop={handleStop}
        disabled={showOnboarding}
      />

      <footer className="flex items-center justify-between border-t border-border bg-bg-subtle px-3 py-1.5 font-mono text-[10px] text-zinc-500">
        <span>
          tokens: {formatK(tokensIn)} in /{" "}
          {formatK(tokensOut)} out
        </span>
        {tokenCost !== null && tokenCost > 0 && (
          <span title="Estimated cost so far">≈ ${tokenCost.toFixed(4)}</span>
        )}
      </footer>

      {showOnboarding && (
        <ApiKeyPrompt
          provider={provider}
          onSaved={() => {
            setHasApiKey(true);
            setShowOnboarding(false);
          }}
          onCancel={() => togglePanel(false)}
        />
      )}
    </aside>
  );
}

/**
 * The one part of the sidebar that subscribes to the streaming-hot slice —
 * the active conversation's messages array (replaced on every delta) and its
 * streamingMessageId. Memoised with a stable prop (the ref object), so parent
 * re-renders skip it entirely and each streamed token re-renders only this
 * subtree; <ChatMessage/> is itself memoised, so within it only the message
 * currently being streamed re-evaluates.
 */
const ConversationMessages = memo(function ConversationMessages({
  contentRef,
}: {
  /** Owned by the parent: its ResizeObserver keeps the scroller pinned. */
  contentRef: React.RefObject<HTMLDivElement | null>;
}) {
  const messages = useAiStore((s) =>
    s.activeConversationId
      ? s.conversations[s.activeConversationId]?.messages
      : undefined,
  );
  const streamingMessageId = useAiStore((s) =>
    s.activeConversationId
      ? (s.conversations[s.activeConversationId]?.streamingMessageId ?? null)
      : null,
  );

  return (
    <>
      {messages && messages.length === 0 && (
        <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-xs text-zinc-500">
          <div className="font-medium text-zinc-300">Start a conversation</div>
          <div className="max-w-[220px]">
            Ask anything about your terminal output. Paste or screenshot to attach images.
          </div>
        </div>
      )}
      <div ref={contentRef} className="space-y-3">
        {messages?.map((msg) => (
          <ChatMessage
            key={msg.id}
            message={msg}
            streaming={streamingMessageId === msg.id}
          />
        ))}
      </div>
    </>
  );
});

function formatK(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

/** Re-exported helper for higher-level layouts that need to toggle the panel. */
export function useAiSidebarVisibility() {
  const isOpen = useAiStore((s) => s.isOpen);
  const toggle = useAiStore((s) => s.togglePanel);
  return useMemo(() => ({ isOpen, toggle }) as const, [isOpen, toggle]);
}
