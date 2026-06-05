// vibe-term — frontend logger.
//
// A tiny structured-log wrapper that does three useful things:
//
//   1. Filters by level. In `import.meta.env.DEV` builds everything is
//      emitted; in production we keep `warn` and `error` only so the user's
//      devtools console stays quiet.
//   2. Prefixes every entry with `[scope]` so console logs from terminal
//      panes, the IPC layer, hotkey handlers etc. are visually grouped.
//   3. Best-effort forwards `warn`/`error` to the Rust side via
//      `@tauri-apps/plugin-log`. When the plugin is unreachable (running
//      under vitest, in a browser preview, or before the IPC handshake
//      completes) the call is dropped silently — the logger MUST NEVER
//      throw.
//
// Structured payload (the optional `meta` map) is serialised as JSON when
// printing to the console, and stitched into the backend message so the
// `tauri-plugin-log` writer can grep on it.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogPayload {
  scope: string;
  msg: string;
  meta?: Record<string, unknown>;
  ts: number;
  level: LogLevel;
}

// ─── Configuration ────────────────────────────────────────────────────────────

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

interface LoggerConfig {
  /** When false, the logger acts as a near no-op (warn/error only). */
  dev: boolean;
  /** Minimum level that reaches the console. Computed from `dev` by default. */
  threshold: LogLevel;
}

function detectDev(): boolean {
  // Vite injects `import.meta.env.DEV` at build time. Tests run under vitest
  // also set `DEV` to true, which matches what we want.
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    // Some test runners polyfill `import.meta` partially — be defensive.
    return false;
  }
}

let config: LoggerConfig = {
  dev: detectDev(),
  threshold: detectDev() ? "debug" : "warn",
};

/**
 * Reconfigure the logger at runtime. Useful for tests that toggle DEV mode,
 * and for the settings UI if we ever expose a verbosity slider.
 */
export function configureLogger(next: Partial<LoggerConfig>): void {
  config = { ...config, ...next };
}

/** Returns the current logger configuration. Exported for tests/debug. */
export function getLoggerConfig(): Readonly<LoggerConfig> {
  return config;
}

// ─── Backend pipe (best-effort) ───────────────────────────────────────────────

// We resolve `@tauri-apps/plugin-log` lazily so the logger module can be
// imported in pure-Node tests without bringing the IPC layer to life. Any
// failure to import or invoke the plugin must NEVER reach the caller — we
// trade visibility for robustness here, because a logger that throws inside
// an error handler is strictly worse than a silent one.

type BackendSink = (msg: string) => Promise<void>;

interface BackendSinks {
  warn: BackendSink;
  error: BackendSink;
}

let backendSinks: BackendSinks | null | undefined; // undefined = not resolved yet, null = unavailable
let backendSinksPromise: Promise<BackendSinks | null> | null = null;

function noopSink(): Promise<void> {
  return Promise.resolve();
}

function resolveBackendSinks(): Promise<BackendSinks | null> {
  if (backendSinks !== undefined) return Promise.resolve(backendSinks);
  if (backendSinksPromise) return backendSinksPromise;
  backendSinksPromise = (async () => {
    try {
      const mod = await import("@tauri-apps/plugin-log");
      backendSinks = {
        warn: (m) => mod.warn(m).catch(() => undefined),
        error: (m) => mod.error(m).catch(() => undefined),
      };
    } catch {
      backendSinks = null;
    }
    return backendSinks;
  })();
  return backendSinksPromise;
}

function sendToBackend(level: LogLevel, line: string): void {
  if (level !== "warn" && level !== "error") return;
  // Fire-and-forget. Awaiting would gate caller code on IPC latency for
  // zero practical benefit.
  void resolveBackendSinks().then((sinks) => {
    if (!sinks) return;
    const fn = level === "warn" ? sinks.warn : sinks.error;
    return fn(line).catch(() => undefined);
  });
}

/** Reset the cached backend sink. Test-only. */
export function _resetBackendSinks(): void {
  backendSinks = undefined;
  backendSinksPromise = null;
}

// ─── Core ─────────────────────────────────────────────────────────────────────

function shouldLog(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[config.threshold];
}

function formatLine(payload: LogPayload): string {
  // The format is intentionally human-readable; structured consumers should
  // hook into the `meta` field via `attachLogger` on the backend plugin
  // rather than parse this line.
  const base = `[${payload.scope}] ${payload.msg}`;
  if (!payload.meta || Object.keys(payload.meta).length === 0) return base;
  // JSON.stringify with a replacer to swallow circular refs — we use the
  // standard tag trick rather than pulling in a dependency.
  try {
    return `${base} ${safeStringify(payload.meta)}`;
  } catch {
    return base;
  }
}

function safeStringify(value: unknown): string {
  // Track only the current ancestor chain, not every visited node, so that a
  // shared-but-acyclic reference (e.g. `{ a: shared, b: shared }`) is printed
  // in full rather than collapsed to "[Circular]" on its second occurrence.
  // We keep JSON.stringify + replacer (rather than a hand-rolled encoder) so
  // that toJSON hooks — Date in particular — keep working. The replacer's
  // `this` is the holder of the current key, which lets us pop the stack as
  // the DFS unwinds back to an ancestor holder.
  const stack: unknown[] = [];
  return JSON.stringify(value, function (this: unknown, _key, v) {
    if (typeof v === "object" && v !== null) {
      // Unwind to the holder of the value currently being serialised.
      while (stack.length > 0 && stack[stack.length - 1] !== this) stack.pop();
      if (stack.includes(v)) return "[Circular]";
      stack.push(v);
    }
    if (v instanceof Error) {
      return { name: v.name, message: v.message, stack: v.stack };
    }
    return v;
  });
}

function consoleFor(level: LogLevel): (...args: unknown[]) => void {
  switch (level) {
    case "debug":
      return console.debug?.bind(console) ?? console.log.bind(console);
    case "info":
      return console.info?.bind(console) ?? console.log.bind(console);
    case "warn":
      return console.warn.bind(console);
    case "error":
      return console.error.bind(console);
  }
}

function log(
  level: LogLevel,
  scope: string,
  msg: string,
  meta?: Record<string, unknown>,
): void {
  if (!shouldLog(level)) return;
  const payload: LogPayload = {
    scope,
    msg,
    meta,
    ts: Date.now(),
    level,
  };

  // Never let logging break the caller. A logger that throws inside an
  // error boundary is worse than a logger that does nothing.
  try {
    const line = formatLine(payload);
    consoleFor(level)(line);
    sendToBackend(level, line);
  } catch {
    // Swallow — there is literally nowhere safe to escalate this.
  }
}

/** Public API. Always call by named export, not as `default`. */
export const logger = {
  debug(scope: string, msg: string, meta?: Record<string, unknown>): void {
    log("debug", scope, msg, meta);
  },
  info(scope: string, msg: string, meta?: Record<string, unknown>): void {
    log("info", scope, msg, meta);
  },
  warn(scope: string, msg: string, meta?: Record<string, unknown>): void {
    log("warn", scope, msg, meta);
  },
  error(scope: string, msg: string, meta?: Record<string, unknown>): void {
    log("error", scope, msg, meta);
  },
};

// Re-export the noop for callers that need to disable the backend pipe in
// tests without having to mock the entire plugin module.
export const _noopSink: BackendSink = noopSink;
