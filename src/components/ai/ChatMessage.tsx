import { memo, useMemo } from "react";
import clsx from "clsx";
import Markdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { contentToPlainText, markdownWithImageMarkers } from "@/lib/markdown";

import { ImageChip } from "./ImageChip";
import type { UiMessage } from "@/state/aiStore";

interface ChatMessageProps {
  message: UiMessage;
  /** True when this assistant message is the one currently being streamed. */
  streaming: boolean;
}

/**
 * Components map for `react-markdown`. We register a custom <imgref/> tag so
 * `markdownWithImageMarkers` can rewrite `img_xxxx` references into a node
 * the renderer hands back to us.
 */
const componentsBase: Components = {
  // The `node` prop is supplied by react-markdown but we don't need it.
  // We accept unknown props because `imgref` is not part of the HTML JSX
  // namespace and react-markdown calls custom components with the loose
  // ExtraProps shape.
  // @ts-expect-error custom intrinsic — passed through by react-markdown
  imgref: ({ id }: { id?: string }) =>
    id ? <ImageChip imageId={id} /> : null,
  code: ({ className, children, ...rest }) => {
    const inline = !/\blanguage-/.test(className ?? "");
    if (inline) {
      return (
        <code
          {...rest}
          className="rounded bg-bg-elevated px-1 py-0.5 font-mono text-[12px] text-zinc-200"
        >
          {children}
        </code>
      );
    }
    return (
      <code
        {...rest}
        className={clsx(className, "font-mono text-[12px] leading-snug")}
      >
        {children}
      </code>
    );
  },
  pre: ({ children, ...rest }) => (
    <pre
      {...rest}
      className="my-2 max-w-full overflow-x-auto rounded-md border border-border-muted bg-bg-elevated p-3 text-zinc-100"
    >
      {children}
    </pre>
  ),
  a: ({ children, href, ...rest }) => (
    <a
      {...rest}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent underline-offset-2 hover:underline"
    >
      {children}
    </a>
  ),
  table: ({ children, ...rest }) => (
    <div className="my-2 overflow-x-auto">
      <table
        {...rest}
        className="min-w-full border-collapse text-left text-[12px]"
      >
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...rest }) => (
    <th
      {...rest}
      className="border-b border-border bg-bg-elevated px-2 py-1 font-semibold text-zinc-200"
    >
      {children}
    </th>
  ),
  td: ({ children, ...rest }) => (
    <td {...rest} className="border-b border-border-muted px-2 py-1 text-zinc-300">
      {children}
    </td>
  ),
  ul: ({ children, ...rest }) => (
    <ul {...rest} className="my-1 list-disc space-y-0.5 pl-5 marker:text-zinc-500">
      {children}
    </ul>
  ),
  ol: ({ children, ...rest }) => (
    <ol {...rest} className="my-1 list-decimal space-y-0.5 pl-5 marker:text-zinc-500">
      {children}
    </ol>
  ),
  p: ({ children, ...rest }) => (
    <p {...rest} className="my-1 leading-relaxed first:mt-0 last:mb-0">
      {children}
    </p>
  ),
  blockquote: ({ children, ...rest }) => (
    <blockquote
      {...rest}
      className="my-2 border-l-2 border-accent-subtle pl-3 italic text-zinc-300"
    >
      {children}
    </blockquote>
  ),
};

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

function MessageBody({ text }: { text: string }) {
  const rewritten = useMemo(() => markdownWithImageMarkers(text), [text]);
  return (
    <Markdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={componentsBase}
      // Allow the inline <imgref/> tag we synthesise. `react-markdown` ignores
      // raw HTML by default, but custom void-style elements declared through
      // `components` are passed through unchanged.
    >
      {rewritten}
    </Markdown>
  );
}

function ChatMessageImpl({ message, streaming }: ChatMessageProps) {
  const isUser = message.role === "user";
  const text = useMemo(() => contentToPlainText(message.content), [message.content]);
  const imageBlocks = useMemo(
    () =>
      message.content.flatMap((b, i) =>
        b.type === "image"
          ? [{ key: `${message.id}-img-${i}`, mediaType: b.source.mediaType, data: b.source.data }]
          : [],
      ),
    [message.content, message.id],
  );

  return (
    <div
      className={clsx(
        "flex w-full",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={clsx(
          "max-w-[92%] rounded-lg border px-3 py-2 text-[13px] leading-relaxed shadow-sm",
          isUser
            ? "border-accent-subtle/50 bg-accent-subtle/15 text-zinc-100"
            : "border-border-muted bg-bg-subtle text-zinc-200",
          message.error && "border-red-700/60 bg-red-950/40",
        )}
      >
        <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-zinc-500">
          <span>{isUser ? "you" : "claude"}</span>
          {message.usage && (
            <span className="font-mono text-zinc-600">
              {message.usage.inputTokens}↑ {message.usage.outputTokens}↓
            </span>
          )}
        </div>

        {imageBlocks.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {imageBlocks.map((img) => (
              <img
                key={img.key}
                src={`data:${img.mediaType};base64,${img.data}`}
                alt="attached"
                className="max-h-32 max-w-[160px] rounded border border-border object-cover"
              />
            ))}
          </div>
        )}

        {text.length > 0 && (
          <div className="prose-invert max-w-none break-words text-[13px]">
            <MessageBody text={text} />
          </div>
        )}

        {streaming && !message.error && (
          <span
            aria-label="streaming"
            className="ml-1 inline-block h-3 w-1.5 animate-pulse rounded-sm bg-accent align-middle"
          />
        )}

        {message.error && (
          <div className="mt-2 font-mono text-[11px] text-red-300">
            {message.error}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Memoised so already-rendered messages don't re-evaluate Markdown on every
 * delta. The key includes the cumulative text length, which is the only thing
 * that changes during streaming.
 */
export const ChatMessage = memo(ChatMessageImpl, (prev, next) => {
  if (prev.streaming !== next.streaming) return false;
  if (prev.message.id !== next.message.id) return false;
  if (prev.message.error !== next.message.error) return false;
  if (prev.message.usage !== next.message.usage) return false;
  // Cheap content equality — rely on the cumulative text length to detect
  // streaming deltas; assistants only ever grow their last text block.
  const prevText = prev.message.content
    .map((b) => (b.type === "text" ? b.text.length : 1))
    .join(",");
  const nextText = next.message.content
    .map((b) => (b.type === "text" ? b.text.length : 1))
    .join(",");
  return prevText === nextText;
});
