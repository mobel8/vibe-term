import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        mono: [
          "JetBrains Mono",
          "Geist Mono",
          "Menlo",
          "Monaco",
          "Consolas",
          "Liberation Mono",
          "Courier New",
          "monospace",
        ],
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
      colors: {
        // Theme-driven tokens. Every value reads the `--vt-*-rgb` channel
        // variables that each theme stylesheet (src/styles/themes/*.css)
        // defines under `:root[data-theme="…"]` — hardcoding hex here was THE
        // reason the light/dracula/nord themes only ever recolored the
        // terminal canvas while all the chrome stayed dark. The `<alpha-value>`
        // slot keeps Tailwind opacity modifiers (bg-accent/15 …) working; the
        // fallback channels are the dark palette so a missing variable can
        // never render unstyled.
        bg: {
          DEFAULT: "rgb(var(--vt-bg-rgb, 10 10 11) / <alpha-value>)",
          subtle: "rgb(var(--vt-bg-subtle-rgb, 17 17 20) / <alpha-value>)",
          muted: "rgb(var(--vt-bg-muted-rgb, 22 22 26) / <alpha-value>)",
          elevated: "rgb(var(--vt-bg-elevated-rgb, 28 28 34) / <alpha-value>)",
        },
        border: {
          DEFAULT: "rgb(var(--vt-border-rgb, 38 38 45) / <alpha-value>)",
          muted: "rgb(var(--vt-border-muted-rgb, 26 26 32) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--vt-accent-rgb, 124 147 255) / <alpha-value>)",
          subtle: "rgb(var(--vt-accent-subtle-rgb, 61 74 138) / <alpha-value>)",
          // Text/icon color that stays readable ON an accent surface.
          fg: "rgb(var(--vt-accent-fg-rgb, 255 255 255) / <alpha-value>)",
        },
        // Foreground scale for chrome text — replaces the hardcoded zinc
        // literals that were unreadable outside the dark theme.
        fg: {
          DEFAULT: "rgb(var(--vt-fg-rgb, 228 228 231) / <alpha-value>)",
          muted: "rgb(var(--vt-fg-muted-rgb, 156 163 175) / <alpha-value>)",
          subtle: "rgb(var(--vt-fg-subtle-rgb, 107 114 128) / <alpha-value>)",
        },
      },
    },
  },
  plugins: [],
};

export default config;
