// Smoke coverage for <InlineImage/>. We avoid pulling in @testing-library —
// the project deliberately keeps its dev dependency surface narrow — and
// drive the component through React 19's `act` + a raw `createRoot` instead.
//
// What we assert here is intentionally minimal:
//   - the loading skeleton renders before the IPC resolves,
//   - the figure + badge + alt text render once the cached meta lands,
//   - the toolbar copy-id button delegates to the clipboard plugin.
// The deeper interaction matrix (lightbox open, OCR, delete) is left to
// integration / e2e tests in `tests/e2e/` where a real WebView is available.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks must be set up BEFORE we import the component under test ──

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));

// `vi.mock` factories are hoisted above any module-level `const`. Use
// `vi.hoisted` so mocks created here are available inside the factories.
const mocks = vi.hoisted(() => ({
  writeTextMock: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
  imagesGetMock: vi.fn(),
  imagesGetBase64Mock: vi.fn(),
  imagesDeleteMock: vi.fn(),
  imagesOcrMock: vi.fn(),
}));
const { writeTextMock, imagesGetMock, imagesGetBase64Mock, imagesDeleteMock, imagesOcrMock } = mocks;

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: mocks.writeTextMock,
}));

vi.mock("@/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/ipc")>("@/ipc");
  return {
    ...actual,
    images: {
      ...actual.images,
      get: mocks.imagesGetMock,
      getBase64: mocks.imagesGetBase64Mock,
      delete: mocks.imagesDeleteMock,
      ocrExtract: mocks.imagesOcrMock,
    },
  };
});

// Component + store after the mocks are registered.
import { InlineImage } from "./InlineImage";
import { useImageStore } from "@/state/imageStore";
import type { ImageMeta } from "@/ipc";

const SAMPLE: ImageMeta = {
  id: "img_abc123",
  sha256: "deadbeef",
  path: "/tmp/sample.png",
  mime: "image/png",
  width: 320,
  height: 200,
  bytes: 4096,
  source: "clipboard",
  ocrText: null,
  createdAt: 1_700_000_000,
};

let container: HTMLDivElement;
let root: Root;

async function renderInto(jsx: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(jsx);
  });
}

beforeEach(() => {
  useImageStore.getState().reset();
  writeTextMock.mockClear();
  imagesGetMock.mockReset();
  imagesGetBase64Mock.mockReset();
  imagesDeleteMock.mockReset();
  imagesOcrMock.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("<InlineImage />", () => {
  it("renders a loading skeleton while the meta resolves", async () => {
    // Pending forever so we can observe the loading branch.
    imagesGetMock.mockReturnValue(new Promise(() => undefined));

    await renderInto(<InlineImage imageId="img_pending" />);

    const skeleton = container.querySelector('[aria-busy="true"]');
    expect(skeleton).not.toBeNull();
    expect(skeleton?.textContent).toContain("loading img_pending");
  });

  it("renders the figure + badge once meta is hydrated in the store", async () => {
    // Pre-populate the store so the effect short-circuits and we render
    // the loaded branch synchronously after mount.
    useImageStore.getState().hydrate(SAMPLE);

    await renderInto(<InlineImage imageId={SAMPLE.id} />);

    const figure = container.querySelector("figure.vibe-inline-image");
    expect(figure).not.toBeNull();
    expect(figure?.getAttribute("data-image-id")).toBe(SAMPLE.id);

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toContain(
      encodeURIComponent(SAMPLE.path),
    );
    expect(img?.getAttribute("width")).toBe(String(SAMPLE.width));

    const badge = container.querySelector(
      `button[aria-label="Copy ${SAMPLE.id} to clipboard"]`,
    );
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe(SAMPLE.id);
  });

  it("hydrates from the IPC when the cache is cold", async () => {
    imagesGetMock.mockResolvedValueOnce(SAMPLE);

    await renderInto(<InlineImage imageId={SAMPLE.id} />);
    // Let the resolved promise + setState flush.
    await act(async () => {
      await Promise.resolve();
    });

    expect(imagesGetMock).toHaveBeenCalledWith(SAMPLE.id);
    expect(useImageStore.getState().cache.get(SAMPLE.id)).toEqual(SAMPLE);
    expect(container.querySelector("figure.vibe-inline-image")).not.toBeNull();
  });

  it("renders an error message when the id is unknown", async () => {
    imagesGetMock.mockResolvedValueOnce(null);
    await renderInto(<InlineImage imageId="img_ghost" />);
    await act(async () => {
      await Promise.resolve();
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("img_ghost");
    expect(alert?.textContent).toContain("not found");
  });

  it("copies the id when the badge is clicked", async () => {
    useImageStore.getState().hydrate(SAMPLE);

    await renderInto(<InlineImage imageId={SAMPLE.id} />);

    const badge = container.querySelector(
      `button[aria-label="Copy ${SAMPLE.id} to clipboard"]`,
    ) as HTMLButtonElement | null;
    expect(badge).not.toBeNull();

    await act(async () => {
      badge?.click();
    });
    // The handler awaits the writeText promise; let it settle.
    await act(async () => {
      await Promise.resolve();
    });

    expect(writeTextMock).toHaveBeenCalledWith(SAMPLE.id);
  });
});
