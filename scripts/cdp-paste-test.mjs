#!/usr/bin/env node
// Deterministic double-paste test: patch pty_write to record, fire a REAL
// Ctrl+V via CDP Input.dispatchKeyEvent (synthetic JS events don't trigger the
// browser's trusted paste), then count how many times the clipboard text is
// sent to the PTY. 1 = fixed, 2 = still doubling.
// Usage: node scripts/cdp-paste-test.mjs <port> <expectedText>

import http from "node:http";

const PORT = Number(process.argv[2]);
const TEXT = process.argv[3] ?? "PASTECHK987";

const getPages = () =>
  new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d)));
    }).on("error", reject);
  });

const pages = await getPages();
const page = pages.find((p) => p.type === "page");
if (!page) { console.error("no page"); process.exit(1); }

const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});

const evaluate = (expression) =>
  send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((r) => ws.addEventListener("open", r));

// 1) Patch invoke to record pty_write; focus the terminal textarea.
const setup = await evaluate(`(() => {
  const I = window.__TAURI_INTERNALS__;
  if (!I.__origInvoke) { I.__origInvoke = I.invoke.bind(I); }
  window.__writes = [];
  I.invoke = (cmd, args) => {
    if (cmd === 'pty_write') window.__writes.push(String(args && args.data));
    return I.__origInvoke(cmd, args);
  };
  const ta = document.querySelector('.xterm-helper-textarea');
  if (ta) ta.focus();
  return JSON.stringify({ focused: document.activeElement && document.activeElement.className, hasTextarea: !!ta });
})()`);
console.log("setup:", setup.result?.result?.value);

// 1b) Control: a normal keystroke should produce exactly one pty_write.
await send("Input.dispatchKeyEvent", { type: "keyDown", text: "k", key: "k", code: "KeyK", windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "k", code: "KeyK", windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75 });
await sleep(400);
const afterKey = await evaluate(`JSON.stringify({ writes: (window.__writes||[]).length, data: (window.__writes||[]).slice(-3) })`);
console.log("afterKey:", afterKey.result?.result?.value);

// 2) Fire a REAL Ctrl+V.
const CTRL = 2;
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: CTRL, key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 });
await send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: CTRL, key: "v", code: "KeyV", windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86 });
await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: CTRL, key: "v", code: "KeyV", windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86 });
await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 0, key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 });

await sleep(1500);

// 3) Read what hit the PTY.
const res = await evaluate(`(() => {
  const writes = window.__writes || [];
  const joined = writes.join('');
  const re = new RegExp(${JSON.stringify(TEXT)}, 'g');
  const count = (joined.match(re) || []).length;
  return JSON.stringify({ count, writeCount: writes.length, sample: writes.slice(0,6) });
})()`);
console.log("RESULT:", res.result?.result?.value);

ws.close();
process.exit(0);
