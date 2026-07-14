#!/usr/bin/env node
// vibe-term restart-restore proof: builds a 3-pane split layout with distinct
// markers, closes the app gracefully, relaunches the SAME exe, and verifies
// the layout came back with every pane ALIVE (attached DOM + fresh prompt) —
// the exact scenario that used to restore as blank dead panes.
//
// Usage: node scripts/e2e-restore.mjs <exePath> [port=9223] [outDir]

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const EXE = process.argv[2];
const PORT = Number(process.argv[3] ?? 9223);
const OUT =
  process.argv[4] ??
  path.join(
    "C:\\Users\\moi\\vibe-term-perf\\e2e",
    "restore-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19),
  );
if (!EXE || !fs.existsSync(EXE)) {
  console.error("usage: e2e-restore.mjs <exePath> [port]");
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── minimal CDP client ──────────────────────────────────────────────────
async function connect() {
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
  if (!page) throw new Error("no page");
  const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  await new Promise((r, j) => {
    ws.addEventListener("open", r);
    ws.addEventListener("error", j);
  });
  const cdp = (method, params) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  const evalJs = async (expr) => {
    const res = await cdp("Runtime.evaluate", {
      expression: `(async () => (${expr}))()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: 20000,
    });
    if (res.exceptionDetails)
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    return res.result?.value;
  };
  const shot = async (name) => {
    const res = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(res.data, "base64"));
  };
  const key = async (k, mods = []) => {
    const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
    const modifiers = mods.reduce((m, x) => m | MODS[x], 0);
    const isChar = k.length === 1;
    const vk = { Enter: 13, Escape: 27 }[k] ?? (isChar ? k.toUpperCase().charCodeAt(0) : undefined);
    const code = /[a-zA-Z]/.test(k) && isChar ? `Key${k.toUpperCase()}` : k;
    const evKey = isChar && modifiers & 8 ? k.toUpperCase() : k;
    await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: vk, key: evKey, code, modifiers });
    if (k === "Enter") await cdp("Input.dispatchKeyEvent", { type: "char", text: "\r", modifiers });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: vk, key: evKey, code, modifiers });
  };
  const type = async (text) => {
    for (const ch of text) {
      if (ch === "\n") await key("Enter");
      else {
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      }
    }
  };
  return { cdp, evalJs, shot, key, type, ws };
}

async function waitCdp(ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${PORT}/json`, (r) => { r.resume(); resolve(); }).on("error", reject);
      });
      return true;
    } catch {
      await sleep(500);
    }
  }
  return false;
}

function launch() {
  const child = spawn(EXE, [], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
  });
  child.unref();
}

const until = async (fn, ms = 12000, step = 200) => {
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < ms) {
    v = await fn().catch(() => null);
    if (v) return v;
    await sleep(step);
  }
  return v;
};

// ════════════════════════════════════════════════════════════════════════
console.log(`restore-proof: ${EXE} (port ${PORT}) → ${OUT}`);
const fail = (m) => {
  console.log("FAIL  " + m);
  process.exit(1);
};

// Phase A — arrange 3 panes with markers.
if (!(await waitCdp(4000))) {
  launch();
  if (!(await waitCdp(30000))) fail("app did not expose CDP");
}
let c = await connect();
await sleep(1500);

// Start from exactly one tab: close extras through the STORE (deterministic).
await c.evalJs(`(async () => {
  const v = window.__vibe; const s = () => v.stores.terminal();
  while (s().tabs.length > 1) { s().closeTab(s().tabs[s().tabs.length - 1].id); await new Promise(r=>setTimeout(r,150)); }
  if (s().tabs.length === 0) {
    const shells = await window.__TAURI_INTERNALS__.invoke('detect_shells');
    s().newTab(shells[0]);
  }
  return true;
})()`);
await until(async () =>
  c.evalJs(`window.__vibe.stores.terminal().tabs.length === 1 && !!window.__vibe.stores.terminal().tabs[0].ptyId`), 15000);

const focusActive = async () => {
  const r = await c.evalJs(`(() => { const el = document.querySelector('[data-tab-id]'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) }; })()`);
  if (r) {
    await c.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
    await c.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
  }
  await sleep(200);
};
await focusActive();
await c.type("echo PANE_ONE\n");
await sleep(600);
await c.key("d", ["ctrl", "shift"]); // split right
await sleep(1200);
await c.type("echo PANE_TWO\n");
await sleep(600);
await c.key("e", ["ctrl", "shift"]); // split below
await sleep(1200);
await c.type("echo PANE_THREE\n");
await sleep(800);

const before = await c.evalJs(`({
  tabs: window.__vibe.stores.terminal().tabs.map(t => t.id),
  groups: window.__vibe.dockview.groups.length,
  layoutSaved: !!localStorage.getItem('vibe-term:layout:v1'),
})`);
if (before.tabs.length !== 3 || before.groups !== 3) {
  fail(`arrangement wrong: tabs=${before.tabs.length} groups=${before.groups}`);
}
await sleep(800); // let the debounced layout save flush
await c.shot("A-before-restart");
console.log(`PASS  arranged 3 panes in 3 groups; layout persisted=${before.layoutSaved}`);

// Phase B — graceful close, relaunch, verify.
c.ws.close();
execFileSync("taskkill", ["/IM", "vibe-term.exe"], { stdio: "ignore" }); // WM_CLOSE, no /F
await sleep(2500);
launch();
if (!(await waitCdp(30000))) fail("relaunched app did not expose CDP");
c = await connect();
await sleep(2000);

const after = await until(async () => {
  const st = await c.evalJs(`(() => {
    const v = window.__vibe; if (!v?.dockview) return null;
    const tabs = v.stores.terminal().tabs;
    const attached = [...document.querySelectorAll('[data-tab-id]')].map(e => e.dataset.tabId);
    const states = tabs.map(t => { const s = v.termState(t.id); return s ? { id: t.id, cols: s.cols, rows: s.rows, pty: !!t.ptyId } : null; });
    return { tabIds: tabs.map(t=>t.id), groups: v.dockview.groups.length, attached, states };
  })()`);
  return st && st.tabIds.length === 3 && st.groups === 3 && st.attached.length === 3 && st.states.every(s => s && s.pty) ? st : null;
}, 25000);
if (!after) fail("restored state incomplete (tabs/groups/attached/pty)");

// Same tab ids, all panes fitted (≠ 80x24 fallback) and showing a prompt.
const sameIds = before.tabs.every((id) => after.tabIds.includes(id));
if (!sameIds) fail(`tab ids changed across restart`);
const allFitted = after.states.every((s) => !(s.cols === 80 && s.rows === 24));
const prompts = await until(async () =>
  c.evalJs(`window.__vibe.stores.terminal().tabs.every(t => {
    const lines = window.__vibe.readLines(t.id) ?? [];
    return lines.some(l => />\\s*$/.test(l));
  })`), 20000);
await c.shot("B-after-restart");
if (!allFitted) fail(`some pane kept the 80x24 fallback: ${JSON.stringify(after.states)}`);
if (!prompts) fail("some restored pane never showed a live prompt");
console.log(`PASS  restart restored ${after.tabIds.length} tabs in ${after.groups} groups, all attached+fitted+live`);
console.log(`OK → ${OUT}`);
c.ws.close();
process.exit(0);
