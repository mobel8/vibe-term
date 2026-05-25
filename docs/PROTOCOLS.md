# Image protocols

`vibe-term` aims to render images inline as faithfully as a modern terminal
allows. This document spells out which **terminal image protocols** are
supported, how they compare to other contemporary terminals, and which CLI
tools "just work" out of the box.

If you're looking for the broader image lifecycle (clipboard intake, OCR,
storage), see [ARCHITECTURE.md](./ARCHITECTURE.md#7-end-to-end-input-flow-one-keypress)
and the `images::ImageManager` source.

---

## 1. Protocol matrix

| Protocol | vibe-term | Ghostty | WezTerm | Kitty | Windows Terminal | macOS Terminal.app |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **Sixel** (DEC) | yes | yes | yes | no | yes (1.22+) | no |
| **iTerm OSC 1337** | yes | yes | yes | no | no | yes |
| **Kitty Graphics Protocol** (placeholders) | partial | yes | yes | yes | no | no |
| **Native paste image (clipboard)** | yes | yes | yes | no | yes | yes |
| **Drag-drop image file** | yes | no | partial | no | no | no |
| **Region screenshot hotkey** | yes | no | no | no | no | no |
| **OCR on pasted image** | yes (lazy) | no | no | no | no | no |
| **Lazy image upload to AI** | yes | no | no | no | no | no |

Notes:

- *Sixel*: implemented via `@xterm/addon-image` (Sixel + iTerm OSC 1337
  combined). Works on all OSes; on Windows we fall back to the same
  in-process renderer xterm.js uses, no Windows-Terminal-specific code.
- *Kitty placeholders*: the `U+10EEEE` Unicode placeholder scheme
  introduced by Kitty isn't yet implemented in xterm.js (community work in
  progress). We accept the escape sequence but only render the *first* chunk
  before bailing out — hence "partial". A full implementation lands in v2.
- *Drag-drop*: Tauri intercepts file drops at the window level
  (`fileDropEnabled: false` in `tauri.conf.json`), so we get the dropped
  paths reliably before WebKit/WebView2 can hijack them.
- *Region screenshot*: a custom overlay backed by `xcap` lets the user draw
  a rectangle without leaving the app. No comparable feature exists in the
  competitor list.

---

## 2. CLI tool compatibility

Out-of-the-box, the following terminal-image utilities produce visible
inline images in `vibe-term`:

| Tool | Protocol used | Notes |
|---|---|---|
| `chafa` ≥ 1.14 | auto-detect (Sixel) | renders into the terminal cell grid |
| `viu` | Sixel | `viu --sixel image.png` |
| `timg` ≥ 1.5 | Sixel or iTerm | falls back automatically; pass `--no-sixel` to force iTerm |
| `imgcat` (iTerm helper) | iTerm OSC 1337 | works as long as the binary is in `$PATH` |
| `kitten icat` | Kitty Graphics | renders the first frame only (placeholders unsupported) |
| `feh -d` over SSH | Sixel | `chafa` typically gives nicer results |
| `mpv --vo=tct image.png` | half-blocks (no escape) | always works, but blocky |

If you find a tool that *should* work but doesn't, please file an issue
with the exact command line and a screenshot of the rendered output.

---

## 3. Encoding pipeline

When you paste an image, drop a file, or take a screenshot, the same
pipeline runs:

1. **Decode.** `image::load_from_memory` reads PNG, JPEG, WebP, GIF (first
   frame), or raw clipboard RGBA bytes.
2. **Canonicalise to PNG.** A lossless re-encode normalises the bytes so
   the sha256 dedup is stable across re-imports of the same content.
3. **Persist.** Write `<sha256>.png` plus a `<sha256>.json` sidecar into
   the per-user image directory.
4. **Cache.** LRU caches: 64 entries each for `id → meta` and `sha → id`.
5. **Emit.** `image://added` event with `{ imageId, source, w, h, bytes }`.
6. **Render.** The frontend places a decoration on the xterm grid showing
   a thumbnail, a `img_xxxxxx` badge, and a click target that copies the id
   to the clipboard or adds the image to the AI staging area.

For terminal-emitted images (Sixel / iTerm OSC 1337 produced by, e.g.,
`chafa`), the rendering bypasses the image manager — the addon paints them
directly. They are *not* stored, indexed, or referencable by `img_xxxx`.
To capture such output for later reuse, take a region screenshot instead.

---

## 4. Image IDs

The `img_xxxxxx` identifier is a six-character lowercase alphanumeric
suffix (`36^6 ≈ 2.1 billion` combinations). Collisions are recoverable
because storage dedup uses the sha256 — a duplicate id is rebuilt without
allocating a new record.

The id is **stable across sessions and reboots** as long as the sidecar
file survives. Deletion (`image_delete`) removes both the PNG and the
sidecar.

---

## 5. Sending images to the AI

In the AI panel composer, any standalone `img_xxxx` token in your prompt
gets resolved through `images.getBase64()` and inserted as an Anthropic
`image` content block (PNG, base64):

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "What's wrong with this stack trace?" },
    { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "iVBORw0K..." } }
  ]
}
```

Multiple `img_xxxx` references in one message are all attached. The
backend caps the per-request total at 20 MiB (Anthropic's documented
limit) and refuses with `AppError::InvalidInput` if the prompt exceeds it.

---

## 6. Limitations & roadmap

- **No animated GIF playback.** We render the first frame only. Animated
  terminal images are extremely heavy to redraw and the addon doesn't
  support them yet. Workaround: pipe through `chafa --duration` if you
  truly need motion.
- **No HEIC.** The `image` crate doesn't ship a HEIC decoder. Convert
  with `heif-convert image.heic image.png` before pasting.
- **No SVG.** Same reason; convert via `rsvg-convert -o image.png image.svg`.
- **Kitty placeholders** for tiled images — planned in v2 once the
  `@xterm/addon-image` upstream lands the implementation.
