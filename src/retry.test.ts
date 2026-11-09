import { describe, expect, test } from "bun:test";
import type { ManifestHop } from "./manifest";
import { needsRetry, noResponse, QUICK_RETRY_MS, quickDelay, RETRY_AFTER_CAP_MS } from "./retry";

const hop = (status: number | null): ManifestHop => ({ status }) as ManifestHop;

describe("needsRetry", () => {
  test("anything but a 200 on the last hop", () => {
    expect(needsRetry([hop(200)])).toBe(false);
    expect(needsRetry([hop(301), hop(200)])).toBe(false);
    for (const status of [202, 301, 403, 404, 429, 500, 503, null]) expect(needsRetry([hop(status)])).toBe(true);
    expect(needsRetry([])).toBe(true);
  });

  test("no response is a missing status line, not an error code", () => {
    expect(noResponse([hop(null)])).toBe(true);
    expect(noResponse([hop(503)])).toBe(false);
  });
});

describe("quickDelay", () => {
  const now = Date.parse("2026-11-09T10:00:00Z");

  test("our own delay without a Retry-After, or with one we can't read", () => {
    expect(quickDelay(undefined, now)).toBe(QUICK_RETRY_MS);
    expect(quickDelay("soon", now)).toBe(QUICK_RETRY_MS);
  });

  test("a longer Retry-After in seconds or as a date is honored", () => {
    expect(quickDelay("60", now)).toBe(60_000);
    expect(quickDelay(new Date(now + 90_000).toUTCString(), now)).toBe(90_000);
  });

  test("never sooner than our own delay", () => {
    expect(quickDelay("1", now)).toBe(QUICK_RETRY_MS);
    expect(quickDelay(new Date(now - 5_000).toUTCString(), now)).toBe(QUICK_RETRY_MS);
  });

  test("past the cap the quick recheck is skipped and the later one waits", () => {
    expect(quickDelay(String(RETRY_AFTER_CAP_MS / 1000 + 1), now)).toBeNull();
  });
});
