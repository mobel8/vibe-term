// vibe-term — Command palette (Ctrl/Cmd+K, rebindable as `command_palette`).
//
// A `cmdk`-powered fuzzy launcher overlaid on top of the app. Mounts once in
// `<App>` and owns its own open state. The toggle chord is dispatched by the
// app-level capture-phase hotkey dispatcher (Layout) through the hotkeys
// store — the palette registers a `command_palette` handler instead of
// installing its own window listener, so rebinding it in Settings works and
// there is exactly ONE key-dispatch surface.
//
// Commands are pure declarative descriptors: each one points at an `onRun`
// handler that the host can wire up to its own context (e.g. `onNewTab`).
// When a handler is missing we render the item disabled so the palette still
// shows the user what's possible. Shortcut hints are derived from the LIVE
// binding table, so they can never contradict what the keys actually do.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";

import { Modal } from "@/components/ui/Modal";
import { useHotkeysStore } from "@/state/hotkeysStore";

export interface CommandDescriptor {
  /** Stable id used as the cmdk value (also doubles as analytics handle). */
  id: string;
  label: string;
  group: PaletteGroup;
  /** Optional one-character glyph rendered on the left side of the row. */
  icon?: string;
  /** Hint shown in muted text on the right (typically a keyboard shortcut). */
  shortcut?: string;
  /** Extra fuzzy-search keywords beyond `label`. */
  keywords?: string[];
  onRun?: () => void | Promise<void>;
}

export type PaletteGroup =
  | "terminal"
  | "ai"
  | "image"
  | "settings"
  | "help";

const GROUP_LABELS: Record<PaletteGroup, string> = {
  terminal: "Terminal",
  ai: "AI",
  image: "Image",
  settings: "Settings",
  help: "Help",
};

const GROUP_ORDER: PaletteGroup[] = ["terminal", "ai", "image", "settings", "help"];

/**
 * Optional handler bag the host application passes in. Every action is
 * optional — the palette renders unwired items as disabled placeholders.
 */
export interface PaletteHandlers {
  newTab?: () => void;
  closeTab?: () => void;
  splitHorizontal?: () => void;
  splitVertical?: () => void;
  clearTerminal?: () => void;
  /** Rewind leaked terminal modes (mouse tracking, bracketed paste, alt screen). */
  resetTerminal?: () => void;
  searchHistory?: () => void;

  sendSelectionToAi?: () => void;
  newConversation?: () => void;
  toggleAiPanel?: () => void;
  switchModel?: () => void;

  pasteImage?: () => void;
  screenshotRegion?: () => void;
  screenshotFull?: () => void;

  /** Export the most recent session as a Markdown file (Tauri save dialog). */
  exportSessionMarkdown?: () => void;
  /** Export the most recent session as a self-contained HTML file. */
  exportSessionHtml?: () => void;

  openSettings?: () => void;
  switchTheme?: () => void;
  openConfigFile?: () => void;
  openLogs?: () => void;

  openDocs?: () => void;
  openShortcuts?: () => void;
  openAbout?: () => void;
}

export interface CommandPaletteProps {
  handlers?: PaletteHandlers;
  /** Live action→combo table used to render truthful shortcut hints. */
  bindings?: Record<string, string>;
  /** Render-time hook so storybook/tests can force the palette open. */
  defaultOpen?: boolean;
}

