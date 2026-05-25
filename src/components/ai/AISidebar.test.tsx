// Smoke test for <AISidebar/>. We mount the component into a real jsdom
// document via react-dom/client and assert on the resulting DOM. Tauri IPC
// calls are mocked at the @tauri-apps/api level so the bridge never reaches
// out to a backend that does not exist in the test environment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────
const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
const listenMock = vi.fn(async () => () => {
  /* unlisten */
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) =>
    listenMock(...(args as Parameters<typeof listenMock>)),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(async () => undefined),
}));

// Stub `react-markdown` so the test doesn't pull a huge ESM dep tree just for
// a smoke check — the markdown branch is exercised in dedicated tests.
vi.mock("react-markdown", () => ({
  default: ({ children }: { children?: unknown }) => (
    <div data-testid="md">{String(children ?? "")}</div>
  ),
}));
vi.mock("rehype-highlight", () => ({ default: () => () => undefined }));
vi.mock("remark-gfm", () => ({ default: () => () => undefined }));

// We import the component AFTER the mocks have been registered.
import { AISidebar } from "./AISidebar";
import { useAiStore } from "@/state/aiStore";

function flush() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function mount(node: React.ReactElement): Promise<{
  container: HTMLDivElement;
  root: Root;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return { container, root };
}

async function unmount(root: Root, container: HTMLDivElement) {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

beforeEach(() => {
  invokeMock.mockReset();
  // Default to "no API key" so the mount-time `ai.hasKey()` always resolves
  // even when an individual test doesn't override the mock. The closed-panel
  // test never sets an implementation, but the component still fires the
  // `ai_has_api_key` invoke during its boot effect.
  invokeMock.mockImplementation(async (cmd) => {
    if (cmd === "ai_has_api_key") return false;
    return undefined;
  });
  listenMock.mockClear();
  // Reset Zustand state so each test gets a clean slate.
  useAiStore.setState({
    conversations: {},
    order: [],
    activeConversationId: null,
    stagingImages: [],
    isOpen: false,
    hasApiKey: null,
  });
});

afterEach(() => {
  // jsdom hangs across tests if any selection style was left around.
  document.body.style.userSelect = "";
});

describe("<AISidebar/>", () => {
  it("renders nothing while the panel is closed", async () => {
    const { container, root } = await mount(<AISidebar />);
    expect(container.querySelector("[data-testid='ai-sidebar']")).toBeNull();
    await unmount(root, container);
  });

  it("shows the onboarding modal when no API key is stored", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "ai_has_api_key") return false;
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    useAiStore.getState().togglePanel(true);

    const { container, root } = await mount(<AISidebar />);
    await act(async () => {
      await flush();
    });

    expect(container.querySelector("[data-testid='ai-sidebar']")).not.toBeNull();
    expect(container.querySelector("[role='dialog']")).not.toBeNull();
    expect(container.textContent).toContain("Connect to Claude");

    await unmount(root, container);
  });

  it("shows the empty-state placeholder when a key is present and the conversation is empty", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "ai_has_api_key") return true;
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    useAiStore.getState().togglePanel(true);

    const { container, root } = await mount(<AISidebar />);
    await act(async () => {
      await flush();
    });

    // The onboarding modal should NOT be present.
    expect(container.querySelector("[role='dialog']")).toBeNull();
    // The empty conversation placeholder should be.
    const messages = container.querySelector("[data-testid='ai-messages']");
    expect(messages?.textContent).toContain("Start a conversation");

    await unmount(root, container);
  });

  it("attaches AI event listeners while mounted and detaches on unmount", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "ai_has_api_key") return true;
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    const unlisten = vi.fn();
    listenMock.mockImplementation(async () => unlisten);

    useAiStore.getState().togglePanel(true);
    const { container, root } = await mount(<AISidebar />);
    await act(async () => {
      await flush();
    });

    // delta + complete + error
    expect(listenMock).toHaveBeenCalledTimes(3);

    await unmount(root, container);
    expect(unlisten).toHaveBeenCalledTimes(3);
  });
});
