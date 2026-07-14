#!/usr/bin/env node
// Dispatch REAL (trusted) input events into the WebView2 page via CDP.
// Usage:
//   node scripts/cdp-input.mjs <port> wheel <x> <y> <deltaY> [count]
//   node scripts/cdp-input.mjs <port> click <x> <y>
//   node scripts/cdp-input.mjs <port> type "<text>"
//   node scripts/cdp-input.mjs <port> key <key> [ctrl|shift|alt ...]
// Coordinates are CSS pixels in the page. `type` sends per-char keyDown/keyUp
// with `text` so xterm receives real keystrokes (not synthetic JS events).

import http from "node:http";

const [, , portArg, cmd, ...rest] = process.argv;
const PORT = Number(portArg);
if (!PORT || !cmd) {
  console.error("usage: cdp-input.mjs <port> wheel|click|type|key ...");
  process.exit(1);
}

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
  console.error("no page");
  process.exit(1);
}

const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
  const p = pending.get(msg.id);
  if (p) {
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }
});

const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

ws.addEventListener("open", async () => {
  try {
    if (cmd === "wheel") {
      const [x, y, deltaY, count = "1"] = rest;
      for (let i = 0; i < Number(count); i++) {
        await send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: Number(x),
          y: Number(y),
          deltaX: 0,
          deltaY: Number(deltaY),
          pointerType: "mouse",
        });
      }
      console.log(`wheel x${count} deltaY=${deltaY} @${x},${y}`);
    } else if (cmd === "click") {
      const [x, y] = rest.map(Number);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      console.log(`click @${x},${y}`);
    } else if (cmd === "type") {
      const text = rest.join(" ");
      for (const ch of text) {
        if (ch === "\n") {
          await send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
          await send("Input.dispatchKeyEvent", { type: "char", text: "\r" });
          await send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
        } else {
          await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch });
          await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
        }
      }
      console.log(`typed ${JSON.stringify(text)}`);
    } else if (cmd === "key") {
      const [key, ...mods] = rest;
      const modifiers = mods.reduce((m, k) => m | (MODS[k] ?? 0), 0);
      const named = { Enter: 13, Escape: 27, Backspace: 8, Tab: 9, PageUp: 33, PageDown: 34 };
      // Single letters/digits: vk = uppercase char code, code = KeyX/DigitN —
      // what a real accelerator chord (Ctrl+Shift+D…) produces.
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
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: vk, key: evKey, code, modifiers });
      if (key === "Enter") await send("Input.dispatchKeyEvent", { type: "char", text: "\r", modifiers });
      await send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: vk, key: evKey, code, modifiers });
      console.log(`key ${evKey} code=${code} mods=${modifiers}`);
    } else {
      console.error("unknown cmd", cmd);
    }
  } catch (e) {
    console.error("FAIL:", e.message);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
});
ws.addEventListener("close", () => process.exit());
