import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  judged,
  keyedRequests,
  noJob,
  originOf,
  pagesOf,
  type SaveAttempt,
  type StoredRecord,
  saveQueue,
  settled,
  withSnapshot,
} from "./archive";

const source = (url: string, origin: "cited" | "discovered" = "cited") => ({
  url,
  cited_by: [],
  positions: 0,
  publish: "public" as const,
  origin,
});

const wayback = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace(/\D/g, "").slice(0, 14);

const held = (timestamp: string, extra: Partial<StoredRecord> = {}): StoredRecord => ({
  url: `https://web.archive.org/web/${timestamp}id_/https://a.org/`,
  timestamp,
  digest: "D",
  checked_at: "2026-10-30T00:00:00.000Z",
  ...extra,
});

const attempt = (overrides: Partial<SaveAttempt> = {}): SaveAttempt => ({
  at: "2026-10-30T20:00:00.000Z",
  via: "key",
  outcome: "pending",
  ...overrides,
});

describe("saveQueue", () => {
  test("a page cited under several fragments is one request", () => {
    const sources = [source("https://a.org/x.pdf#page=1"), source("https://a.org/x.pdf#page=2")];
    expect(pagesOf(sources).get("https://a.org/x.pdf")?.urls).toHaveLength(2);
    expect(saveQueue(sources, {}).map((q) => q.page)).toEqual(["https://a.org/x.pdf"]);
  });

  test("orders by need alone: cited, then no snapshot, then oldest, then URL", () => {
    const sources = [
      source("https://z.org/old"),
      source("https://a.org/older"),
      source("https://y.org/none"),
      source("https://b.org/none"),
      source("https://a.org/discovered", "discovered"),
    ];
    const records = {
      "https://z.org/old": held(wayback(20)),
      "https://a.org/older": held(wayback(40)),
    };
    expect(saveQueue(sources, records).map((q) => q.page)).toEqual([
      "https://b.org/none",
      "https://y.org/none",
      "https://a.org/older",
      "https://z.org/old",
      "https://a.org/discovered",
    ]);
  });

  test("never sends a host on the personal data list, or its subdomains", () => {
    const sources = [
      source("https://www.social.com/post"),
      source("https://m.social.com/post"),
      source("https://notsocial.com/post"),
    ];
    expect(saveQueue(sources, {}, ["social.com"]).map((q) => q.page)).toEqual([
      "https://notsocial.com/post",
    ]);
  });

  test("skips a citation that's already a Wayback link", () => {
    expect(saveQueue([source("https://web.archive.org/web/2026/https://a.org/")], {})).toEqual([]);
  });

  test("skips a recent snapshot, a recent ask, and counts a held-back snapshot as recent", () => {
    const sources = [source("https://a.org/1"), source("https://a.org/2"), source("https://a.org/3")];
    const now = new Date().toISOString();
    const records = {
      "https://a.org/1": held(wayback(2)),
      "https://a.org/2": held(wayback(30), { save: attempt({ at: now, outcome: "failed" }) }),
      "https://a.org/3": held(wayback(30), { fewer_in: wayback(1) }),
    };
    expect(saveQueue(sources, records)).toEqual([]);
  });
});

describe("originOf", () => {
  const save = attempt({ outcome: "captured", snapshot: "20261030200010" });

  test("ours only when the Archive's reply named it", () => {
    expect(originOf("20261030200010", held("", { save }))).toBe("requested");
  });
  test("no request means it was already there", () => {
    expect(originOf("20261030200010", undefined)).toBe("existing");
  });
  test("a snapshot from before the request isn't ours", () => {
    expect(originOf("20261001000000", held("", { save }))).toBe("existing");
  });
  test("the Archive answering with an older copy isn't ours", () => {
    const already = attempt({ outcome: "already-archived", snapshot: "20261029000000" });
    expect(originOf("20261029000000", held("", { save: already }))).toBe("existing");
  });
  test("a later snapshot that no reply named stays unknown", () => {
    expect(originOf("20261030230000", held("", { save }))).toBeUndefined();
  });
  test("a named snapshot the Archive didn't attribute stays unknown", () => {
    const asked = attempt({ outcome: "asked", snapshot: "20261030220000" });
    expect(originOf("20261030220000", held("", { save: asked }))).toBeUndefined();
  });
  test("a request with no recorded reply stays unknown, in either direction", () => {
    const legacy = held("", { save_requested_at: "2026-10-30T17:47:33.216Z" });
    expect(originOf("20261030174718", legacy)).toBeUndefined();
  });
});

