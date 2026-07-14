#!/usr/bin/env node
// vibe-term end-to-end harness (CDP, real input events, buffer-level asserts).
//
// Usage: node scripts/e2e-vibe.mjs [port=9223] [outDir]
//
// Drives the RUNNING app (dev or prod exe launched with
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>) and
// verifies every core feature with PASS/FAIL output + screenshots. Reads the
// terminal through window.__vibe (xterm buffer API) because the WebGL
// renderer leaves the DOM textless.
//
// Scenarios cover the 2026-07 fix batch: restored-layout activation, single
// paste, scroll (clean + during stream + Shift+wheel), leaked-mode self-heal
// (wheel + paste triggers), serialized-writer anti-splice, capture-phase
// hotkeys (no byte leaks into the shell), live settings (font/scrollback/
// theme), OSC cwd, splits, confirm-on-close (idle), palette, gallery, search.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PORT = Number(process.argv[2] ?? 9223);
const OUT =
  process.argv[3] ??
  path.join(
    "C:\\Users\\moi\\vibe-term-perf\\e2e",
    new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19),
  );
fs.mkdirSync(OUT, { recursive: true });
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── CDP plumbing ────────────────────────────────────────────────────────
const pages = await new Promise((resolve, reject) => {
  http
    .get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d)));
    })
    .on("error", reject);
});
const page = pages.find((p) => p.type === "page");
if (!page) {
  console.error("no page at port", PORT);
  process.exit(1);
}
const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
  const p = pending.get(m.id);
  if (p) {
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  }
});
const cdp = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
await new Promise((r) => ws.addEventListener("open", r));

