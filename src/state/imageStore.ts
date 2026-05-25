// Image state — pure client cache. The backend remains the source of truth
// (every `ImageMeta` is also persisted to `~/.local/share/glaive/images.db` via
// the Rust `images` module), and this store exists only so React subscribers
// can read the metadata synchronously without hitting IPC every render.
//
// What lives here:
//   - `cache`: imageId → ImageMeta map. Populated on the fly by `hydrate()`,
//     either from a fresh `images.get()` round trip (see `InlineImage`'s mount
//     effect) or from an `image://added` event listener wired at the App level.
//   - `lightboxId`: nullable id of the image currently shown in the modal
//     viewer. Only one lightbox at a time — we keep it global so any component
//     can trigger it (toolbar, palette, AI message) without prop-drilling.
//   - `isDragOver`: drives the `<DropZoneOverlay/>`. The Tauri WindowEvent::
//     FileDrop fires on the backend and re-emits IMAGE_ADDED, so the overlay
//     itself never sees the raw FileList — it's purely a visual cue updated by
//     the DOM dragenter/dragleave listeners on `document`.
//
// Why Zustand without persist:
//   The images.db on the backend already survives restarts. Caching ImageMeta
//   here is just a render-time perf optimisation; persisting it would risk
//   showing stale entries after a backend cleanup pass.

import { create } from "zustand";

import type { ImageId, ImageMeta } from "@/ipc";

export interface ImageState {
  /** imageId → metadata. Cleared on `reset()` (rare, mostly tests). */
  cache: Map<ImageId, ImageMeta>;
  /** Id of the image currently shown by `<Lightbox/>` or null when closed. */
  lightboxId: ImageId | null;
  /** True when the user is dragging a file over the window. */
  isDragOver: boolean;

  // ── Actions ─────────────────────────────────────────────────────────

  /** Insert or update an entry. No-op when the meta is already present and
   * structurally equal (avoids re-renders on re-emitted events). */
  hydrate(meta: ImageMeta): void;
  /** Remove an entry — used after `images.delete()` succeeds so the UI drops
   * the image from any view that subscribed to it. Also clears the lightbox
   * if it pointed at the removed id. */
  remove(id: ImageId): void;
  /** Bulk insert — used by callers that fetch multiple meta in one shot
   * (e.g. when listing all images attached to a tab). */
  hydrateMany(metas: readonly ImageMeta[]): void;
  /** Open / close the modal viewer. Pass `null` to dismiss. */
  setLightbox(id: ImageId | null): void;
  /** Toggle the drag-over visual cue. */
  setDragOver(b: boolean): void;
  /** Convenience accessor — returns null when the id was never hydrated. */
  get(id: ImageId): ImageMeta | null;
  /** Wipe the cache (only the test harness should call this). */
  reset(): void;
}

/**
 * Cheap structural equality on ImageMeta. We only compare fields the UI
 * actually re-renders on — paths, dimensions and OCR text. Avoids deep clones
 * just to bust the React shallow comparison.
 */
function isSameMeta(a: ImageMeta, b: ImageMeta): boolean {
  return (
    a.id === b.id &&
    a.path === b.path &&
    a.width === b.width &&
    a.height === b.height &&
    a.bytes === b.bytes &&
    a.mime === b.mime &&
    a.ocrText === b.ocrText
  );
}

export const useImageStore = create<ImageState>((set, get) => ({
  cache: new Map(),
  lightboxId: null,
  isDragOver: false,

  hydrate(meta) {
    set((state) => {
      const existing = state.cache.get(meta.id);
      if (existing && isSameMeta(existing, meta)) return state;
      const next = new Map(state.cache);
      next.set(meta.id, meta);
      return { cache: next };
    });
  },

  hydrateMany(metas) {
    if (metas.length === 0) return;
    set((state) => {
      let dirty = false;
      const next = new Map(state.cache);
      for (const meta of metas) {
        const existing = next.get(meta.id);
        if (existing && isSameMeta(existing, meta)) continue;
        next.set(meta.id, meta);
        dirty = true;
      }
      if (!dirty) return state;
      return { cache: next };
    });
  },

  remove(id) {
    set((state) => {
      if (!state.cache.has(id)) {
        if (state.lightboxId === id) return { lightboxId: null };
        return state;
      }
      const next = new Map(state.cache);
      next.delete(id);
      return {
        cache: next,
        lightboxId: state.lightboxId === id ? null : state.lightboxId,
      };
    });
  },

  setLightbox(id) {
    set({ lightboxId: id });
  },

  setDragOver(b) {
    if (get().isDragOver === b) return;
    set({ isDragOver: b });
  },

  get(id) {
    return get().cache.get(id) ?? null;
  },

  reset() {
    set({ cache: new Map(), lightboxId: null, isDragOver: false });
  },
}));
