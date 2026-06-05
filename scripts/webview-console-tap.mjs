#!/usr/bin/env node
// Connect to a WebView2 instance running with --remote-debugging-port=<port>
// and stream console messages + exceptions to stdout.
//
// Usage:
//   1. Launch vibe-term with the env var:
//        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
//   2. node scripts/webview-console-tap.mjs [port]
//
// The script keeps running until you Ctrl+C.

import http from "node:http";
// Node 22+ exposes WebSocket on globalThis. No external dep needed.

const PORT = Number(process.argv[2] ?? 9222);

function getTargets() {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${PORT}/json`, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

const stamp = () => new Date().toISOString().slice(11, 23);

async function main() {
  const targets = await getTargets();
  const page = targets.find((t) => t.type === "page") ?? targets[0];
  if (!page) {
    console.error(`[tap] no debuggable page on :${PORT}`);
    process.exit(1);
  }
  console.log(`[tap] attaching to ${page.url} (${page.title})`);

  const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const send = (method, params = {}) =>
    ws.send(JSON.stringify({ id: ++id, method, params }));

  ws.addEventListener("open", () => {
    send("Runtime.enable");
    send("Log.enable");
    send("Network.enable");
    console.log(`[tap] ${stamp()} connected, subscriptions live`);
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    } catch {
      return;
    }
    if (!msg.method) return;
    if (msg.method === "Runtime.consoleAPICalled") {
      const { type, args, stackTrace } = msg.params;
      const text = (args || [])
        .map((a) => {
          if (a.value !== undefined) {
            return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
          }
          if (a.preview) {
            // ObjectPreview from CDP: format as {k:v, k:v}
            const props = (a.preview.properties || [])
              .map((p) => `${p.name}:${p.value ?? p.subtype ?? "?"}`)
              .join(", ");
            return `{${props}}`;
          }
          return a.description || `<${a.type}>`;
        })
        .join(" ");
      let suffix = "";
      if (stackTrace && stackTrace.callFrames?.[0]) {
        const f = stackTrace.callFrames[0];
        suffix = `  @${f.url}:${f.lineNumber}:${f.columnNumber}`;
      }
      console.log(`[${stamp()}][${type}] ${text}${suffix}`);
    } else if (msg.method === "Runtime.exceptionThrown") {
      const ex = msg.params.exceptionDetails;
      console.log(
        `[${stamp()}][EXCEPTION] ${ex.text} ${
          ex.exception?.description ?? ""
        }`,
      );
      if (ex.stackTrace?.callFrames) {
        for (const f of ex.stackTrace.callFrames.slice(0, 8)) {
          console.log(`    at ${f.functionName || "<anon>"} (${f.url}:${f.lineNumber})`);
        }
      }
    } else if (msg.method === "Log.entryAdded") {
      const e = msg.params.entry;
      console.log(`[${stamp()}][${e.source}/${e.level}] ${e.text}`);
    } else if (msg.method === "Network.loadingFailed") {
      const p = msg.params;
      console.log(`[${stamp()}][net-fail] ${p.errorText} (${p.type})`);
    }
  });

  ws.addEventListener("error", (ev) =>
    console.error(`[tap] ws error: ${ev?.error?.message ?? ev?.message ?? "unknown"}`),
  );
  ws.addEventListener("close", () => {
    console.log(`[tap] ws closed`);
    process.exit(0);
  });

  process.on("SIGINT", () => {
    console.log(`[tap] stopping`);
    ws.close();
  });
}

main().catch((e) => {
  console.error(`[tap] fatal: ${e.stack || e.message}`);
  process.exit(1);
});
