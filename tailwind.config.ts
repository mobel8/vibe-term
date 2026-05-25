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
        // Vibe-term default dark palette (closest neutral background that
        // doesn't fight with terminal ANSI colors).
        bg: {
          DEFAULT: "#0a0a0b",
          subtle: "#111114",
          muted: "#16161a",
          elevated: "#1c1c22",
        },
        border: {
          DEFAULT: "#26262d",
          muted: "#1a1a20",
        },
        accent: {
          DEFAULT: "#7c93ff",
          subtle: "#3d4a8a",
        },
      },
    },
  },
  plugins: [],
};

export default config;
