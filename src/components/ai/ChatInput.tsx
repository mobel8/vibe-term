import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import clsx from "clsx";

import type { ImageMeta } from "@/ipc";
import { extractImageIds } from "@/lib/markdown";

import { ImageChip } from "./ImageChip";

interface ChatInputProps {
  /** Resolved staging images that will accompany the prompt. */
  staging: ImageMeta[];
  /** Send the prompt — caller resets the textarea on resolve. */
  onSend: (prompt: string) => Promise<void> | void;
  /** Remove a staged image by id. */
  onRemoveStaged: (imageId: string) => void;
  /** True while a streaming assistant response is in flight. */
  streaming: boolean;
  /** Stop the in-flight request (rendered only when `streaming` is true). */
  onStop?: () => void;
  /** Placeholder copy for the textarea. */
  placeholder?: string;
  /** Whether the panel is in onboarding (input disabled). */
  disabled?: boolean;
}

const MIN_ROWS = 1;
const MAX_ROWS = 8;
const LINE_HEIGHT_PX = 20; // matches `text-[13px] leading-[20px]`.

export function ChatInput({
  staging,
  onSend,
  onRemoveStaged,
  streaming,
  onStop,
  placeholder,
  disabled,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Autosize textarea up to MAX_ROWS lines, then scroll internally.
  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = MAX_ROWS * LINE_HEIGHT_PX + 16; // include vertical padding.
    const min = MIN_ROWS * LINE_HEIGHT_PX + 16;
    const next = Math.min(max, Math.max(min, el.scrollHeight));
    el.style.height = `${next}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [value, resize]);

  const referencedIds = useMemo(() => extractImageIds(value), [value]);

  const canSend =
    !disabled &&
    !streaming &&
    (value.trim().length > 0 || staging.length > 0);

  const send = useCallback(async () => {
    if (!canSend) return;
    const prompt = value;
    setValue("");
    try {
      await onSend(prompt);
    } catch {
      // Restore on failure so user doesn't lose their text.
      setValue(prompt);
    }
  }, [canSend, onSend, value]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-border bg-bg-subtle px-3 pb-3 pt-2">
      {staging.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">
            staging
          </span>
          {staging.map((img) => (
            <ImageChip
              key={img.id}
              imageId={img.id}
              onRemove={onRemoveStaged}
              size="sm"
            />
          ))}
        </div>
      )}

      {referencedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-500">
          <span className="uppercase tracking-wide">refs in prompt:</span>
          {referencedIds.map((id) => (
            <ImageChip key={id} imageId={id} size="sm" />
          ))}
        </div>
      )}

      <div
        className={clsx(
          "flex items-end gap-2 rounded-lg border bg-bg-elevated p-2 transition-colors",
          disabled
            ? "border-border-muted opacity-60"
            : "border-border focus-within:border-accent-subtle",
        )}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKey}
          rows={MIN_ROWS}
          placeholder={placeholder ?? "Ask Claude…"}
          disabled={disabled}
          spellCheck
          className="min-h-[36px] flex-1 resize-none bg-transparent px-1 py-1 text-[13px] leading-[20px] text-zinc-100 outline-none placeholder:text-zinc-600"
        />
        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            className="self-end rounded-md border border-border bg-bg-muted px-2.5 py-1 text-xs text-zinc-200 transition-colors hover:bg-bg-elevated"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void send()}
            disabled={!canSend}
            className={clsx(
              "self-end rounded-md px-3 py-1 text-xs font-medium transition-colors",
              canSend
                ? "bg-accent text-bg shadow hover:bg-accent/90 active:translate-y-px"
                : "cursor-not-allowed bg-bg-muted text-zinc-500",
            )}
          >
            Send
          </button>
        )}
      </div>

      <div className="flex items-center justify-between text-[10px] text-zinc-600">
        <span>Enter to send · Shift+Enter for newline</span>
        {value.length > 0 && <span>{value.length} chars</span>}
      </div>
    </div>
  );
}
