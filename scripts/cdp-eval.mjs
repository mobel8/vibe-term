#!/usr/bin/env node
// Evaluate JS expressions in the running WebView2 via CDP.
// Usage: node scripts/cdp-eval.mjs <port> '<js expression>'

import http from "node:http";

const PORT = Number(process.argv[2]);
const EXPR = process.argv[3];

if (!PORT || !EXPR) {
  console.error("usage: node cdp-eval.mjs <port> '<js>'");
  process.exit(1);
}

const getPages = () =>
  new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });

const pages = await getPages();
const page = pages.find((p) => p.type === "page");
if (!page) {
  console.error("no page found");
  process.exit(1);
}

const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const inflight = new Map();

ws.addEventListener("open", () => {
  const myId = ++id;
  inflight.set(myId, "eval");
  ws.send(JSON.stringify({
    id: myId,
    method: "Runtime.evaluate",
    params: {
      expression: `(async () => { return (${EXPR}); })()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: 5000,
    },
  }));
});

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
  if (inflight.has(msg.id)) {
    if (msg.error) {
      console.error("CDP error:", msg.error);
    } else if (msg.result?.exceptionDetails) {
      console.error("JS exception:", msg.result.exceptionDetails.text, msg.result.exceptionDetails.exception?.description);
    } else {
      const r = msg.result?.result;
      if (r?.type === "object" || r?.type === "array") {
        console.log(JSON.stringify(r.value, null, 2));
      } else {
        console.log(r?.value ?? r?.description ?? "(no value)");
      }
    }
    ws.close();
  }
});

ws.addEventListener("error", (e) => {
  console.error("ws error:", e?.error?.message ?? e?.message ?? "unknown");
  process.exit(1);
});

ws.addEventListener("close", () => process.exit(0));
