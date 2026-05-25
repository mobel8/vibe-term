import {
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
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  useAiStore,
} from "@/state/aiStore";

import { ApiKeyPrompt } from "./ApiKeyPrompt";
import { ChatInput } from "./ChatInput";
import { ChatMessage } from "./ChatMessage";
import { ModelPicker, modelInfo } from "./ModelPicker";

interface AISidebarProps {
  /** Optional terminal session id to bind the conversation to. */
  sessionId?: string | null;
}

export function AISidebar({ sessionId = null }: AISidebarProps) {
  const {
    conversations,
    activeConversationId,
    stagingImages,
    isOpen,
    width,
    hasApiKey,
    openConversation,
    setModel,
    appendStreamingDelta,
    finalizeMessage,
    failMessage,
    removeStaged,
    sendCurrent,
    togglePanel,
    setWidth,
    setHasApiKey,
    resetConversation,
  } = useAiStore();

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  // Resolve / create the conversation that matches the current tab.
  useEffect(() => {
    if (!isOpen) return;
    openConversation(sessionId);
  }, [isOpen, sessionId, openConversation]);

  // Boot-time: ask the backend if we already have an API key stored.
  useEffect(() => {
    let cancelled = false;
    ai.hasKey()
      .then((v) => {
        if (!cancelled) setHasApiKey(v);
      })
      .catch(() => {
        if (!cancelled) setHasApiKey(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setHasApiKey]);

  useEffect(() => {
    if (hasApiKey === false && isOpen) {
      setShowOnboarding(true);
    }
    if (hasApiKey === true) {
      setShowOnboarding(false);
    }
  }, [hasApiKey, isOpen]);

  // Subscribe to streaming events. We keep the listener mounted for as long
  // as the sidebar is rendered, regardless of which conversation is active,
  // so background streams keep updating their respective conversations.
  useEffect(() => {
    const unsubscribers: Array<() => void> = [];
    let alive = true;

    const wire = async () => {
      const ud = await on(AI_DELTA, (payload) => {
        appendStreamingDelta(payload.conversationId, payload.messageId, payload.text);
      });
      const uc = await on(AI_MESSAGE_COMPLETE, (payload) => {
        finalizeMessage(payload.conversationId, payload.messageId, payload.usage);
      });
      const ue = await on(AI_ERROR, (payload) => {
        failMessage(payload.conversationId, payload.messageId, payload.error);
      });
      if (!alive) {
        ud();
        uc();
        ue();
        return;
      }
      unsubscribers.push(ud, uc, ue);
    };

    void wire().catch((err) => {
      // Surface listener failures in the console — they would otherwise be
      // silent and we'd assume the stream is just slow.
      console.error("AI listeners failed to attach", err);
    });

    return () => {
      alive = false;
      for (const u of unsubscribers) u();
    };
  }, [appendStreamingDelta, finalizeMessage, failMessage]);

  const activeConv = activeConversationId
    ? conversations[activeConversationId]
    : null;

  // Auto-scroll the message list to the bottom whenever new content lands.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activeConv?.messages, activeConv?.streamingMessageId]);

  // Drag-to-resize handle living on the left edge of the panel.
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      const start = dragRef.current;
      if (!start) return;
      // Sidebar grows when the user drags left (toward the centre of the window).
      const next = start.startWidth - (e.clientX - start.startX);
      setWidth(next);
    },
    [setWidth],
  );
  const stopDrag = useCallback(() => {
    dragRef.current = null;
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", stopDrag);
    document.body.style.userSelect = "";
  }, [onMouseMove]);
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

  const model = activeConv?.model ?? "Opus47";
  const tokenCost = useMemo(() => {
    if (!activeConv) return null;
    const info = modelInfo(model);
    const inUsd = (activeConv.tokensIn / 1_000_000) * info.inputCost;
    const outUsd = (activeConv.tokensOut / 1_000_000) * info.outputCost;
    return inUsd + outUsd;
  }, [activeConv, model]);

  if (!isOpen) return null;

  const streaming = !!activeConv?.streamingMessageId;

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
            value={model}
            onChange={(m) => {
              if (activeConv) setModel(activeConv.id, m);
            }}
          />
          {activeConv && (
            <button
              type="button"
              onClick={() => resetConversation(activeConv.id)}
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
        className="flex-1 space-y-3 overflow-y-auto px-3 py-3"
        data-testid="ai-messages"
      >
        {activeConv && activeConv.messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-xs text-zinc-500">
            <div className="font-medium text-zinc-300">Start a conversation</div>
            <div className="max-w-[220px]">
              Ask anything about your terminal output. Paste or screenshot to attach images.
            </div>
          </div>
        )}
        {activeConv?.messages.map((msg) => (
          <ChatMessage
            key={msg.id}
            message={msg}
            streaming={activeConv.streamingMessageId === msg.id}
          />
        ))}
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
          tokens: {formatK(activeConv?.tokensIn ?? 0)} in /{" "}
          {formatK(activeConv?.tokensOut ?? 0)} out
        </span>
        {tokenCost !== null && tokenCost > 0 && (
          <span title="Estimated cost so far">≈ ${tokenCost.toFixed(4)}</span>
        )}
      </footer>

      {showOnboarding && (
        <ApiKeyPrompt
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
