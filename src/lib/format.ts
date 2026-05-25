// vibe-term — Display formatting helpers.
//
// Pure functions: no Tauri, no React, no time-dependent globals beyond
// `Date.now()`. Everything is unit-tested in `format.test.ts`.
//
// We deliberately keep the output English-only for now; once we add i18n the
// callers will plug their formatter through `Intl.RelativeTimeFormat` etc.

// ───────────────────────── relative time ─────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Human-friendly elapsed time:
 *   - <45s        → "just now"
 *   - <60min      → "N min ago"
 *   - <24h        → "N h ago"
 *   - same calendar day yesterday → "yesterday"
 *   - <7 days     → "N days ago"
 *   - otherwise   → "MMM D" (e.g. "Mar 5")
 *
 * Future dates fall back to "in N min" / "in N h" / "MMM D".
 */
export function relativeTime(value: Date | number, now: number = Date.now()): string {
  const ts = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(ts)) return "";
  const diff = now - ts;
  const abs = Math.abs(diff);

  // Future
  if (diff < 0) {
    if (abs < 45_000) return "in a moment";
    if (abs < HOUR) return `in ${Math.round(abs / MINUTE)} min`;
    if (abs < DAY) return `in ${Math.round(abs / HOUR)} h`;
    return formatShortDate(new Date(ts));
  }

  if (abs < 45_000) return "just now";
  if (abs < HOUR) return `${Math.max(1, Math.floor(abs / MINUTE))} min ago`;
  if (abs < DAY) return `${Math.floor(abs / HOUR)} h ago`;

  // Same-day comparisons need calendar math, not raw diffs (DST etc.).
  const nowDate = new Date(now);
  const valueDate = new Date(ts);
  const dayDiff = calendarDayDiff(nowDate, valueDate);
  if (dayDiff === 1) return "yesterday";
  if (dayDiff > 1 && abs < WEEK) return `${dayDiff} days ago`;

  return formatShortDate(valueDate);
}

function calendarDayDiff(now: Date, past: Date): number {
  const a = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const b = Date.UTC(past.getFullYear(), past.getMonth(), past.getDate());
  return Math.round((a - b) / DAY);
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatShortDate(d: Date): string {
  return `${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// ───────────────────────── bytes ─────────────────────────

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * Format a byte count using binary multiples (1 KB = 1024 B). Values smaller
 * than a kilobyte are rendered as integer bytes; everything else uses one
 * decimal digit and rounds half-to-even via `toFixed`.
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "0 B";
  const sign = n < 0 ? "-" : "";
  let abs = Math.abs(n);
  if (abs < 1024) return `${sign}${Math.round(abs)} B`;
  let unit = 0;
  while (abs >= 1024 && unit < BYTE_UNITS.length - 1) {
    abs /= 1024;
    unit++;
  }
  // Drop a trailing ".0" so "1.0 MB" doesn't look noisier than "850 KB".
  const formatted = abs >= 100 ? abs.toFixed(0) : abs.toFixed(1).replace(/\.0$/, "");
  return `${sign}${formatted} ${BYTE_UNITS[unit]}`;
}

// ───────────────────────── tokens ─────────────────────────

/**
 * Compact AI-token count. Mirrors what the Anthropic dashboard shows: small
 * counts as integers, then "1.2k", "12k", "1.2M".
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs < 1000) return `${sign}${Math.round(abs)}`;
  if (abs < 1_000_000) {
    const v = abs / 1000;
    return `${sign}${v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const v = abs / 1_000_000;
  return `${sign}${v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "")}M`;
}

// ───────────────────────── durations ─────────────────────────

/**
 * Human-readable duration:
 *   - <1s   → "Nms"
 *   - <60s  → "N.Ns" (one decimal)
 *   - <60m  → "N min Ns" (or "N min" when seconds are 0)
 *   - else  → "N h M min"
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "0ms";
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);

  if (abs < 1000) return `${sign}${Math.round(abs)}ms`;

  if (abs < MINUTE) {
    const v = abs / 1000;
    return `${sign}${v.toFixed(1).replace(/\.0$/, "")}s`;
  }

  if (abs < HOUR) {
    const minutes = Math.floor(abs / MINUTE);
    const seconds = Math.round((abs % MINUTE) / 1000);
    if (seconds === 0) return `${sign}${minutes} min`;
    // Guard against the rounded seconds rolling over to 60.
    if (seconds === 60) return `${sign}${minutes + 1} min`;
    return `${sign}${minutes} min ${seconds}s`;
  }

  const hours = Math.floor(abs / HOUR);
  const minutes = Math.round((abs % HOUR) / MINUTE);
  if (minutes === 0) return `${sign}${hours} h`;
  if (minutes === 60) return `${sign}${hours + 1} h`;
  return `${sign}${hours} h ${minutes} min`;
}
