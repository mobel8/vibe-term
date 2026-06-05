import { memo, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import Markdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { contentToPlainText, IMAGE_ID_PATTERN } from "@/lib/markdown";

import { ImageChip } from "./ImageChip";
import type { UiMessage } from "@/state/aiStore";

interface ChatMessageProps {
  message: UiMessage;
  /** True when this assistant message is the one currently being streamed. */
  streaming: boolean;
}

/**
 * Components map for `react-markdown`. Image references are handled by the
 * `remarkImageChips` plugin (below) + an `imgchip` renderer in
 * `componentsWithChips`, NOT here: the original approach injected a raw
 * `<imgref/>` HTML tag, but react-markdown does not parse raw HTML without
 * `rehype-raw` (which we avoid — it would let model output inject arbitrary
 * HTML). The plugin instead rewrites parsed text nodes, leaving code untouched.
 */
const componentsBase: Components = {
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

const rehypePlugins = [rehypeHighlight];

/**
 * Minimal mdast shapes we touch. We can't import `@types/mdast`/`unist`
 * (not direct deps), so we model only the fields the plugin reads/writes.
 */
interface MdastTextNode {
  type: "text";
  value: string;
}
interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/**
 * Remark plugin that turns standalone `img_xxxx` references into a custom
 * `imgchip` element — operating on the parsed mdast tree rather than on the
 * raw string. Because inline/fenced code is represented by `inlineCode`/`code`
 * nodes (which have a `value` but no child `text` nodes), only genuine prose
 * `text` nodes are split, so image-id-shaped tokens inside code are preserved
 * verbatim and code fences are never shattered. This keeps a single
 * <Markdown> instance (so block/inline structure is intact) and needs no
 * rehype-raw (the chip element is built programmatically, not from model HTML).
 */
function remarkImageChips() {
  return (tree: MdastNode) => {
    const pattern = new RegExp(IMAGE_ID_PATTERN.source, "g");
    const visit = (node: MdastNode) => {
      const children = node.children;
      if (!children) return;
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        if (child.type === "text" && typeof child.value === "string") {
          const replacement = splitTextNode(child.value, pattern);
          if (replacement) {
            children.splice(i, 1, ...replacement);
            // Skip over the freshly inserted nodes (none are `text` runs that
            // need re-visiting — image chips have no token children).
            i += replacement.length - 1;
          }
          continue;
        }
        visit(child);
      }
    };
    visit(tree);
  };
}

/**
 * Split a single text-node value into alternating plain-text and `imgchip`
 * element nodes. Returns null when the value contains no image reference, so
 * the caller can leave the original node untouched (the common fast path).
 */
function splitTextNode(
  value: string,
  pattern: RegExp,
): MdastNode[] | null {
  pattern.lastIndex = 0;
  let match = pattern.exec(value);
  if (!match) return null;
  const out: MdastNode[] = [];
  let cursor = 0;
  while (match) {
    const start = match.index;
    if (start > cursor) {
      out.push({ type: "text", value: value.slice(cursor, start) } as MdastTextNode);
    }
    out.push({
      type: "imageChip",
      data: { hName: "imgchip", hProperties: { imageid: match[0] } },
    });
    cursor = start + match[0].length;
    match = pattern.exec(value);
  }
  if (cursor < value.length) {
    out.push({ type: "text", value: value.slice(cursor) } as MdastTextNode);
  }
  return out;
}

const remarkPluginsWithChips = [remarkGfm, remarkImageChips];

/**
 * `componentsBase` plus a renderer for the custom `imgchip` element produced by
 * `remarkImageChips`. The key is not a real HTML tag, so we cast to satisfy the
 * `Components` map type.
 */
const componentsWithChips = {
  ...componentsBase,
  imgchip: ({ node }: { node?: { properties?: Record<string, unknown> } }) => {
    const id = node?.properties?.imageid;
    return typeof id === "string" ? <ImageChip imageId={id} /> : null;
  },
} as Components;

/** Min interval (ms) between Markdown re-parses while a message is streaming. */
const STREAM_REPARSE_MS = 80;

/**
 * Throttle a rapidly-changing string. While `ms > 0` the returned value updates
 * at most once per `ms` (leading + trailing edge), so an expensive consumer
 * (here: the full react-markdown + rehype-highlight reparse) runs at a bounded
 * rate during streaming instead of on every ~50ms delta. When `ms <= 0` the
 * latest value is returned verbatim — so the finalised message always renders
 * its complete text the moment streaming stops.
 */
function useThrottledValue(value: string, ms: number): string {
  const [out, setOut] = useState(value);
  const lastRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (ms <= 0) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    const now = Date.now();
    const elapsed = now - lastRef.current;
    if (elapsed >= ms) {
      lastRef.current = now;
      setOut(value);
    } else if (!timerRef.current) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        lastRef.current = Date.now();
        setOut(valueRef.current);
      }, ms - elapsed);
    }
  }, [value, ms]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return ms <= 0 ? value : out;
}

function MessageBody({ text, streaming }: { text: string; streaming: boolean }) {
  // While streaming, cap the reparse rate; once done, render the full text.
  const throttled = useThrottledValue(text, streaming ? STREAM_REPARSE_MS : 0);
  // Memoise the rendered element by the throttled text so identical re-renders
  // (the frequent delta-driven ones between throttle ticks) reuse the parse.
  // The whole string is rendered as ONE Markdown block; `remarkImageChips`
  // turns standalone `img_xxxx` references into <ImageChip/> via a custom
  // element AFTER parsing, so code fences / inline code that happen to contain
  // an image-id-shaped token are never split and render verbatim.
  return useMemo(
    () => (
      <Markdown
        remarkPlugins={remarkPluginsWithChips}
        rehypePlugins={rehypePlugins}
        components={componentsWithChips}
      >
        {throttled}
      </Markdown>
    ),
    [throttled],
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
            <MessageBody text={text} streaming={streaming} />
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
