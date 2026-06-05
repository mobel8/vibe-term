#!/usr/bin/env node
// Capture a screenshot of the running WebView2 via CDP. Usage: node cdp-shot.mjs <port> <outPath>
import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.argv[2]);
const OUT = process.argv[3] ?? "shot.png";

const pages = await new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
    let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d)));
  }).on("error", reject);
});
const page = pages.find((p) => p.type === "page");
const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.addEventListener("message", (ev) => { const m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener("open", r));
const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) { fs.writeFileSync(OUT, Buffer.from(shot.result.data, "base64")); console.log("saved", OUT); }
else { console.error("no screenshot data", JSON.stringify(shot).slice(0, 300)); }
ws.close(); process.exit(0);
