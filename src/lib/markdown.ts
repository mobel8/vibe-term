// Helpers used by the AI panel components to recognise inline image references
// (`img_xxxx`) inside Markdown / plain prompts and split them out from the
// surrounding text so we can render them with a custom <ImageChip/> instead of
// emitting the raw string.
//
// Image IDs are produced by `src/lib/id.ts::newImageId` — a fixed-width
// `img_` prefix followed by 6 lowercase alphanumeric characters.

/** Matches a single image id token. Kept in sync with `newImageId()`.
 * Word boundaries (`\b`) ensure we only match a STANDALONE id — without them
 * `img_handler` matched `img_handle` (6 chars) and left a stray `r`, turning
 * ordinary prose/identifiers into broken image chips. */
export const IMAGE_ID_PATTERN = /\bimg_[a-z0-9]{6}\b/g;

/** Plain-text fragment, no special rendering required. */
export interface TextFragment {
  readonly kind: "text";
  readonly text: string;
}

/** A detected `img_xxxx` reference. */
export interface ImageFragment {
  readonly kind: "image";
  readonly id: string;
}

export type MarkdownFragment = TextFragment | ImageFragment;

/**
 * Extract every distinct `img_xxxx` reference from a string, preserving the
 * order of first appearance. Returns an empty array on missing/empty input.
 */
export function extractImageIds(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(IMAGE_ID_PATTERN)) {
    const id = match[0];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Split a markdown/plain string into alternating text and image fragments.
 * Adjacent `img_xxxx` mentions become individual image fragments, and the
 * text fragments preserve the user's exact whitespace so we never silently
 * eat a space around a chip.
 */
export function splitWithImageChips(text: string): MarkdownFragment[] {
  if (!text) return [];
  const fragments: MarkdownFragment[] = [];
  let cursor = 0;
  // We deliberately re-create the regex here so we don't share state with
  // `IMAGE_ID_PATTERN` (which has the `g` flag and is reused elsewhere).
  const pattern = new RegExp(IMAGE_ID_PATTERN.source, "g");
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      fragments.push({ kind: "text", text: text.slice(cursor, start) });
    }
    fragments.push({ kind: "image", id: match[0] });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) {
    fragments.push({ kind: "text", text: text.slice(cursor) });
  }
  return fragments;
}

/**
 * Replace every `img_xxxx` reference in a Markdown string with a marker the
 * renderer can intercept (a custom HTML span). The chosen tag is `imgref` so
 * we can register a bespoke React component for it through `react-markdown`'s
 * `components` prop without colliding with native HTML.
 *
 * Returns the rewritten Markdown so it can be fed straight to `<Markdown/>`.
 */
export function markdownWithImageMarkers(text: string): string {
  if (!text) return "";
  return text.replace(IMAGE_ID_PATTERN, (id) => `<imgref id="${id}"></imgref>`);
}

/**
 * Coarse-grained sanitiser: strip leading/trailing whitespace and clamp to a
 * sane upper bound for prompt previews. Use sparingly — the streamed deltas
 * must NOT be sanitised mid-flight, only final values displayed in chips or
 * titles.
 */
export function clampPreview(text: string, max = 80): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Convert a plain `ChatMessage["content"]` array into the concatenated text
 * portion (useful for titles / search / token previews). Image blocks are
 * collapsed to a short placeholder so the result is always a string.
 */
export function contentToPlainText(
  blocks: ReadonlyArray<{ type: string; text?: string }>,
): string {
  return blocks
    .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : "[image]"))
    .join("\n")
    .trim();
}