describe("settled", () => {
  test("a new capture is ours, an older one isn't", () => {
    expect(settled(attempt(), { status: "success", timestamp: "20261030200012" }).outcome).toBe(
      "captured",
    );
    expect(settled(attempt(), { status: "success", timestamp: "20261028000000" }).outcome).toBe(
      "already-archived",
    );
  });
  test("keeps the redirect target and the error, and leaves a running job alone", () => {
    const done = { status: "success", timestamp: "20261030200012", original_url: "https://a.org/b" };
    expect(settled(attempt(), done).final_url).toBe("https://a.org/b");
    expect(settled(attempt(), { status: "error", status_ext: "error:not-found" })).toMatchObject({
      outcome: "failed",
      error: "error:not-found",
    });
    expect(settled(attempt(), { status: "pending" }).outcome).toBe("pending");
  });
});

describe("snapshots never lose statements", () => {
  const url = "https://web.archive.org/web/20261030000000id_/https://a.org/";
  const older = held("20261001000000", {
    statements: { found: 5, of: 5 },
    compared: "20261001000000",
  });

  test("a newer snapshot waits beside one that holds statements", () => {
    const next = withSnapshot(older, url, "20261030000000", "E", "now");
    expect(next.timestamp).toBe("20261001000000");
    expect(next.statements).toEqual({ found: 5, of: 5 });
    expect(next.candidate?.timestamp).toBe("20261030000000");
  });

  test("it replaces the older one only if it keeps up", () => {
    const waiting = withSnapshot(older, url, "20261030000000", "E", "now");
    const worse = judged(waiting, { found: 2, of: 5 });
    expect(worse).toMatchObject({ timestamp: "20261001000000", fewer_in: "20261030000000" });
    expect(worse.candidate).toBeUndefined();
    expect(judged(waiting, { found: 5, of: 5 })).toMatchObject({
      timestamp: "20261030000000",
      compared: "20261030000000",
    });
  });

  test("a rejected snapshot isn't offered again", () => {
    const waiting = withSnapshot(older, url, "20261030000000", "E", "now");
    const worse = judged(waiting, { found: 2, of: 5 });
    expect(withSnapshot(worse, url, "20261030000000", "E", "later").candidate).toBeUndefined();
  });

  test("a first snapshot, or one that held nothing, is simply replaced", () => {
    expect(withSnapshot(undefined, url, "20261030000000", "E", "now").origin).toBe("existing");
    const empty = held("20261001000000", { statements: { found: 0, of: 5 } });
    const next = withSnapshot(empty, url, "20261030000000", "E", "now");
    expect(next.timestamp).toBe("20261030000000");
    expect(next.statements).toBeUndefined();
  });

  test("a job finishing after lookup still marks the same snapshot as ours", () => {
    const seen = held("20261030200012");
    const save = attempt({ outcome: "captured", snapshot: "20261030200012" });
    expect(withSnapshot({ ...seen, save }, url, "20261030200012", "D", "now").origin).toBe("requested");
  });
});

