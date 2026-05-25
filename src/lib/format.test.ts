import { describe, expect, it } from "vitest";

import {
  formatBytes,
  formatDuration,
  formatTokens,
  relativeTime,
} from "./format";

describe("relativeTime", () => {
  // Anchor "now" on a known timestamp so the tests are not flaky.
  const NOW = new Date("2026-05-25T12:00:00.000Z").getTime();

  it("returns 'just now' for sub-45s deltas", () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe("just now");
    expect(relativeTime(NOW, NOW)).toBe("just now");
  });

  it("returns minutes for 45s < dt < 1h", () => {
    expect(relativeTime(NOW - 2 * 60_000, NOW)).toBe("2 min ago");
    expect(relativeTime(NOW - 59 * 60_000, NOW)).toBe("59 min ago");
  });

  it("returns hours for 1h ≤ dt < 24h", () => {
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
  });

  it("returns 'yesterday' for prior calendar day", () => {
    const yesterday = new Date(NOW);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    yesterday.setUTCHours(2, 0, 0, 0); // any time on the previous day
    expect(relativeTime(yesterday.getTime(), NOW)).toBe("yesterday");
  });

  it("returns N days ago within the past week", () => {
    const threeDaysAgo = new Date(NOW);
    threeDaysAgo.setUTCDate(threeDaysAgo.getUTCDate() - 3);
    threeDaysAgo.setUTCHours(8, 0, 0, 0);
    expect(relativeTime(threeDaysAgo.getTime(), NOW)).toBe("3 days ago");
  });

  it("falls back to MMM D for older dates", () => {
    const old = new Date("2026-03-05T08:00:00Z").getTime();
    expect(relativeTime(old, NOW)).toBe("Mar 5");
  });

  it("handles future dates", () => {
    expect(relativeTime(NOW + 5 * 60_000, NOW)).toBe("in 5 min");
    expect(relativeTime(NOW + 3 * 3_600_000, NOW)).toBe("in 3 h");
  });

  it("returns empty string on non-finite input", () => {
    expect(relativeTime(Number.NaN, NOW)).toBe("");
  });

  it("accepts a Date object", () => {
    const d = new Date(NOW - 5 * 60_000);
    expect(relativeTime(d, NOW)).toBe("5 min ago");
  });
});

describe("formatBytes", () => {
  it("formats values smaller than a kilobyte in bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("rolls into KB, MB, GB, TB", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1500)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(850 * 1024 * 1024)).toBe("850 MB");
    expect(formatBytes(1024 ** 3)).toBe("1 GB");
    expect(formatBytes(1024 ** 4)).toBe("1 TB");
  });

  it("handles negative and non-finite values", () => {
    expect(formatBytes(-1024)).toBe("-1 KB");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });

  it("drops decimals when ≥ 100 within a unit", () => {
    expect(formatBytes(150 * 1024)).toBe("150 KB");
  });
});

describe("formatTokens", () => {
  it("formats small counts as integers", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(830)).toBe("830");
    expect(formatTokens(999)).toBe("999");
  });

  it("uses k for thousands", () => {
    expect(formatTokens(1200)).toBe("1.2k");
    expect(formatTokens(12_000)).toBe("12k");
    expect(formatTokens(123_456)).toBe("123k");
  });

  it("uses M for millions", () => {
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(12_000_000)).toBe("12M");
  });

  it("handles negative and non-finite values", () => {
    expect(formatTokens(-1500)).toBe("-1.5k");
    expect(formatTokens(Number.NaN)).toBe("0");
  });
});

describe("formatDuration", () => {
  it("renders sub-second values in ms", () => {
    expect(formatDuration(12)).toBe("12ms");
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("renders seconds with one decimal under a minute", () => {
    expect(formatDuration(1400)).toBe("1.4s");
    expect(formatDuration(2000)).toBe("2s");
    expect(formatDuration(59_500)).toBe("59.5s");
  });

  it("renders minutes and seconds for sub-hour values", () => {
    expect(formatDuration(3 * 60_000 + 12_000)).toBe("3 min 12s");
    expect(formatDuration(5 * 60_000)).toBe("5 min");
  });

  it("renders hours and minutes for ≥ 1h", () => {
    expect(formatDuration(2 * 3_600_000 + 15 * 60_000)).toBe("2 h 15 min");
    expect(formatDuration(3 * 3_600_000)).toBe("3 h");
  });

  it("handles negative and non-finite values", () => {
    expect(formatDuration(-12_000)).toBe("-12s");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0ms");
  });
});
