#!/usr/bin/env node
// vibe-term e2e sweep #2 — feature depth + performance edges (scenarios 20+).
// Complements e2e-vibe.mjs (core regression 00-18). Same conventions: real
// input events via CDP, buffer-level asserts through window.__vibe.
//
// Usage: node scripts/e2e-vibe2.mjs [port=9223] [outDir]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const PORT = Number(process.argv[2] ?? 9223);
const OUT =
  process.argv[3] ??
  path.join(
    "C:\\Users\\moi\\vibe-term-perf\\e2e",
    "sweep2-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19),
  );
fs.mkdirSync(OUT, { recursive: true });

// ── CDP plumbing (same shape as e2e-vibe.mjs) ───────────────────────────
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
        (res.exceptionDetails.exception?.description ?? res.exceptionDetails.text),
    );
  }
  return res.result?.value;
}
async function shot(name) {
  const res = await cdp("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(res.data, "base64"));
}
const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const NAMED_VK = { Enter: 13, Escape: 27, Backspace: 8, Tab: 9, F9: 120 };
async function realKey(key, mods = []) {
  const modifiers = mods.reduce((m, k) => m | MODS[k], 0);
  const isChar = key.length === 1;
  const vk = NAMED_VK[key] ?? (isChar ? key.toUpperCase().charCodeAt(0) : undefined);
  const code = NAMED_VK[key]
    ? key
    : /[a-zA-Z]/.test(key) && isChar
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
async function mouse(type, x, y, extra = {}) {
  await cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 150) {
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < ms) {
    v = await fn().catch(() => null);
    if (v) return v;
    await sleep(step);
  }
  return v;
}

const S = (v) => JSON.stringify(v);
const activeTab = () => eval_(`window.__vibe.stores.terminal().activeTabId`);
const tabState = (t) => eval_(`window.__vibe.termState(${S(t)})`);
const allLines = (t) =>
  eval_(`window.__vibe.readLines(${S(t)}, 0, window.__vibe.termState(${S(t)}).length)`);
async function paneCenter(t) {
  return eval_(`(() => {
    const el = document.querySelector('[data-tab-id=${S(t).replace(/"/g, "")}]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
}
async function focusPane(t) {
  const c = await paneCenter(t);
  if (c) {
    await mouse("mousePressed", c.x, c.y);
    await mouse("mouseReleased", c.x, c.y);
  }
  await sleep(180);
}
async function cleanPrompt(t) {
  await eval_(`(() => { const s = window.__vibe.stores.terminal(); const x = s.tabs.find(v=>v.id===${S(t)}); window.__vibe.writePty(x.ptyId, String.fromCharCode(3)); return true; })()`);
  await sleep(450);
}
async function waitPrompt(t, ms = 12000) {
  return until(async () => {
    const l = (await allLines(t)).filter((x) => x.trim()).slice(-1)[0] ?? "";
    return />\s*$/.test(l) ? l : null;
  }, ms);
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
    try { await shot("FAIL-" + name.replace(/\W+/g, "_").slice(0, 40)); } catch { /* */ }
  }
}

console.log(`e2e-vibe2 against port ${PORT} → ${OUT}`);

// Ensure exactly one live tab to start from.
await eval_(`(async () => {
  const v = window.__vibe; const s = () => v.stores.terminal();
  while (s().tabs.length > 1) { s().closeTab(s().tabs[s().tabs.length - 1].id); await new Promise(r=>setTimeout(r,150)); }
  if (s().tabs.length === 0) {
    const shells = await window.__TAURI_INTERNALS__.invoke('detect_shells');
    s().newTab(shells[0]);
  }
  return true;
})()`);
let TAB = await until(activeTab, 8000);
await waitPrompt(TAB, 15000);
await focusPane(TAB);

await scenario("20 search FTS returns real hits", async () => {
  await cleanPrompt(TAB);
  const marker = "FTSPROBE" + Math.floor(Math.random() * 1e6);
  await realType(`echo ${marker}\n`);
  await until(async () => (await allLines(TAB)).some((l) => l.trim() === marker));
  await sleep(1700); // block flush idles at 1200ms
  await realKey("r", ["ctrl"]);
  const input = await until(() => eval_(`!!document.querySelector('input[placeholder*="earch"], input[type="search"]')`));
  if (!input) throw new Error("search input did not open");
  await realType(marker);
  // The dialog debounces the FTS query (~180ms) then renders result rows;
  // assert the marker actually appears in a rendered result, not just that
  // we typed it into the input (which document.body would also contain).
  const hit = await until(
    () => eval_(`(() => {
      const input = document.querySelector('input[placeholder*="earch"], input[type="search"]');
      return [...document.querySelectorAll('mark, [class*="hit"], li, button, p, span')]
        .some(e => e !== input && (e.textContent||'').includes(${S(marker)}));
    })()`),
    8000,
  );
  await shot("20-search");
  await realKey("Escape");
  await sleep(250);
  if (!hit) throw new Error("no FTS hit rendered for " + marker);
  return `hit rendered for ${marker}`;
});

await scenario("21 image paste end-to-end (@mention + staged file)", async () => {
  await cleanPrompt(TAB);
  const ps = spawnSync("powershell", [
    "-STA", "-NoProfile", "-Command",
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = New-Object Drawing.Bitmap 48,48; $g=[Drawing.Graphics]::FromImage($b); $g.Clear([Drawing.Color]::Tomato); $g.Dispose(); [Windows.Forms.Clipboard]::SetImage($b); 'IMGSET'",
  ], { encoding: "utf8" });
  if (!ps.stdout?.includes("IMGSET")) throw new Error("clipboard image set failed: " + ps.stderr);
  await focusPane(TAB);
  await realKey("v", ["ctrl"]);
  const mention = await until(async () => {
    const text = (await allLines(TAB)).join("\n");
    const m = text.match(/@~\/\.vibe-shots\/([a-f0-9]{1,16})\.png/);
    return m ? m[1] : null;
  }, 10000);
  if (!mention) throw new Error("@~/.vibe-shots mention not inserted");
  const shotsDir = path.join(os.homedir(), ".vibe-shots");
  const file = path.join(shotsDir, mention + ".png");
  const staged = await (async () => {
    for (let i = 0; i < 20; i++) {
      if (fs.existsSync(file) && fs.statSync(file).size > 0) return true;
      await sleep(200);
    }
    return false;
  })();
  await cleanPrompt(TAB);
  if (!staged) throw new Error(`staged file missing: ${file}`);
  return `@mention ${mention}.png inserted; staged ${fs.statSync(file).size} bytes`;
});

await scenario("22 cmd.exe shell spawns and echoes", async () => {
  const cmdTab = await eval_(`(async () => {
    const shells = await window.__TAURI_INTERNALS__.invoke('detect_shells');
    const cmd = shells.find(s => /cmd/i.test(s.name) || /cmd\.exe$/i.test(s.path));
    if (!cmd) return null;
    return window.__vibe.stores.terminal().newTab(cmd).id;
  })()`);
  if (!cmdTab) throw new Error("cmd.exe not in detect_shells");
  const prompt = await until(async () => {
    const l = (await allLines(cmdTab).catch(() => [])) ?? [];
    const last = l.filter((x) => x.trim()).slice(-1)[0] ?? "";
    return />\s*$/.test(last) ? last : null;
  }, 15000);
  if (!prompt) throw new Error("cmd prompt never appeared");
  await focusPane(cmdTab);
  await realType("echo CMDOK\n");
  const ok = await until(async () => (await allLines(cmdTab)).some((l) => l.trim() === "CMDOK"), 8000);
  await eval_(`window.__vibe.stores.terminal().closeTab(${S(cmdTab)}) ?? true`);
  await sleep(400);
  if (!ok) throw new Error("cmd echo failed");
  return `cmd prompt ${S(prompt)} + echo OK`;
});

await scenario("23 hotkey rebind applies live (toggle_ai_panel → Ctrl+F9)", async () => {
  const before = await eval_(`window.__TAURI_INTERNALS__.invoke('config_get').then(s => s.hotkeys.toggle_ai_panel)`);
  await eval_(`window.__TAURI_INTERNALS__.invoke('config_update', { patch: { hotkeys: { toggle_ai_panel: 'Ctrl+F9' } } })`);
  await sleep(400);
  await focusPane(TAB);
  await realKey("F9", ["ctrl"]);
  const opened = await until(() => eval_(`[...document.querySelectorAll('aside,h2,h3,button')].some(e => /conversation|anthropic|model|api key/i.test(e.textContent || ''))`), 4000);
  await realKey("F9", ["ctrl"]);
  await sleep(300);
  await eval_(`window.__TAURI_INTERNALS__.invoke('config_update', { patch: { hotkeys: { toggle_ai_panel: ${S("Ctrl+I")} } } })`);
  if (!opened) throw new Error("Ctrl+F9 did not toggle AI panel after rebind");
  return `rebound ${before}→Ctrl+F9, toggled, reverted`;
});

await scenario("24 close last tab → hero → Ctrl+T reopens", async () => {
  await eval_(`(async () => { const s = () => window.__vibe.stores.terminal(); for (const t of [...s().tabs]) { s().closeTab(t.id); await new Promise(r=>setTimeout(r,150)); } return true; })()`);
  const hero = await until(() => eval_(`[...document.querySelectorAll('h1')].some(h => /vibe-term/i.test(h.textContent))`), 5000);
  if (!hero) throw new Error("hero screen did not appear");
  await shot("24-hero");
  await realKey("t", ["ctrl"]);
  const tab = await until(activeTab, 8000);
  if (!tab) throw new Error("Ctrl+T from hero did not open a tab");
  const prompt = await waitPrompt(tab, 15000);
  if (!prompt) throw new Error("reopened tab has no prompt");
  TAB = tab;
  await focusPane(TAB);
  return "hero shown; Ctrl+T respawned a live tab";
});

await scenario("25 pty_child_count sees a running process", async () => {
  await cleanPrompt(TAB);
  const ptyId = await eval_(`window.__vibe.stores.terminal().tabs.find(t=>t.id===${S(TAB)}).ptyId`);
  const cc = (id) =>
    eval_(`window.__TAURI_INTERNALS__.invoke('pty_child_count', { ptyId: ${S("__P__")} })`.replace('"__P__"', S(id)));
  await realType("ping -t 127.0.0.1\n");
  // PowerShell takes a beat to actually spawn PING.EXE — poll instead of a
  // fixed sleep so the probe isn't racing the child's creation.
  const busy = await until(async () => ((await cc(ptyId)) >= 1 ? true : null), 8000);
  await cleanPrompt(TAB); // Ctrl+C stops ping
  const idle = await until(async () => ((await cc(ptyId)) === 0 ? "0" : null), 6000);
  if (!busy) throw new Error(`child count never reached ≥1 while ping runs`);
  if (idle !== "0") throw new Error(`child count did not return to 0 after Ctrl+C`);
  return `ping running → ≥1; after Ctrl+C → 0 (confirm-on-close signal correct)`;
});

await scenario("26 export session renders markdown with real content", async () => {
  const md = await eval_(`(async () => {
    const sessions = await window.__TAURI_INTERNALS__.invoke('session_list', { limit: 1 });
    if (!sessions.length) return null;
    return window.__TAURI_INTERNALS__.invoke('export_session', { args: { sessionId: sessions[0].id, format: 'markdown' } });
  })()`);
  if (!md) throw new Error("no session to export");
  if (typeof md !== "string" || md.length < 50) throw new Error("export too small: " + String(md).slice(0, 80));
  fs.writeFileSync(path.join(OUT, "26-export.md"), md);
  return `markdown export ${md.length} chars`;
});

await scenario("27 shell exit shows overlay + status", async () => {
  const extra = await eval_(`(async () => {
    const shells = await window.__TAURI_INTERNALS__.invoke('detect_shells');
    return window.__vibe.stores.terminal().newTab(shells[0]).id;
  })()`);
  await until(async () => {
    const st = await tabState(extra);
    return st && (await allLines(extra)).some((l) => />\s*$/.test(l));
  }, 15000);
  await focusPane(extra);
  await realType("exit\n");
  // Clean shell exit is detected out-of-band by the Rust child-exit watcher
  // (ConPTY keeps the read pipe open while the master lives, so the reader
  // never EOFs) — allow a few watcher poll intervals.
  const exited = await until(
    () => eval_(`(() => {
      const tab = window.__vibe.stores.terminal().tabs.find(t=>t.id===${S(extra)});
      const overlay = [...document.querySelectorAll('.vibe-terminal-exit-overlay')]
        .some(d => /Process exited/i.test(d.textContent||''));
      return tab?.status === 'exited' && overlay;
    })()`),
    10000,
  );
  await shot("27-exit-overlay");
  await eval_(`window.__vibe.stores.terminal().closeTab(${S(extra)}) ?? true`);
  await sleep(300);
  if (!exited) throw new Error("exit overlay/status missing");
  return "status=exited + overlay rendered";
});

await scenario("28 spawn failure surfaces an error, no zombie tab state", async () => {
  const bogus = await eval_(`window.__vibe.stores.terminal().newTab({ name: 'bogus', path: 'C:/definitely/not/a/shell.exe', args: [] }).id`);
  const errored = await until(
    () => eval_(`(() => {
      const tab = window.__vibe.stores.terminal().tabs.find(t=>t.id===${S(bogus)});
      const notice = [...document.querySelectorAll('div')].some(d => /Failed to spawn/i.test(d.textContent||''));
      return tab?.status === 'error' && notice;
    })()`),
    8000,
  );
  await shot("28-spawn-failure");
  await eval_(`window.__vibe.stores.terminal().closeTab(${S(bogus)}) ?? true`);
  await sleep(300);
  if (!errored) throw new Error("spawn failure not surfaced");
  return "status=error + notice rendered";
});

await scenario("29 unicode paste delivers correct codepoints to the shell", async () => {
  // NOTE on what this proves: PowerShell 5.1's console ECHO downgrades emoji/
  // CJK glyphs it can't render to "?" — this happens in Windows Terminal too
  // and is NOT a delivery bug. So we assert the DATA the shell actually
  // received (via [char] codepoints of a pasted variable), not the echo glyph.
  await cleanPrompt(TAB);
  // A🚀B漢C → codepoints 65, 55357, 56960 (🚀 surrogate pair), 66, 28450 (漢), 67.
  // Write the probe to a UTF-8 file and Set-Clipboard from it — passing emoji +
  // nested quotes through a PowerShell -Command arg is a quoting minefield.
  const probe = `$e="A🚀B漢C"; [int[]][char[]]$e -join ","`;
  const probeFile = path.join(OUT, "29-probe.txt");
  fs.writeFileSync(probeFile, probe, "utf8");
  const ps = spawnSync("powershell", ["-STA", "-NoProfile", "-Command",
    `Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 '${probeFile}')`,
  ], { encoding: "utf8" });
  if (ps.status !== 0) throw new Error("Set-Clipboard failed: " + ps.stderr);
  await focusPane(TAB);
  await realKey("v", ["ctrl"]);
  await sleep(500);
  await realKey("Enter");
  const codes = await until(async () => {
    const line = (await allLines(TAB)).map((l) => l.trim())
      .find((l) => /^65,55357,56960,66,28450,67$/.test(l));
    return line ?? null;
  }, 12000);
  await cleanPrompt(TAB);
  if (!codes)
    throw new Error("shell did not receive the exact codepoints (65,55357,56960,66,28450,67)");
  return "pasted 🚀+漢 delivered as exact codepoints (echo glyph downgrade is a PS 5.1 cosmetic, not a delivery bug)";
});

await scenario("30 echo RTT stays low with 6 panes", async () => {
  await focusPane(TAB);
  for (let i = 0; i < 5; i++) {
    await realKey(i % 2 ? "e" : "d", ["ctrl", "shift"]);
    await sleep(900);
  }
  const groups = await eval_(`window.__vibe.dockview.groups.length`);
  if (groups < 6) throw new Error(`only ${groups} groups after 5 splits`);
  const act = await activeTab();
  await until(async () => (await allLines(act)).some((l) => />\s*$/.test(l)), 15000);
  const perf = await eval_(`(async () => {
    const v = window.__vibe;
    const s = v.stores.terminal();
    const tab = s.tabs.find(t=>t.id===${S("__A__")});
    const internals = window.__TAURI_INTERNALS__;
    let events = 0;
    const cb = internals.transformCallback((e) => { const p = e.payload ?? e; if (p.ptyId === tab.ptyId) events++; });
    await internals.invoke('plugin:event|listen', { event: 'pty://data', target: { kind: 'Any' }, handler: cb });
    const rtts = [];
    for (let i = 0; i < 4; i++) {
      const c = events; const t0 = performance.now();
      v.writePty(tab.ptyId, 'q');
      while (events === c && performance.now() - t0 < 1500) await new Promise(r=>setTimeout(r,2));
      rtts.push(Math.round((performance.now()-t0)*10)/10);
      await new Promise(r=>setTimeout(r,120));
    }
    v.writePty(tab.ptyId, String.fromCharCode(3));
    return rtts;
  })()`.replace('"__A__"', S(act)));
  // Close the 5 extra panes.
  await eval_(`(async () => { const s = () => window.__vibe.stores.terminal(); while (s().tabs.length > 1) { s().closeTab(s().tabs[s().tabs.length-1].id); await new Promise(r=>setTimeout(r,200)); } return true; })()`);
  await sleep(500);
  TAB = await activeTab();
  await focusPane(TAB);
  const med = perf.sort((a, b) => a - b)[1];
  if (med > 25) throw new Error(`RTT with 6 panes: ${perf}`);
  return `6 panes, echo RTT median ${med}ms ${JSON.stringify(perf)}`;
});

await scenario("31 divider drag storm: no corruption, refit applies", async () => {
  await focusPane(TAB);
  await realKey("d", ["ctrl", "shift"]);
  await sleep(1000);
  const act = await activeTab();
  await until(async () => (await allLines(act)).some((l) => />\s*$/.test(l)), 15000);
  const sash = await eval_(`(() => {
    const el = document.querySelector('.dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!sash) throw new Error("no dockview sash found");
  const colsBefore = (await tabState(act)).cols;
  await mouse("mousePressed", sash.x, sash.y);
  for (let i = 1; i <= 24; i++) {
    const dx = Math.round(140 * Math.sin((i / 24) * Math.PI * 3));
    await mouse("mouseMoved", sash.x + dx, sash.y, { buttons: 1 });
    await sleep(18);
  }
  await mouse("mouseMoved", sash.x - 120, sash.y, { buttons: 1 });
  await mouse("mouseReleased", sash.x - 120, sash.y);
  await sleep(700); // debounced refit (100ms) + ConPTY settle
  const colsAfter = (await tabState(act)).cols;
  await focusPane(act);
  await realType("echo RESIZESTORM_OK\n");
  const ok = await until(async () => (await allLines(act)).some((l) => l.trim() === "RESIZESTORM_OK"), 8000);
  await shot("31-after-storm");
  await eval_(`(async () => { const s = () => window.__vibe.stores.terminal(); while (s().tabs.length > 1) { s().closeTab(s().tabs[s().tabs.length-1].id); await new Promise(r=>setTimeout(r,200)); } return true; })()`);
  await sleep(400);
  TAB = await activeTab();
  await focusPane(TAB);
  if (!ok) throw new Error("echo failed after resize storm (ConPTY corruption?)");
  if (colsAfter === colsBefore) throw new Error("cols never changed during drag (refit dead?)");
  return `cols ${colsBefore}→${colsAfter}, prompt healthy after 24-step drag`;
});

await scenario("32 scrollback cap trims the buffer", async () => {
  await cleanPrompt(TAB);
  const sb0 = (await tabState(TAB)).options.scrollback;
  await eval_(`window.__TAURI_INTERNALS__.invoke('config_update', { patch: { general: { scrollbackLines: 1000 } } })`);
  await until(async () => (await tabState(TAB)).options.scrollback === 1000, 5000);
  await realType('1..3000 | % { "T$_" }\n');
  await until(async () => (await allLines(TAB)).some((l) => l.trim() === "T3000"), 30000);
  const st = await tabState(TAB);
  await eval_(`window.__TAURI_INTERNALS__.invoke('config_update', { patch: { general: { scrollbackLines: ${sb0} } } })`);
  await until(async () => (await tabState(TAB)).options.scrollback === sb0, 5000);
  if (st.length > 1000 + st.rows + 2)
    throw new Error(`buffer length ${st.length} exceeds cap 1000+${st.rows}`);
  return `buffer trimmed to ${st.length} lines (cap 1000 + ${st.rows} rows), restored ${sb0}`;
});

await scenario("33 theme switch stress: no artifacts, final palette correct", async () => {
  for (const t of ["light", "dark", "light", "dark"]) {
    await eval_(`window.__TAURI_INTERNALS__.invoke('config_update', { patch: { appearance: { theme: ${S("__T__")} } } })`.replace('"__T__"', S(t)));
    await sleep(350);
  }
  const st = await tabState(TAB);
  const bg = st.options.theme?.background;
  if (bg === "#fafafa") throw new Error("terminal stuck on light palette after final dark");
  const chrome = await eval_(`getComputedStyle(document.querySelector('header')).backgroundColor`);
  await shot("33-theme-final-dark");
  return `final dark: term bg ${bg}, header ${chrome}`;
});

await shot("99-final");
const passed = results.filter((r) => r.pass).length;
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(`\n${passed}/${results.length} scenarios passed → ${OUT}`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
