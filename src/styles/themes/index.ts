// vibe-term — Theme registry.
//
// This module is the single source of truth for which themes ship with the app
// and what colors xterm.js should render with for each one. The string values
// here MUST stay in sync with the CSS custom properties defined under
// `:root[data-theme="<name>"]` in the sibling `.css` files — anywhere the UI
// needs a programmatic color (e.g. xterm.js, decoration overlays) we read it
// from `XTERM_THEMES` rather than `getComputedStyle` to avoid layout thrash.

export const THEMES = [
  "dark",
  "light",
  "dracula",
  "nord",
  "tokyo-night",
] as const;

export type ThemeName = (typeof THEMES)[number];

/**
 * Subset of xterm.js `ITheme` we care about — typed structurally so we don't
 * need to import xterm types at theme-registration time (keeps the module
 * tree-shakeable and lets non-xterm consumers reuse the palette).
 */
export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export const XTERM_THEMES: Record<ThemeName, XtermTheme> = {
  dark: {
    background: "#0a0a0b",
    foreground: "#e4e4e7",
    cursor: "#7c93ff",
    cursorAccent: "#0a0a0b",
    selectionBackground: "rgba(124, 147, 255, 0.30)",
    black: "#1c1c22",
    red: "#f87171",
    green: "#4ade80",
    yellow: "#fbbf24",
    blue: "#7c93ff",
    magenta: "#c084fc",
    cyan: "#22d3ee",
    white: "#d4d4d8",
    brightBlack: "#52525b",
    brightRed: "#fca5a5",
    brightGreen: "#86efac",
    brightYellow: "#fcd34d",
    brightBlue: "#a5b4fc",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#ffffff",
  },
  light: {
    background: "#fafafa",
    foreground: "#18181b",
    cursor: "#4f46e5",
    cursorAccent: "#fafafa",
    selectionBackground: "rgba(79, 70, 229, 0.20)",
    black: "#18181b",
    red: "#dc2626",
    green: "#16a34a",
    yellow: "#ca8a04",
    blue: "#2563eb",
    magenta: "#9333ea",
    cyan: "#0891b2",
    white: "#e4e4e7",
    brightBlack: "#52525b",
    brightRed: "#ef4444",
    brightGreen: "#22c55e",
    brightYellow: "#eab308",
    brightBlue: "#3b82f6",
    brightMagenta: "#a855f7",
    brightCyan: "#06b6d4",
    brightWhite: "#f4f4f5",
  },
  dracula: {
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#bd93f9",
    cursorAccent: "#282a36",
    selectionBackground: "rgba(189, 147, 249, 0.30)",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
  nord: {
    background: "#2e3440",
    foreground: "#eceff4",
    cursor: "#88c0d0",
    cursorAccent: "#2e3440",
    selectionBackground: "rgba(136, 192, 208, 0.30)",
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#4c566a",
    brightRed: "#bf616a",
    brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4",
  },
  "tokyo-night": {
    background: "#1a1b26",
    foreground: "#c0caf5",
    cursor: "#7aa2f7",
    cursorAccent: "#1a1b26",
    selectionBackground: "rgba(122, 162, 247, 0.30)",
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#a9b1d6",
    brightBlack: "#414868",
    brightRed: "#f7768e",
    brightGreen: "#9ece6a",
    brightYellow: "#e0af68",
    brightBlue: "#7aa2f7",
    brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff",
    brightWhite: "#c0caf5",
  },
};

/** Themes that read as "dark" for `prefers-color-scheme` purposes. */
export const DARK_THEMES: ReadonlySet<ThemeName> = new Set<ThemeName>([
  "dark",
  "dracula",
  "nord",
  "tokyo-night",
]);

/** Default fallback when config has no value or an unknown one. */
export const DEFAULT_THEME: ThemeName = "dark";

/** Narrow an arbitrary string to a known ThemeName, with fallback. */
export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}
