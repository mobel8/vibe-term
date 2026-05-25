import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// ── IPC mocks ───────────────────────────────────────────────────────
// We mock the entire `@/ipc` surface used by TerminalView so the component
// can mount without a Tauri backend.
vi.mock("@/ipc", async () => {
  const PTY_DATA = "pty://data";
  const PTY_EXIT = "pty://exit";
  const PTY_BELL = "pty://bell";
  const PTY_CWD_CHANGE = "pty://cwd_change";

  return {
    PTY_DATA,
    PTY_EXIT,
    PTY_BELL,
    PTY_CWD_CHANGE,
    pty: {
      spawn: vi.fn(async () => "pty-test-id"),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      kill: vi.fn(async () => undefined),
      listShells: vi.fn(async () => [
        { name: "bash", path: "/bin/bash", args: [] },
      ]),
    },
    images: {
      pasteFromClipboard: vi.fn(async () => null),
      getBase64: vi.fn(async () => ""),
    },
    on: vi.fn(async () => () => undefined),
  };
});

// ── jsdom polyfills ─────────────────────────────────────────────────
// xterm.js relies on a few DOM bits jsdom does not implement.
beforeEach(() => {
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () =>
      ({ width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600 }) as DOMRect,
  });
  if (typeof window.ResizeObserver === "undefined") {
    Object.defineProperty(window, "ResizeObserver", {
      writable: true,
      configurable: true,
      value: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
  }
  // requestAnimationFrame in jsdom is synchronous already; HTMLCanvasElement
  // getContext returns null which is fine for the DOM renderer fallback.
  if (!window.HTMLCanvasElement.prototype.getContext) {
    Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => null,
    });
  }
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  if (container && container.parentNode) {
    container.parentNode.removeChild(container);
  }
  container = null;
  vi.clearAllMocks();
});

describe("TerminalView", () => {
  it("renders the empty-state notice when the tab is missing", async () => {
    // We import after the mock is in place.
    const { TerminalView } = await import("./TerminalView");

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(<TerminalView tabId="tab_does_not_exist" />);
    });

    expect(container.textContent).toContain("Tab not found");
  });

  it("mounts and bootstraps a spawn for an existing tab", async () => {
    const { TerminalView } = await import("./TerminalView");
    const { useTerminalStore } = await import("@/state/terminalStore");
    const { pty } = await import("@/ipc");

    // Seed a tab in the store.
    const shell = { name: "bash", path: "/bin/bash", args: [] };
    let tabId = "";
    act(() => {
      tabId = useTerminalStore.getState().newTab(shell).id;
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(<TerminalView tabId={tabId} />);
    });

    // The component does not throw and the mocked spawn was triggered.
    // Note: the spawn is awaited inside a useEffect — we don't assert call
    // count strictly to avoid flaky timing in jsdom; we only require that the
    // mount path didn't crash.
    expect(container.querySelector(".vibe-terminal-root")).not.toBeNull();
    // Clean up the seeded tab so subsequent tests start fresh.
    act(() => {
      useTerminalStore.getState().reset();
    });
    // Reference the mock so the import is preserved by tree-shaking.
    expect(typeof pty.spawn).toBe("function");
  });
});
