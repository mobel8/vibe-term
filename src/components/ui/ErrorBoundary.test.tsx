// vibe-term — ErrorBoundary tests.
//
// We deliberately do not pull in @testing-library to keep the dev surface
// small. Instead we drive the boundary with React's own createRoot + the
// standard `act` from `react`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// Mock the clipboard helpers so we can assert on what gets copied without
// touching navigator/Tauri APIs.
vi.mock("@/lib/clipboard", () => ({
  copyText: vi.fn(async () => true),
}));

// Mock the logger so we can verify the boundary reports through it. The
// `vi.hoisted` indirection is required because `vi.mock` is hoisted above
// every other top-level statement — referencing a normal `const` from
// inside the factory would crash with a TDZ error.
const { errorMock } = vi.hoisted(() => ({ errorMock: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: errorMock,
  },
}));

import { copyText } from "@/lib/clipboard";
import { ErrorBoundary, type ErrorBoundaryFallbackProps } from "./ErrorBoundary";

/** A component that throws on render — the canonical boundary trigger. */
function Boom({ message = "kaboom" }: { message?: string }): ReactNode {
  throw new Error(message);
}

/** A component that renders fine, used to verify the happy path. */
function Healthy(): ReactNode {
  return <div data-testid="healthy">ok</div>;
}

describe("ErrorBoundary", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalError: typeof console.error;

  beforeEach(() => {
    // React logs a noisy error to the console whenever a boundary catches.
    // We silence it for the duration of these tests so the runner output
    // stays readable — we still assert behaviour through our own logger
    // mock, so this loses no signal.
    originalError = console.error;
    console.error = vi.fn();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    vi.mocked(copyText).mockClear();
    vi.mocked(copyText).mockResolvedValue(true);
    errorMock.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
    console.error = originalError;
  });

  it("renders children untouched on the happy path", () => {
    act(() => {
      root.render(
        <ErrorBoundary>
          <Healthy />
        </ErrorBoundary>,
      );
    });
    expect(
      container.querySelector("[data-testid='healthy']")?.textContent,
    ).toBe("ok");
    expect(
      container.querySelector("[data-testid='error-boundary-fallback']"),
    ).toBeNull();
  });

  it("renders the default fallback when a child throws and logs the error", () => {
    act(() => {
      root.render(
        <ErrorBoundary>
          <Boom message="render exploded" />
        </ErrorBoundary>,
      );
    });

    const fallback = container.querySelector(
      "[data-testid='error-boundary-fallback']",
    );
    expect(fallback).not.toBeNull();
    expect(fallback?.textContent).toContain("Something went wrong");
    expect(fallback?.textContent).toContain("render exploded");
    // Error ID is the 6-char nano id rendered next to the title.
    expect(fallback?.textContent).toMatch(/Error ID:\s*[a-z0-9]{6}/);

    expect(errorMock).toHaveBeenCalledTimes(1);
    const [scope, message, meta] = errorMock.mock.calls[0] ?? [];
    expect(scope).toBe("react");
    expect(message).toBe("render exploded");
    expect(meta).toMatchObject({
      stack: expect.any(String),
      errorId: expect.stringMatching(/^[a-z0-9]{6}$/),
    });
  });

  it("Copy report writes a JSON payload with the right fields", async () => {
    act(() => {
      root.render(
        <ErrorBoundary>
          <Boom message="please copy me" />
        </ErrorBoundary>,
      );
    });

    const button = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.includes("Copy report"));
    expect(button).toBeDefined();

    await act(async () => {
      button!.click();
    });

    expect(copyText).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(copyText).mock.calls[0]?.[0];
    expect(typeof payload).toBe("string");

    const parsed = JSON.parse(payload as string) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      id: expect.stringMatching(/^[a-z0-9]{6}$/),
      msg: "please copy me",
      stack: expect.any(String),
      ua: expect.any(String),
      ts: expect.any(Number),
    });
    // `componentStack` may be a string or null depending on React's debug
    // build — we accept either but the key must exist.
    expect("componentStack" in parsed).toBe(true);
  });

  it("Continue resets the boundary so healthy children render again", () => {
    // We render a toggle so the second pass swaps Boom for Healthy: it would
    // be unfair to test recovery while still feeding the boundary a broken
    // subtree.
    let crash = true;
    function Toggle(): ReactNode {
      return crash ? <Boom /> : <Healthy />;
    }

    act(() => {
      root.render(
        <ErrorBoundary>
          <Toggle />
        </ErrorBoundary>,
      );
    });
    expect(
      container.querySelector("[data-testid='error-boundary-fallback']"),
    ).not.toBeNull();

    crash = false;
    const continueBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent === "Continue");
    expect(continueBtn).toBeDefined();

    act(() => {
      continueBtn!.click();
    });

    expect(
      container.querySelector("[data-testid='error-boundary-fallback']"),
    ).toBeNull();
    expect(
      container.querySelector("[data-testid='healthy']")?.textContent,
    ).toBe("ok");
  });

  it("uses a custom fallback render prop when provided", () => {
    const customFallback = (props: ErrorBoundaryFallbackProps): ReactNode => (
      <div data-testid="custom-fallback">id={props.report.id}</div>
    );

    act(() => {
      root.render(
        <ErrorBoundary fallback={customFallback}>
          <Boom />
        </ErrorBoundary>,
      );
    });

    const custom = container.querySelector("[data-testid='custom-fallback']");
    expect(custom).not.toBeNull();
    expect(custom?.textContent).toMatch(/id=[a-z0-9]{6}/);
    // The default fallback must not have been rendered alongside.
    expect(
      container.querySelector("[data-testid='error-boundary-fallback']"),
    ).toBeNull();
  });
});
