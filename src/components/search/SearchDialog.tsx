// vibe-term — Search dialog (Ctrl+R / Cmd+R).
//
// FTS5-backed full-text search over the persisted blocks. Mounted at the
// `Layout` level and toggled via the `Ctrl+R` window-level shortcut.
//
// Behaviour:
// - Debounced query (180 ms) so we don't spam the SQLite FTS index while the
//   user is still typing.
// - Empty input ⇒ no request (the backend would return everything).
// - Results show the highlighted snippet from the server (which already
//   wraps matches in `<mark>` tags). We render them as plain text + a small
//   colour highlight so the dialog doesn't have to trust raw HTML.
// - Arrow keys navigate; Enter selects (currently a no-op since we do not
//   yet expose a "jump to block" route — a TODO log keeps it visible until
//   the block routing lands).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { store as storeIpc, type SearchHit } from "@/ipc";
import { Modal } from "@/components/ui/Modal";

interface SearchDialogProps {
  open: boolean;
  onClose: () => void;
}

const DEBOUNCE_MS = 180;
const MAX_RESULTS = 50;

/**
 * Splits a server snippet on `<mark>…</mark>` boundaries so we can render
 * highlights without trusting raw HTML.
 */
function renderSnippet(snippet: string): Array<{ text: string; highlight: boolean }> {
  const parts: Array<{ text: string; highlight: boolean }> = [];
  const re = /<mark>(.*?)<\/mark>/g;
  let lastIndex = 0;
  let match;
  while ((match = re.exec(snippet)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: snippet.slice(lastIndex, match.index), highlight: false });
    }
    parts.push({ text: match[1], highlight: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < snippet.length) {
    parts.push({ text: snippet.slice(lastIndex), highlight: false });
  }
  return parts;
}

export function SearchDialog({ open, onClose }: SearchDialogProps) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset when the modal toggles.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setHits([]);
      setError(null);
      setSelected(0);
    }
  }, [open]);

  // Debounced query → searchFts.
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setHits([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const handle = window.setTimeout(() => {
      storeIpc
        .searchFts(trimmed, null, MAX_RESULTS)
        .then((rows) => {
          if (cancelled) return;
          setHits(rows);
          setSelected(0);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setHits([]);
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [open, query]);

  // Keyboard navigation inside the input.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((cur) => Math.min(cur + 1, Math.max(hits.length - 1, 0)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((cur) => Math.max(cur - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const hit = hits[selected];
        if (hit) {
          // Block-routing is not yet wired up — log a hint so the dev sees the
          // intent. The UI feedback we give is to close the dialog.
          console.info("[search] selected block", hit.blockId, "(routing pending)");
          onClose();
        }
      }
    },
    [hits, selected, onClose],
  );

  const summary = useMemo(() => {
    if (!query.trim()) return "Type to search across every persisted command output.";
    if (loading) return "Searching…";
    if (error) return `Error: ${error}`;
    if (hits.length === 0) return "No matches.";
    return `${hits.length} match${hits.length === 1 ? "" : "es"}`;
  }, [query, loading, error, hits.length]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="search-title"
      panelClassName="flex h-[60vh] max-h-[560px] w-[92vw] max-w-2xl flex-col overflow-hidden"
      backdropClassName="items-start pt-[12vh]"
    >
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
        <h2 id="search-title" className="sr-only">
          Search scrollback
        </h2>
        <input
          ref={inputRef}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search blocks (FTS5)…"
          className="w-full bg-transparent font-mono text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
        />
        <p className="text-[11px] text-zinc-500">{summary}</p>
      </div>

      <ul className="flex-1 overflow-y-auto px-2 py-2">
        {hits.map((hit, idx) => {
          const parts = renderSnippet(hit.snippet);
          return (
            <li key={hit.blockId}>
              <button
                type="button"
                onClick={() => {
                  setSelected(idx);
                  console.info("[search] selected block", hit.blockId, "(routing pending)");
                  onClose();
                }}
                className={
                  "flex w-full flex-col gap-1 rounded px-3 py-2 text-left font-mono text-xs " +
                  (idx === selected
                    ? "bg-accent/15 text-zinc-50"
                    : "text-zinc-300 hover:bg-bg-elevated/50")
                }
              >
                <span className="truncate text-[11px] text-zinc-500">
                  session {hit.sessionId} · block {hit.blockId}
                </span>
                <span className="whitespace-pre-wrap break-words">
                  {parts.map((p, i) =>
                    p.highlight ? (
                      <mark key={i} className="rounded bg-amber-300/20 px-0.5 text-amber-200">
                        {p.text}
                      </mark>
                    ) : (
                      <span key={i}>{p.text}</span>
                    ),
                  )}
                </span>
                <span className="text-[10px] text-zinc-600">rank {hit.rank.toFixed(2)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

export default SearchDialog;