describe("keyedRequests", () => {
  const gaps = { save: 0, drain: 0, drainFor: 50, sessionFor: 50 };
  const queue = saveQueue([source("https://a.org/1"), source("https://b.org/2")], {});
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const asJobs = (id: string) => [{ status: "success", job_id: id, timestamp: "29991231235959" }];
  let spy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => spy?.mockRestore());

  const answer = (save: (call: number) => Response, busy = 0) => {
    let calls = 0;
    let waits = busy;
    const seen: { url: string; authorization: string | null }[] = [];
    spy = spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
      const text = String(url);
      seen.push({ url: text, authorization: new Headers(init?.headers).get("authorization") });
      if (text.includes("/status/user")) return json({ available: waits-- > 0 ? 0 : 3, processing: 0 });
      if (text.endsWith("/status")) {
        const ids = new URLSearchParams(String(init?.body)).get("job_ids") ?? "";
        return json(ids.split(",").flatMap(asJobs));
      }
      return save(++calls);
    }) as unknown as typeof fetch);
    return seen;
  };

  test("sends the key, and records what each job produced", async () => {
    const seen = answer((call) => json({ url: "x", job_id: `job-${call}` }));
    const records = {};
    await keyedRequests("LOW a:b", queue, records, 5, Number.POSITIVE_INFINITY, () => {}, gaps);
    expect(seen.every((call) => call.authorization === "LOW a:b")).toBe(true);
    expect(records).toMatchObject({
      "https://a.org/1": { save: { via: "key", outcome: "captured", job_id: "job-1" } },
      "https://b.org/2": { save: { outcome: "captured", snapshot: "29991231235959" } },
    });
  });

  test("a 429 ends the batch without marking the page", async () => {
    const seen = answer(() => json({}, 429));
    const records = {};
    await keyedRequests("LOW a:b", queue, records, 5, Number.POSITIVE_INFINITY, () => {}, gaps);
    expect(seen.filter((call) => call.url.endsWith("/save"))).toHaveLength(1);
    expect(records).toEqual({});
  });

  test("waits for a free session rather than ending the batch", async () => {
    const seen = answer((call) => json({ url: "x", job_id: `job-${call}` }), 3);
    await keyedRequests("LOW a:b", queue, {}, 5, Number.POSITIVE_INFINITY, () => {}, gaps);
    expect(seen.filter((call) => call.url.endsWith("/save"))).toHaveLength(2);
  });

  test("gives up when no session comes free", async () => {
    const seen = answer(() => json({}), Number.POSITIVE_INFINITY);
    await keyedRequests("LOW a:b", queue, {}, 5, Number.POSITIVE_INFINITY, () => {}, gaps);
    expect(seen.filter((call) => call.url.endsWith("/save"))).toHaveLength(0);
  });

  test("stops asking at the deadline", async () => {
    const seen = answer((call) => json({ url: "x", job_id: `job-${call}` }));
    await keyedRequests("LOW a:b", queue, {}, 5, Date.now() - 1, () => {}, gaps);
    expect(seen.filter((call) => call.url.endsWith("/save"))).toHaveLength(0);
  });

  test("a quota error ends the batch", async () => {
    const seen = answer(() => json({ status: "error", status_ext: "error:user-session-limit" }));
    await keyedRequests("LOW a:b", queue, {}, 5, Number.POSITIVE_INFINITY, () => {}, gaps);
    expect(seen.filter((call) => call.url.endsWith("/save"))).toHaveLength(1);
  });

  test("a reply with no job records what it said, and logs a short quote", async () => {
    answer(() => json({ url: "x", job_id: null, message: "Not this time." }));
    const log = spyOn(console, "log");
    const records = {};
    await keyedRequests("LOW key1:key2", queue.slice(0, 1), records, 5, Number.POSITIVE_INFINITY, () => {}, gaps);
    const printed = JSON.stringify(log.mock.calls);
    log.mockRestore();
    expect(records).toMatchObject({
      "https://a.org/1": { save: { outcome: "failed", error: "no-job: Not this time." } },
    });
    expect(printed).toContain("Not this time.");
  });

  test("a reply that isn't JSON is still a failure with a reason", async () => {
    answer(() => new Response("<html><p>Busy</p></html>"));
    const records = {};
    await keyedRequests("LOW a:b", queue.slice(0, 1), records, 5, Number.POSITIVE_INFINITY, () => {}, gaps);
    expect(records).toMatchObject({
      "https://a.org/1": { save: { outcome: "failed", error: "no-job: HTTP 200" } },
    });
  });

  test("the limit is respected, and the key is never logged", async () => {
    const seen = answer((call) => json({ url: "x", job_id: `job-${call}` }));
    const log = spyOn(console, "log");
    await keyedRequests("LOW secret:value", queue, {}, 1, Number.POSITIVE_INFINITY, () => {}, gaps);
    const printed = JSON.stringify(log.mock.calls);
    log.mockRestore();
    expect(seen.filter((call) => call.url.endsWith("/save"))).toHaveLength(1);
    expect(printed).not.toContain("secret:value");
  });
});

describe("noJob", () => {
  test("a status_ext is the reason", () => {
    expect(noJob(200, '{"status":"error","status_ext":"error:blocked-url"}', "LOW a1:b2").error).toBe(
      "error:blocked-url",
    );
  });

  test("an unreadable reply names the HTTP status, and is quoted without markup", () => {
    expect(noJob(502, "<h1>Bad\n  gateway</h1>", "LOW a1:b2")).toEqual({
      error: "no-job: HTTP 502",
      reply: "Bad gateway",
    });
  });

  test("a quote is short, and never holds the key", () => {
    const { error, reply } = noJob(200, JSON.stringify({ message: `access1 secret2 ${"x".repeat(500)}` }), "LOW access1:secret2");
    expect(`${error}${reply}`).not.toMatch(/access1|secret2/);
    expect(reply.length).toBeLessThanOrEqual(200);
    expect(error.length).toBeLessThanOrEqual(208);
  });
});
