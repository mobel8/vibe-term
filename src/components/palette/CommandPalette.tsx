// vibe-term — Command palette (Ctrl/Cmd+K).
//
// A `cmdk`-powered fuzzy launcher overlaid on top of the app. Mounts once in
// `<App>` and owns its own open state — listening on the window for the
// trigger chord, closing on `Esc` / backdrop click / item activation.
//
// Commands are pure declarative descriptors: each one points at an `onRun`
// handler that the host can wire up to its own context (e.g. `onNewTab`).
// When a handler is missing we render the item disabled so the palette still
// shows the user what's possible.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";

import { Modal } from "@/components/ui/Modal";

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
  searchHistory?: () => void;

  sendSelectionToAi?: () => void;
  newConversation?: () => void;
  toggleAiPanel?: () => void;
  switchModel?: () => void;

  pasteImage?: () => void;
  screenshotRegion?: () => void;
  screenshotFull?: () => void;

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
  /**
   * Override the default Ctrl/Cmd+K trigger — leave undefined to use the
   * built-in window listener.
   */
  trigger?: { key: string; meta?: boolean; ctrl?: boolean; shift?: boolean };
  /** Render-time hook so storybook/tests can force the palette open. */
  defaultOpen?: boolean;
}

export function CommandPalette({
  handlers = {},
  trigger,
  defaultOpen = false,
}: CommandPaletteProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [search, setSearch] = useState("");

  // Window-level trigger.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const wantKey = (trigger?.key ?? "k").toLowerCase();
      if (k !== wantKey) return;
      const wantMeta = trigger ? !!trigger.meta : false;
      const wantCtrl = trigger ? !!trigger.ctrl : true;
      // Default Ctrl/Cmd+K: accept either modifier so the chord works on both
      // platforms without per-OS branching.
      const accepted = trigger
        ? (!!wantMeta === e.metaKey) && (!!wantCtrl === e.ctrlKey) &&
          (!trigger.shift === !e.shiftKey)
        : (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
      if (!accepted) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [trigger]);

  const close = useCallback(() => {
    setOpen(false);
    // Clear the search input so reopening starts fresh.
    setSearch("");
  }, []);

  const commands = useMemo<CommandDescriptor[]>(
    () => [
      // ── Terminal ──
      {
        id: "tab.new",
        label: "New terminal tab",
        group: "terminal",
        icon: "+",
        shortcut: "Ctrl+Shift+T",
        keywords: ["spawn", "open", "shell"],
        onRun: handlers.newTab,
      },
      {
        id: "tab.close",
        label: "Close terminal tab",
        group: "terminal",
        icon: "×",
        shortcut: "Ctrl+Shift+W",
        keywords: ["kill", "exit"],
        onRun: handlers.closeTab,
      },
      {
        id: "split.horizontal",
        label: "Split pane horizontally",
        group: "terminal",
        icon: "▤",
        shortcut: "Ctrl+Shift+D",
        keywords: ["pane", "stack"],
        onRun: handlers.splitHorizontal,
      },
      {
        id: "split.vertical",
        label: "Split pane vertically",
        group: "terminal",
        icon: "▥",
        shortcut: "Ctrl+Shift+E",
        onRun: handlers.splitVertical,
      },
      {
        id: "terminal.clear",
        label: "Clear terminal",
        group: "terminal",
        icon: "↻",
        shortcut: "Ctrl+L",
        keywords: ["reset", "wipe"],
        onRun: handlers.clearTerminal,
      },
      {
        id: "terminal.search",
        label: "Search scrollback",
        group: "terminal",
        icon: "⌕",
        shortcut: "Ctrl+F",
        keywords: ["find", "grep"],
        onRun: handlers.searchHistory,
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
        shortcut: "Ctrl+Shift+A",
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
        shortcut: "Ctrl+Shift+S",
        keywords: ["snip", "capture"],
        onRun: handlers.screenshotRegion,
      },
      {
        id: "image.screenshot-full",
        label: "Screenshot full screen",
        group: "image",
        icon: "▢",
        keywords: ["snip", "monitor"],
        onRun: handlers.screenshotFull,
      },

      // ── Settings ──
      {
        id: "settings.open",
        label: "Open settings",
        group: "settings",
        icon: "⚙",
        shortcut: "Ctrl+,",
        onRun: handlers.openSettings,
      },
      {
        id: "settings.theme",
        label: "Switch theme",
        group: "settings",
        icon: "◐",
        shortcut: "Ctrl+Shift+L",
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
    [handlers],
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
            className="w-full bg-transparent font-mono text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
          />
        </div>
        <Command.List className="flex-1 overflow-y-auto px-2 py-2">
          <Command.Empty className="px-3 py-6 text-center font-mono text-xs text-zinc-500">
            No matching commands.
          </Command.Empty>
          {GROUP_ORDER.map((g) => {
            const items = grouped.get(g);
            if (!items || items.length === 0) return null;
            return (
              <Command.Group
                key={g}
                heading={GROUP_LABELS[g]}
                className="mb-2 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-zinc-500"
              >
                {items.map((cmd) => (
                  <Command.Item
                    key={cmd.id}
                    value={cmd.id}
                    keywords={cmd.keywords}
                    onSelect={runCommand}
                    disabled={!cmd.onRun}
                    className="flex cursor-pointer items-center gap-3 rounded px-3 py-1.5 font-mono text-sm text-zinc-300 aria-selected:bg-accent/15 aria-selected:text-zinc-50 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-40"
                  >
                    {cmd.icon && (
                      <span aria-hidden className="w-4 text-center text-accent/80">
                        {cmd.icon}
                      </span>
                    )}
                    <span className="flex-1 truncate">{cmd.label}</span>
                    {cmd.shortcut && (
                      <kbd className="rounded border border-border bg-bg-elevated px-1.5 py-0.5 text-[10px] text-zinc-400">
                        {cmd.shortcut}
                      </kbd>
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
            );
          })}
        </Command.List>
        <footer className="border-t border-border px-4 py-2 font-mono text-[11px] text-zinc-500">
          <span className="mr-3">↑↓ navigate</span>
          <span className="mr-3">↵ run</span>
          <span>Esc close</span>
        </footer>
      </Command>
    </Modal>
  );
}

export default CommandPalette;
