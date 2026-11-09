// When a URL is asked again. Sites have bad minutes: overloaded, restarting, rate limiting. One
// failed request shouldn't stand for a whole week, so anything but a 200 is asked once more soon and
// once more later in the same run. The rule looks only at the status, never the content, and every
// attempt stays in the manifest, so a retry adds evidence and can't hide any.

import type { ManifestHop } from "./manifest";

/** The quick recheck: long enough for a blip to pass, short enough to stay in the same moment. */
export const QUICK_RETRY_MS = 15_000;
/** The later recheck, counted from the quick one. */
export const LATER_RETRY_MS = 10 * 60_000;
/** A server's Retry-After is honored for the quick recheck up to this long. */
export const RETRY_AFTER_CAP_MS = 2 * 60_000;
/**
 * After this many quick rechecks on one host that got no response at all, the host's remaining
 * URLs skip the quick recheck and wait for the later one. A host that's down stays down for a
 * minute, and each timeout ties up its worker.
 */
export const DOWN_AFTER = 2;

/** Pure: does this outcome get asked again? Anything but a 200, judged on the last hop alone. */
export const needsRetry = (hops: ManifestHop[]) => hops.at(-1)?.status !== 200;

/** Pure: the attempt got nothing back from the server, not even a status line. */
export const noResponse = (hops: ManifestHop[]) => (hops.at(-1)?.status ?? null) === null;

/**
 * Pure: how long to wait before the quick recheck. Our own delay, or the server's Retry-After when
 * it asks for longer and the wait fits in the cap. Past the cap the quick recheck is skipped
 * (`null`), and the later one still happens.
 */
export function quickDelay(retryAfter: string | undefined, now: number): number | null {
  if (!retryAfter) return QUICK_RETRY_MS;
  const seconds = Number(retryAfter.trim());
  const asked = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
  if (!Number.isFinite(asked)) return QUICK_RETRY_MS;
  if (asked > RETRY_AFTER_CAP_MS) return null;
  return Math.max(QUICK_RETRY_MS, asked);
}