/** Evaluate an async JS expression in the page, return its value. */
async function eval_(expr) {
  const res = await cdp("Runtime.evaluate", {
    expression: `(async () => (${expr}))()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: 30000,
  });
  if (res.exceptionDetails) {
    throw new Error(
      "page exception: " +
        (res.exceptionDetails.exception?.description ??
          res.exceptionDetails.text),
    );
  }
  return res.result?.value;
}

async function shot(name) {
  const res = await cdp("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(res.data, "base64"));
}

const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
async function realKey(key, mods = []) {
  const modifiers = mods.reduce((m, k) => m | MODS[k], 0);
  const named = { Enter: 13, Escape: 27, Backspace: 8, Tab: 9 };
  const isChar = key.length === 1;
  const vk = named[key] ?? (isChar ? key.toUpperCase().charCodeAt(0) : undefined);
  const code = named[key]
    ? key
    : /[a-zA-Z]/.test(key)
      ? `Key${key.toUpperCase()}`
      : /[0-9]/.test(key)
        ? `Digit${key}`
        : key;
  const evKey = isChar && modifiers & MODS.shift ? key.toUpperCase() : key;
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: vk, key: evKey, code, modifiers });
  if (key === "Enter") await cdp("Input.dispatchKeyEvent", { type: "char", text: "\r", modifiers });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: vk, key: evKey, code, modifiers });
}
async function realType(text) {
  for (const ch of text) {
    if (ch === "\n") await realKey("Enter");
    else {
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    }
  }
}
async function realWheel(x, y, deltaY, count = 1) {
  for (let i = 0; i < count; i++) {
    await cdp("Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y, deltaX: 0, deltaY, pointerType: "mouse",
    });
  }
}
async function realClick(x, y) {
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until fn() is truthy or timeout; returns last value. */
async function until(fn, ms = 6000, step = 120) {
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < ms) {
    v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return v;
}

// Active tab helpers (all read through __vibe).
const activeTab = () =>
  eval_(`window.__vibe.stores.terminal().activeTabId`);
const tabState = (tab) =>
  eval_(`window.__vibe.termState(${JSON.stringify(tab)})`);
const lines = (tab) =>
  eval_(
    `window.__vibe.readLines(${JSON.stringify(tab)}, 0, window.__vibe.termState(${JSON.stringify(tab)}).length)`,
  );
const lastNonEmpty = async (tab, n = 1) =>
  (await lines(tab)).filter((l) => l.trim()).slice(-n);
async function paneCenter(tab) {
  return eval_(`(() => {
    const el = document.querySelector('[data-tab-id=${JSON.stringify(tab).replace(/"/g, "")}]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
}
async function focusPane(tab) {
  const c = await paneCenter(tab);
  if (c) await realClick(c.x, c.y);
  await sleep(150);
}
/** Ctrl+C to clear any pending PSReadLine input, wait for a fresh prompt. */
async function cleanPrompt(tab) {
  await eval_(`(() => { const s = window.__vibe.stores.terminal(); const t = s.tabs.find(t=>t.id===${JSON.stringify(tab)}); window.__vibe.writePty(t.ptyId, String.fromCharCode(3)); return true; })()`);
  await sleep(450);
}

const results = [];
async function scenario(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, pass: true, detail: detail ?? "" });
    console.log(`PASS  ${name}${detail ? "  — " + detail : ""}`);
  } catch (err) {
    results.push({ name, pass: false, detail: String(err?.message ?? err) });
    console.log(`FAIL  ${name}  — ${err?.message ?? err}`);
    try { await shot("FAIL-" + name.replace(/\W+/g, "_")); } catch { /* ignore */ }
  }
}

// ════════════════════════════════════════════════════════════════════════
console.log(`e2e-vibe against port ${PORT} → ${OUT}`);

await scenario("00 hook + app present", async () => {
  const info = await eval_(`({
    hook: !!window.__vibe, href: location.href,
    terms: [...(window.__vibe?.terms?.keys() ?? [])].length,
  })`);
  if (!info.hook) throw new Error("__vibe hook missing");
  return `href=${info.href} terms=${info.terms}`;
});

// Ensure at least one live tab: reuse existing or create via the store.
await scenario("01 spawn tab / live prompt", async () => {
  let tab = await activeTab();
  if (!tab) {
    await eval_(`(async () => {
      const shells = await window.__TAURI_INTERNALS__.invoke('detect_shells');
      window.__vibe.stores.terminal().newTab(shells[0]);
      return true;
    })()`);
    tab = await until(activeTab, 5000);
  }
  if (!tab) throw new Error("no active tab");
  const prompt = await until(async () => {
    const l = await lastNonEmpty(tab);
    return /so>\s*$|>\s*$/.test(l[0] ?? "") ? l[0] : null;
  }, 15000);
  if (!prompt) throw new Error("no shell prompt appeared");
  await focusPane(tab);
  return `tab=${tab} prompt=${JSON.stringify(prompt)}`;
});

const TAB = await activeTab();
const CENTER = await paneCenter(TAB);

await scenario("02 typing echo (real keys) + RTT", async () => {
  await cleanPrompt(TAB);
  const t0 = Date.now();
  await realType("echo VIBE_E2E_OK\n");
  const found = await until(async () =>
    (await lines(TAB)).some((l) => l.trim() === "VIBE_E2E_OK"), 8000);
  if (!found) throw new Error("echo output not found in buffer");
  return `round-trip ${Date.now() - t0}ms (incl. PS exec)`;
});

await scenario("03 paste inserts exactly once", async () => {
  await cleanPrompt(TAB);
  const marker = "PASTE_ONCE_" + Math.floor(Math.random() * 1e6);
  spawnSync("powershell", ["-NoProfile", "-Command", `Set-Clipboard -Value '${marker}'`]);
  await focusPane(TAB);
  await realKey("v", ["ctrl"]);
  await sleep(700);
  const all = (await lines(TAB)).join("\n");
  const count = all.split(marker).length - 1;
  if (count !== 1) throw new Error(`marker appears ${count}× (want 1)`);
  await cleanPrompt(TAB);
  return `1 occurrence`;
});

await scenario("04 anti-splice: concurrent writers stay ordered", async () => {
  await cleanPrompt(TAB);
  const A = "A".repeat(40), B = "B".repeat(40);
  await eval_(`(() => {
    const s = window.__vibe.stores.terminal();
    const t = s.tabs.find(t=>t.id===${JSON.stringify(TAB)});
    // Two writers racing: the app inserter (writePty) + the keyboard path
    // (term.paste → onData → writePty). Serialized queue ⇒ no interleave.
    window.__vibe.writePty(t.ptyId, ${JSON.stringify(A)});
    window.__vibe.terms.get(${JSON.stringify(TAB)}).paste(${JSON.stringify(B)});
    return true;
  })()`);
  await sleep(900);
  const text = (await lines(TAB)).join("").replace(/\s+/g, "");
  if (!text.includes(A + B)) {
    const idx = text.search(/A[AB]*B/);
    throw new Error(`interleaved echo: …${text.slice(Math.max(0, idx - 4), idx + 90)}…`);
  }
  await cleanPrompt(TAB);
  return "AAAA…BBBB contiguous";
});

await scenario("05 scroll: wheel up in clean state", async () => {
  await cleanPrompt(TAB);
  await realType('1..80 | % { "L$_" }\n');
  await until(async () => (await lines(TAB)).some((l) => l.trim() === "L80"), 10000);
  await eval_(`window.__vibe.terms.get(${JSON.stringify(TAB)}).scrollToBottom() ?? true`);
  const before = await tabState(TAB);
  await realWheel(CENTER.x, CENTER.y, -120, 3);
  await sleep(250);
  const after = await tabState(TAB);
  if (!(after.viewportY < before.viewportY))
    throw new Error(`viewportY ${before.viewportY} → ${after.viewportY} (no scroll)`);
  await shot("05-scrolled-up");
  return `viewportY ${before.viewportY} → ${after.viewportY}`;
});

await scenario("06 scroll position holds during output stream", async () => {
  await eval_(`window.__vibe.terms.get(${JSON.stringify(TAB)}).scrollToBottom() ?? true`);
  await realType('1..4000 | % { "S$_" }\n');
  await sleep(400);
  // Establish the precondition "user actually scrolled up" — wheel events can
  // race the burst of incoming writes, so retry until the viewport detaches
  // from the bottom before measuring the hold.
  let s1 = null;
  for (let i = 0; i < 6; i++) {
    await realWheel(CENTER.x, CENTER.y, -120, 4);
    await sleep(200);
    const st = await tabState(TAB);
    if (st.viewportY < st.baseY - 5) {
      s1 = st;
      break;
    }
  }
  if (!s1) throw new Error("could not scroll up during stream (precondition)");
  await sleep(700);
  const s2 = await tabState(TAB);
  const done = await until(async () =>
    (await lastNonEmpty(TAB))[0]?.match(/>\s*$/), 20000);
  const s3 = await tabState(TAB);
  // STRICT while output streams: the viewport must not move at all.
  if (s2.baseY > s1.baseY && s1.viewportY !== s2.viewportY)
    throw new Error(`viewport moved mid-stream ${s1.viewportY}→${s2.viewportY}`);
  if (!done) throw new Error("stream never finished");
  // At prompt-return, ConPTY/windowsMode settles the final cursor row and can
  // nudge the viewport by a single line — imperceptible and not a yank-to-
  // bottom. Anything larger fails.
  if (Math.abs(s3.viewportY - s1.viewportY) > 2)
    throw new Error(`viewport drifted ${s1.viewportY}→${s3.viewportY} after stream`);
  if (s3.viewportY >= s3.baseY)
    throw new Error("viewport snapped to bottom during stream");
  await eval_(`window.__vibe.terms.get(${JSON.stringify(TAB)}).scrollToBottom() ?? true`);
  return `held ${s1.viewportY} mid-stream (baseY ${s1.baseY}→${s2.baseY}); settle drift ${s3.viewportY - s1.viewportY}`;
});

await scenario("07 leaked modes: wheel auto-heals orphaned TUI state", async () => {
  await cleanPrompt(TAB);
  // Latch 2004 (bracketed paste) + 1004 (focus reporting) — what a dead
  // claude/ssh leaves behind (these DO pass Win10 conhost, verified).
  await realType(`Write-Host ([char]27+'[?2004h'+[char]27+'[?1004h')\n`);
  const armed = await until(async () => {
    const st = await tabState(TAB);
    return st.modes.bracketedPasteMode && st.modes.sendFocusMode;
  }, 6000);
  if (!armed) throw new Error("could not latch leak modes via ConPTY");
  await realWheel(CENTER.x, CENTER.y, -120, 1); // suspicious → schedules probe
  const healed = await until(async () => {
    const st = await tabState(TAB);
    return !st.modes.bracketedPasteMode && !st.modes.sendFocusMode;
  }, 6000);
  if (!healed) throw new Error("modes still latched after wheel probe");
  await shot("07-healed");
  return "2004+1004 latched → wheel → auto-reset";
});

await scenario("08 leaked bracketed paste: paste sanitized (no 200~)", async () => {
  await cleanPrompt(TAB);
  await realType(`Write-Host ([char]27+'[?2004h')\n`);
  const armed = await until(async () => (await tabState(TAB)).modes.bracketedPasteMode, 6000);
  if (!armed) throw new Error("2004 not latched");
  const marker = "SANITIZED_" + Math.floor(Math.random() * 1e6);
  spawnSync("powershell", ["-NoProfile", "-Command", `Set-Clipboard -Value '${marker}'`]);
  await focusPane(TAB);
  await realKey("v", ["ctrl"]);
  await sleep(1000);
  const all = (await lines(TAB)).join("\n");
  if (!all.includes(marker)) throw new Error("paste content missing");
  if (all.includes("200~") || all.includes("201~"))
    throw new Error("bracket markers leaked into buffer");
  const st = await tabState(TAB);
  if (st.modes.bracketedPasteMode) throw new Error("2004 still latched after paste heal");
  await cleanPrompt(TAB);
  return "paste clean, mode healed";
});

await scenario("09 Shift+wheel always scrolls locally", async () => {
  await cleanPrompt(TAB);
  await eval_(`window.__vibe.terms.get(${JSON.stringify(TAB)}).scrollToBottom() ?? true`);
  const before = await tabState(TAB);
  await cdp("Input.dispatchMouseEvent", {
    type: "mouseWheel", x: CENTER.x, y: CENTER.y, deltaX: 0, deltaY: -120,
    modifiers: MODS.shift, pointerType: "mouse",
  });
  await sleep(200);
  const after = await tabState(TAB);
  if (!(after.viewportY < before.viewportY)) throw new Error("Shift+wheel did not scroll");
  await eval_(`window.__vibe.terms.get(${JSON.stringify(TAB)}).scrollToBottom() ?? true`);
  return `viewportY ${before.viewportY} → ${after.viewportY}`;
});

await scenario("10 hotkey capture: Ctrl+Alt+S opens region picker, leaks NOTHING to shell", async () => {
  await cleanPrompt(TAB);
  await realType("echo pending_input"); // NO enter — pending line
  await sleep(300);
  const before = (await lastNonEmpty(TAB))[0];
  await realKey("s", ["ctrl", "alt"]);
  const overlay = await until(
    () => eval_(`!!document.querySelector('[aria-label="Screenshot region picker"]')`),
    3000,
  );
  if (!overlay) throw new Error("region-picker overlay did not open");
  await realKey("Escape");
  await sleep(300);
  const after = (await lastNonEmpty(TAB))[0];
  if (before !== after)
    throw new Error(`prompt line changed: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  await eval_(`window.__vibe.writePty(window.__vibe.stores.terminal().tabs.find(t=>t.id===${JSON.stringify(TAB)}).ptyId, String.fromCharCode(3))`);
  await sleep(300);
  return "overlay opened, zero bytes leaked into shell";
});

await scenario("11 Ctrl+K palette opens/closes; Ctrl+, opens settings", async () => {
  await focusPane(TAB);
  await realKey("k", ["ctrl"]);
  const open = await until(() => eval_(`!!document.querySelector('[cmdk-root]')`), 3000);
  if (!open) throw new Error("palette did not open on Ctrl+K");
  await shot("11-palette");
  await realKey("Escape");
  await sleep(250);
  const closed = await eval_(`!document.querySelector('[cmdk-root]')`);
  if (!closed) throw new Error("palette did not close on Esc");
  await realKey(",", ["ctrl"]);
  const settings = await until(() => eval_(`[...document.querySelectorAll('h2,h3')].some(h=>/settings/i.test(h.textContent))`), 3000);
  if (!settings) throw new Error("settings did not open on Ctrl+,");
  await shot("11-settings");
  await realKey("Escape");
  await sleep(250);
  return "palette + settings via rebindable combos";
});

await scenario("12 split D/E semantics + WT alias", async () => {
  await focusPane(TAB);
  const g0 = await eval_(`window.__vibe.dockview.groups.length`);
  await realKey("d", ["ctrl", "shift"]);
  await sleep(700);
  const g1 = await eval_(`window.__vibe.dockview.groups.length`);
  if (g1 !== g0 + 1) throw new Error(`Ctrl+Shift+D: groups ${g0}→${g1}`);
  const tabs1 = await eval_(`window.__vibe.stores.terminal().tabs.length`);
  await realKey("w", ["ctrl"]); // close the new pane (idle ⇒ no confirm)
  await sleep(700);
  const g2 = await eval_(`window.__vibe.dockview.groups.length`);
  const tabs2 = await eval_(`window.__vibe.stores.terminal().tabs.length`);
  if (g2 !== g0 || tabs2 !== tabs1 - 1)
    throw new Error(`Ctrl+W: groups ${g1}→${g2}, tabs ${tabs1}→${tabs2}`);
  return `split→${g1} groups, close→${g2}; idle close silent (confirmOnClose)`;
});

await scenario("13 live settings: fontSize + scrollback apply instantly", async () => {
  const st0 = await tabState(TAB);
  await eval_(`window.__TAURI_INTERNALS__.invoke('config_update', { patch: { appearance: { fontSize: 16 }, general: { scrollbackLines: 5000 } } })`);
  const applied = await until(async () => {
    const st = await tabState(TAB);
    return st.options.fontSize === 16 && st.options.scrollback === 5000;
  }, 5000);
  await eval_(`window.__TAURI_INTERNALS__.invoke('config_update', { patch: { appearance: { fontSize: ${st0.options.fontSize} }, general: { scrollbackLines: ${st0.options.scrollback} } } })`);
  if (!applied) throw new Error("options did not update live");
  const reverted = await until(async () =>
    (await tabState(TAB)).options.fontSize === st0.options.fontSize, 5000);
  if (!reverted) throw new Error("revert failed");
  return `fontSize 16 + scrollback 5000 applied live, reverted`;
});

await scenario("14 live theme recolors the terminal canvas", async () => {
  const bg0 = (await tabState(TAB)).options.theme?.background;
  await eval_(`window.__TAURI_INTERNALS__.invoke('config_update', { patch: { appearance: { theme: 'light' } } })`);
  const light = await until(async () =>
    (await tabState(TAB)).options.theme?.background === "#fafafa", 5000);
  await shot("14-theme-light");
  await eval_(`window.__TAURI_INTERNALS__.invoke('config_update', { patch: { appearance: { theme: 'dark' } } })`);
  const back = await until(async () =>
    (await tabState(TAB)).options.theme?.background !== "#fafafa", 5000);
  if (!light) throw new Error(`theme did not reach xterm (bg stayed ${bg0})`);
  if (!back) throw new Error("revert to dark failed");
  await shot("14-theme-dark");
  return "light palette hit xterm options; reverted";
});

await scenario("15 OSC 9;9 cwd tracking updates the store", async () => {
  await eval_(`window.__vibe.terms.get(${JSON.stringify(TAB)}).write(String.fromCharCode(27)+']9;9;"C:\\\\VibeProbe"'+String.fromCharCode(7)) ?? true`);
  const cwd = await until(async () =>
    eval_(`window.__vibe.stores.terminal().tabs.find(t=>t.id===${JSON.stringify(TAB)})?.cwd`), 3000);
  if (cwd !== "C:\\VibeProbe") throw new Error(`cwd=${JSON.stringify(cwd)}`);
  return `cwd → ${cwd}`;
});

await scenario("16 gallery + search toggles", async () => {
  await focusPane(TAB);
  await realKey("g", ["ctrl", "shift"]);
  const gal = await until(() => eval_(`[...document.querySelectorAll('aside,h2,h3,span')].some(e=>/gallery|images/i.test(e.textContent||''))`), 3000);
  await realKey("g", ["ctrl", "shift"]);
  await focusPane(TAB);
  await realKey("r", ["ctrl"]);
  const search = await until(() => eval_(`!!document.querySelector('input[placeholder*="earch"], input[type="search"]')`), 3000);
  await realKey("Escape");
  await sleep(250);
  if (!gal) throw new Error("gallery did not open");
  if (!search) throw new Error("search did not open");
  return "gallery + search open/close";
});

await scenario("17 palette Reset terminal command exists & runs", async () => {
  // Latch a mode, run the palette command, expect it cleared.
  await eval_(`window.__vibe.terms.get(${JSON.stringify(TAB)}).write(String.fromCharCode(27)+'[?2004h') ?? true`);
  await focusPane(TAB);
  await realKey("k", ["ctrl"]);
  await until(() => eval_(`!!document.querySelector('[cmdk-root]')`), 3000);
  await realType("reset term");
  await sleep(350);
  await realKey("Enter");
  const healed = await until(async () =>
    !(await tabState(TAB)).modes.bracketedPasteMode, 4000);
  if (!healed) throw new Error("reset command did not clear modes");
  return "Reset terminal state ran from palette";
});

// ── Fluidity after-measures (compare with session baseline) ─────────────
await scenario("18 perf: echo RTT + bulk coalescing", async () => {
  await cleanPrompt(TAB);
  const perf = await eval_(`(async () => {
    const v = window.__vibe;
    const s = v.stores.terminal();
    const tab = s.tabs.find(t=>t.id===${JSON.stringify(TAB)});
    const internals = window.__TAURI_INTERNALS__;
    let events = 0, bytes = 0, tFirst = 0, tLast = 0;
    const cb = internals.transformCallback((e) => {
      const p = e.payload ?? e;
      if (p.ptyId !== tab.ptyId) return;
      events++; bytes += p.data.length;
      const now = performance.now();
      if (!tFirst) tFirst = now;
      tLast = now;
    });
    await internals.invoke('plugin:event|listen', { event: 'pty://data', target: { kind: 'Any' }, handler: cb });
    // echo RTT ×5 through the REAL serialized writer
    const rtts = [];
    for (let i = 0; i < 5; i++) {
      const c = events; const t0 = performance.now();
      v.writePty(tab.ptyId, 'z');
      while (events === c && performance.now() - t0 < 1500) await new Promise(r=>setTimeout(r,2));
      rtts.push(Math.round((performance.now()-t0)*10)/10);
      await new Promise(r=>setTimeout(r,100));
    }
    v.writePty(tab.ptyId, String.fromCharCode(3));
    await new Promise(r=>setTimeout(r,350));
    events = 0; bytes = 0; tFirst = 0; tLast = 0;
    v.writePty(tab.ptyId, '[IO.File]::ReadAllText("C:/Users/moi/vibe-term-perf/big.txt") | Write-Host\\r');
    const t0 = performance.now();
    let idle = 0, last = 0;
    while (idle < 8 && performance.now() - t0 < 25000) {
      await new Promise(r=>setTimeout(r,100));
      if (events === last) idle++; else { idle = 0; last = events; }
    }
    return { rtts, events, kb: Math.round(bytes/1024), streamMs: Math.round(tLast - tFirst) };
  })()`);
  const medRtt = perf.rtts.sort((a, b) => a - b)[2];
  if (medRtt > 25) throw new Error(`echo RTT regressed: ${perf.rtts}`);
  if (perf.kb > 100 && perf.events > 120)
    throw new Error(`coalescing regressed: ${perf.events} events for ${perf.kb}KB`);
  fs.writeFileSync(path.join(OUT, "perf.json"), JSON.stringify(perf, null, 2));
  return `RTT med ${medRtt}ms ${JSON.stringify(perf.rtts)}; bulk ${perf.kb}KB in ${perf.streamMs}ms over ${perf.events} events`;
});

await shot("99-final");
const passed = results.filter((r) => r.pass).length;
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(`\n${passed}/${results.length} scenarios passed → ${OUT}`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