export function CommandPalette({
  handlers = {},
  bindings = {},
  defaultOpen = false,
}: CommandPaletteProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [search, setSearch] = useState("");

  // Toggle arrives through the hotkeys registry (dispatched by the Layout
  // capture handler with whatever combo `command_palette` is bound to).
  useEffect(() => {
    return useHotkeysStore.getState().register("command_palette", () => {
      // Mirror close()'s behaviour when the chord dismisses the palette so the
      // search input resets, matching every other close path.
      setOpen((o) => {
        if (o) setSearch("");
        return !o;
      });
    });
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    // Clear the search input so reopening starts fresh.
    setSearch("");
  }, []);

  // Shortcut hints come from the LIVE binding table so they always tell the
  // truth, including after a rebind. Actions with no binding show no hint.
  const combo = useCallback(
    (action: string): string | undefined => bindings[action] || undefined,
    [bindings],
  );

  const commands = useMemo<CommandDescriptor[]>(
    () => [
      // ── Terminal ──
      {
        id: "tab.new",
        label: "New terminal tab",
        group: "terminal",
        icon: "+",
        shortcut: combo("new_tab"),
        keywords: ["spawn", "open", "shell"],
        onRun: handlers.newTab,
      },
      {
        id: "tab.close",
        label: "Close terminal tab",
        group: "terminal",
        icon: "×",
        shortcut: combo("close_tab"),
        keywords: ["kill", "exit"],
        onRun: handlers.closeTab,
      },
      {
        id: "split.horizontal",
        label: "Split pane horizontally",
        group: "terminal",
        icon: "▤",
        shortcut: combo("split_horizontal"),
        keywords: ["pane", "side by side"],
        onRun: handlers.splitHorizontal,
      },
      {
        id: "split.vertical",
        label: "Split pane vertically",
        group: "terminal",
        icon: "▥",
        shortcut: combo("split_vertical"),
        keywords: ["pane", "stack"],
        onRun: handlers.splitVertical,
      },
      {
        id: "terminal.clear",
        label: "Clear terminal",
        group: "terminal",
        icon: "↻",
        shortcut: combo("clear_terminal"),
        keywords: ["wipe", "cls"],
        onRun: handlers.clearTerminal,
      },
      {
        id: "terminal.reset",
        label: "Reset terminal state",
        group: "terminal",
        icon: "⟳",
        shortcut: combo("reset_terminal"),
        keywords: ["stuck", "mouse", "garbled", "modes", "scroll", "frozen"],
        onRun: handlers.resetTerminal,
      },
      {
        id: "terminal.search",
        label: "Search scrollback",
        group: "terminal",
        icon: "⌕",
        shortcut: combo("search_history"),
        keywords: ["find", "grep"],
        onRun: handlers.searchHistory,
      },
      {
        id: "session.export-markdown",
        label: "Export session as Markdown…",
        group: "terminal",
        icon: "↗",
        keywords: ["save", "download", "md"],
        onRun: handlers.exportSessionMarkdown,
      },
      {
        id: "session.export-html",
        label: "Export session as HTML…",
        group: "terminal",
        icon: "↗",
        keywords: ["save", "download"],
        onRun: handlers.exportSessionHtml,
      },

      // ── AI ──
      {
        id: "ai.send-selection",
        label: "Send selection to Claude",
        group: "ai",
        icon: "→",
        keywords: ["assistant", "ask"],
        onRun: handlers.sendSelectionToAi,
      },
      {
        id: "ai.new-conversation",
        label: "New conversation",
        group: "ai",
        icon: "+",
        keywords: ["reset", "context"],
        onRun: handlers.newConversation,
      },
      {
        id: "ai.toggle",
        label: "Toggle AI panel",
        group: "ai",
        icon: "✦",
        shortcut: combo("toggle_ai_panel"),
        onRun: handlers.toggleAiPanel,
      },
      {
        id: "ai.switch-model",
        label: "Switch model",
        group: "ai",
        icon: "Ⓜ",
        keywords: ["opus", "sonnet", "haiku"],
        onRun: handlers.switchModel,
      },

      // ── Image ──
      {
        id: "image.paste",
        label: "Paste image from clipboard",
        group: "image",
        icon: "⎙",
        shortcut: "Ctrl+V",
        keywords: ["clipboard"],
        onRun: handlers.pasteImage,
      },
      {
        id: "image.screenshot-region",
        label: "Screenshot region",
        group: "image",
        icon: "▭",
        shortcut: combo("screenshot_region"),
        keywords: ["snip", "capture"],
        onRun: handlers.screenshotRegion,
      },
      {
        id: "image.screenshot-full",
        label: "Screenshot full screen",
        group: "image",
        icon: "▢",
        shortcut: combo("screenshot_full"),
        keywords: ["snip", "monitor"],
        onRun: handlers.screenshotFull,
      },

      // ── Settings ──
      {
        id: "settings.open",
        label: "Open settings",
        group: "settings",
        icon: "⚙",
        shortcut: combo("open_settings"),
        onRun: handlers.openSettings,
      },
      {
        id: "settings.theme",
        label: "Switch theme (light/dark)",
        group: "settings",
        icon: "◐",
        keywords: ["color", "dark", "light"],
        onRun: handlers.switchTheme,
      },
      {
        id: "settings.config",
        label: "Open config.toml",
        group: "settings",
        icon: "⌥",
        keywords: ["toml", "file"],
        onRun: handlers.openConfigFile,
      },
      {
        id: "settings.logs",
        label: "Open logs folder",
        group: "settings",
        icon: "▤",
        keywords: ["debug", "log"],
        onRun: handlers.openLogs,
      },

      // ── Help ──
      {
        id: "help.docs",
        label: "Documentation",
        group: "help",
        icon: "?",
        onRun: handlers.openDocs,
      },
      {
        id: "help.shortcuts",
        label: "Keyboard shortcuts",
        group: "help",
        icon: "⌘",
        onRun: handlers.openShortcuts,
      },
      {
        id: "help.about",
        label: "About vibe-term",
        group: "help",
        icon: "ⓘ",
        onRun: handlers.openAbout,
      },
    ],
    [handlers, combo],
  );

  const grouped = useMemo(() => {
    const map = new Map<PaletteGroup, CommandDescriptor[]>();
    for (const cmd of commands) {
      const arr = map.get(cmd.group) ?? [];
      arr.push(cmd);
      map.set(cmd.group, arr);
    }
    return map;
  }, [commands]);

  const runCommand = useCallback(
    (value: string) => {
      const cmd = commands.find((c) => c.id === value);
      if (!cmd?.onRun) return;
      // Close before running so the handler can synchronously open another
      // modal (e.g. settings) without the palette stealing focus.
      close();
      try {
        const out = cmd.onRun();
        if (out && typeof (out as Promise<unknown>).catch === "function") {
          (out as Promise<unknown>).catch((err) => {
            console.warn("[palette] command failed:", cmd.id, err);
          });
        }
      } catch (err) {
        console.warn("[palette] command threw:", cmd.id, err);
      }
    },
    [close, commands],
  );

  return (
    <Modal
      open={open}
      onClose={close}
      labelledBy="palette-title"
      panelClassName="flex h-[60vh] max-h-[560px] w-[92vw] max-w-xl flex-col overflow-hidden"
      backdropClassName="items-start pt-[12vh]"
    >
      <Command
        label="Command palette"
        value=""
        onValueChange={() => {
          /* selection is managed internally; we only listen for onSelect. */
        }}
        className="flex h-full flex-col"
      >
        <div className="border-b border-border px-4 py-3">
          <h2 id="palette-title" className="sr-only">
            Command palette
          </h2>
          <Command.Input
            autoFocus
            placeholder="Type a command…"
            value={search}
            onValueChange={setSearch}
            className="w-full bg-transparent font-mono text-sm text-fg placeholder:text-fg-subtle focus:outline-none"
          />
        </div>
        <Command.List className="flex-1 overflow-y-auto px-2 py-2">
          <Command.Empty className="px-3 py-6 text-center font-mono text-xs text-fg-subtle">
            No matching commands.
          </Command.Empty>
          {GROUP_ORDER.map((g) => {
            const items = grouped.get(g);
            if (!items || items.length === 0) return null;
            return (
              <Command.Group
                key={g}
                heading={GROUP_LABELS[g]}
                className="mb-2 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-fg-subtle"
              >
                {items.map((cmd) => (
                  <Command.Item
                    key={cmd.id}
                    value={cmd.id}
                    keywords={[cmd.label, ...(cmd.keywords ?? [])]}
                    onSelect={runCommand}
                    disabled={!cmd.onRun}
                    className="flex cursor-pointer items-center gap-3 rounded px-3 py-1.5 font-mono text-sm text-fg-muted aria-selected:bg-accent/15 aria-selected:text-fg data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-40"
                  >
                    {cmd.icon && (
                      <span aria-hidden className="w-4 text-center text-accent/80">
                        {cmd.icon}
                      </span>
                    )}
                    <span className="flex-1 truncate">{cmd.label}</span>
                    {cmd.shortcut && (
                      <kbd className="rounded border border-border bg-bg-elevated px-1.5 py-0.5 text-[10px] text-fg-muted">
                        {cmd.shortcut}
                      </kbd>
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
            );
          })}
        </Command.List>
        <footer className="border-t border-border px-4 py-2 font-mono text-[11px] text-fg-subtle">
          <span className="mr-3">↑↓ navigate</span>
          <span className="mr-3">↵ run</span>
          <span>Esc close</span>
        </footer>
      </Command>
    </Modal>
  );
}

export default CommandPalette;
