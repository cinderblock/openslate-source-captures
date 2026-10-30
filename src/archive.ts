#!/usr/bin/env bun
// The Internet Archive as an independent witness: someone unconnected to us saw this page.
//
//   bun src/archive.ts lookup  <endorsements checkout> [--limit n] [--stale-days n]
//   bun src/archive.ts compare <endorsements checkout> [--limit n]
//   bun src/archive.ts save    [--limit n]
//
// `lookup` asks which snapshots exist. `compare` reads a snapshot's original bytes (`id_`) and looks
// for the slate's statements in them; "independently archived" is only claimed when they're there.
// `save` asks the Archive to take a snapshot of a page it doesn't have recently, spending its budget
// by the rule in `saveQueue`. All of it is best effort and nothing depends on it: a failure here never
// touches a capture. With ARCHIVE_ORG_ACCESS_KEY and ARCHIVE_ORG_SECRET_KEY it uses the Save Page Now
// API; without them it makes plain anonymous requests. Either way requests are spaced well inside the
// published limits (7 a minute with a key, 3 without) and a 429 or a quota error ends the batch.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArchiveRecord } from "./build-provenance";
import type { Origin } from "./provenance";
import { bodyText } from "./readable";
import type { SourceList } from "./sources";
import { anchorStatement } from "./text";
import { USER_AGENT } from "./user-agent";

const FILE = "archived.json";
const LOOKUP_GAP_MS = 1500;
const SAVE_GAP_MS = 20_000;
const KEYED_SAVE_GAP_MS = 15_000;
const FRESH_DAYS = 7;
const RETRY_DAYS = 1;
const SAVE_ENDPOINT = "https://web.archive.org/save";
/** The clocks differ, so a snapshot this long before we asked may still be ours. */
const CLOCK_SLACK_MS = 60_000;
/** Status results are kept for about an hour. */
const STATUS_KEPT_MS = 2 * 3_600_000;
const DRAIN_MS = 180_000;
const DRAIN_GAP_MS = 10_000;
/** These stop every later request, not just this one. */
const QUOTA_ERRORS = new Set([
  "error:user-session-limit",
  "error:max-daily-bandwidth",
  "error:max-daily-bandwidth-from-ip",
]);

/** The latest request for a snapshot of this page, and how it ended. */
export interface SaveAttempt {
  at: string;
  via: "key" | "anonymous";
  /**
   * `captured`: the Archive fetched the page because we asked. `already-archived`: it had a recent
   * copy and took no new one. `asked`: an anonymous request that didn't say which it was.
   */
  outcome: "pending" | "captured" | "already-archived" | "asked" | "failed";
  job_id?: string;
  /** The Wayback timestamp the Archive named in reply. */
  snapshot?: string;
  /** Where the page redirected to: a capture is stored under this URL, not the one asked for. */
  final_url?: string;
  error?: string;
}

type Snapshot = Pick<ArchiveRecord, "url" | "timestamp" | "digest" | "origin">;

export type StoredRecord = ArchiveRecord & {
  save?: SaveAttempt;
  save_requested_at?: string;
  compared?: string;
  /** A newer snapshot, held back until it's shown to keep the statements this record has. */
  candidate?: Snapshot;
  /** The newest snapshot that held fewer statements than this one. The page changed. */
  fewer_in?: string;
};

type Records = Record<string, StoredRecord>;

const headers = { "User-Agent": USER_AGENT };

const option = (name: string, fallback: number) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? Number(process.argv[at + 1]) : fallback;
};

const load = (): Records => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {});
const save = (records: Records) => {
  const sorted = Object.fromEntries(Object.entries(records).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(FILE, `${JSON.stringify(sorted, null, 1)}\n`);
};

const daysSince = (iso: string | undefined) =>
  iso ? (Date.now() - Date.parse(iso)) / 86_400_000 : Number.POSITIVE_INFINITY;

const snapshotDate = (timestamp: string) =>
  `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:00Z`;

const waybackTime = (ms: number) => new Date(ms).toISOString().replace(/\D/g, "").slice(0, 14);

const pageOf = (url: string) => url.split("#")[0] as string;

export function pagesOf(sources: SourceList["sources"]) {
  const pages = new Map<string, { urls: string[]; cited: boolean }>();
  for (const { url, origin } of sources) {
    const page = pages.get(pageOf(url)) ?? { urls: [], cited: false };
    page.urls.push(url);
    page.cited ||= origin === "cited";
    pages.set(pageOf(url), page);
  }
  return pages;
}

/**
 * Which pages to ask for, in order. Mechanical, and never by who a source is: every page with no
 * snapshot in FRESH_DAYS, unless we asked within RETRY_DAYS; cited pages before discovered ones,
 * then pages with no known snapshot, then oldest snapshot first, then URL.
 */
export function saveQueue(sources: SourceList["sources"], records: Records) {
  const queue: { page: string; urls: string[]; cited: boolean; newest: string }[] = [];
  for (const [page, { urls, cited }] of pagesOf(sources)) {
    if (!page.startsWith("http")) continue;
    const known = urls.map((url) => records[url]);
    const newest = known
      .flatMap((r) => [r?.timestamp, r?.fewer_in, r?.candidate?.timestamp])
      .reduce((latest: string, t) => (t && t > latest ? t : latest), "");
    if (newest && daysSince(snapshotDate(newest)) < FRESH_DAYS) continue;
    if (known.some((r) => daysSince(r?.save?.at) < RETRY_DAYS)) continue;
    queue.push({ page, urls, cited, newest });
  }
  return queue.sort(
    (a, b) =>
      Number(b.cited) - Number(a.cited) ||
      a.newest.localeCompare(b.newest) ||
      (a.page < b.page ? -1 : 1),
  );
}

/**
 * Whether we caused this snapshot. Only a reply naming it makes it ours, and only one taken before we
 * asked is plainly not. Anything between stays unknown rather than being claimed either way.
 */
export function originOf(timestamp: string, record: StoredRecord | undefined): Origin | undefined {
  const attempt = record?.save;
  if (!attempt) return record?.save_requested_at ? undefined : "existing";
  if (attempt.snapshot === timestamp) return attempt.outcome === "captured" ? "requested" : "existing";
  return timestamp < waybackTime(Date.parse(attempt.at) - CLOCK_SLACK_MS) ? "existing" : undefined;
}

/** A newly seen snapshot, without losing one that already holds statements. */
export function withSnapshot(
  record: StoredRecord | undefined,
  url: string,
  timestamp: string,
  digest: string,
  checked_at: string,
): StoredRecord {
  const known = record ?? { url: "", timestamp: "", digest: "", checked_at };
  const origin = originOf(timestamp, record);
  const snapshot = { url, timestamp, digest, ...(origin ? { origin } : {}) };
  if (timestamp === known.timestamp) return { ...known, ...(origin ? { origin } : {}), checked_at };
  if (timestamp === known.fewer_in) return { ...known, checked_at };
  if (known.statements?.found) {
    const unchanged = timestamp === known.candidate?.timestamp && !origin;
    return unchanged ? { ...known, checked_at } : { ...known, candidate: snapshot, checked_at };
  }
  const { statements: _, compared: __, candidate: ___, origin: ____, ...rest } = known;
  return { ...rest, ...snapshot, checked_at };
}

/** The result of reading a candidate: it replaces the snapshot it was held against only if it keeps up. */
export function judged(record: StoredRecord, statements: { found: number; of: number }): StoredRecord {
  const { candidate, ...rest } = record;
  if (!candidate) return { ...rest, statements, compared: record.timestamp };
  if (statements.found < (record.statements?.found ?? 0)) {
    return { ...rest, fewer_in: candidate.timestamp };
  }
  const { origin: _, ...earlier } = rest;
  return { ...earlier, ...candidate, statements, compared: candidate.timestamp };
}

/** What a Save Page Now status reply means for an attempt. Still running means no change. */
export function settled(
  attempt: SaveAttempt,
  job: { status?: string; timestamp?: string; original_url?: string; status_ext?: string },
): SaveAttempt {
  if (job.status === "pending") return attempt;
  if (job.status !== "success" || !job.timestamp) {
    return { ...attempt, outcome: "failed", error: job.status_ext ?? job.status ?? "no-status" };
  }
  const ours = job.timestamp >= waybackTime(Date.parse(attempt.at) - CLOCK_SLACK_MS);
  return {
    ...attempt,
    outcome: ours ? "captured" : "already-archived",
    snapshot: job.timestamp,
    ...(job.original_url ? { final_url: job.original_url } : {}),
  };
}

const key = () => {
  const { ARCHIVE_ORG_ACCESS_KEY: access, ARCHIVE_ORG_SECRET_KEY: secret } = process.env;
  return access && secret ? `LOW ${access}:${secret}` : null;
};

function statementsByUrl(root: string) {
  const byUrl = new Map<string, string[]>();
  for (const org of readdirSync(join(root, "orgs"))) {
    const orgDir = join(root, "orgs", org);
    if (!statSync(orgDir).isDirectory()) continue;
    for (const election of readdirSync(orgDir)) {
      const file = join(orgDir, election, "positions.json");
      if (!existsSync(file)) continue;
      const bundle = JSON.parse(readFileSync(file, "utf8"));
      const fallback = bundle.attribution?.sources?.[0];
      for (const { statement, source } of bundle.positions ?? []) {
        const url = source ?? fallback;
        if (url && statement) byUrl.set(url, [...(byUrl.get(url) ?? []), statement]);
      }
    }
  }
  return byUrl;
}

async function lookup() {
  const limit = option("--limit", 2000);
  const staleDays = option("--stale-days", 1);
  const records = load();
  const { sources } = JSON.parse(readFileSync("sources.json", "utf8")) as SourceList;
  // Longest unchecked first, so a page just captured doesn't wait its turn in the file.
  const checkedAt = (urls: string[]) =>
    urls.map((url) => records[url]?.checked_at ?? "").reduce((a, b) => (a < b ? a : b));
  const pages = [...pagesOf(sources)].sort(([, a], [, b]) =>
    checkedAt(a.urls).localeCompare(checkedAt(b.urls)),
  );
  let done = 0;
  for (const [page, { urls }] of pages) {
    if (done >= limit || daysSince(checkedAt(urls)) < staleDays) continue;
    done++;
    const target = urls.map((url) => records[url]?.save?.final_url).find(Boolean) ?? page;
    const query = new URLSearchParams({
      url: target,
      output: "json",
      limit: "-1",
      filter: "statuscode:200",
      fl: "timestamp,digest",
    });
    const response = await fetch(`https://web.archive.org/cdx/search/cdx?${query}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (response?.status === 429) {
      console.log("429 from the Archive: stopping this batch");
      break;
    }
    const checked_at = new Date().toISOString();
    if (response?.ok) {
      const rows = (await response.json().catch(() => [])) as string[][];
      const row = rows[1];
      for (const url of urls) {
        if (row) {
          const [timestamp, digest] = row as [string, string];
          const snapshot = `https://web.archive.org/web/${timestamp}id_/${target}${url.slice(page.length)}`;
          records[url] = withSnapshot(records[url], snapshot, timestamp, digest, checked_at);
        } else {
          const known = records[url];
          records[url] = { ...(known ?? { url: "", timestamp: "", digest: "" }), checked_at };
        }
      }
    }
    if (done % 50 === 0) {
      save(records);
      console.log(`looked up ${done}`);
    }
    await Bun.sleep(LOOKUP_GAP_MS);
  }
  save(records);
  console.log(`looked up ${done}; ${Object.values(records).filter((r) => r.timestamp).length} have snapshots`);
}

async function compare(root: string) {
  const limit = option("--limit", 2000);
  const records = load();
  const statements = statementsByUrl(root);
  // Fragments of one page share a snapshot: read it once.
  const texts = new Map<string, string | null>();
  let done = 0;
  for (const [url, record] of Object.entries(records)) {
    const wanted = statements.get(url);
    const snapshot = record.candidate ?? record;
    const read = !record.candidate && record.compared === record.timestamp;
    if (done >= limit || !snapshot.timestamp || !wanted || read) continue;
    done++;
    const address = pageOf(snapshot.url);
    if (!texts.has(address)) {
      const response = await fetch(address, {
        headers,
        signal: AbortSignal.timeout(60_000),
      }).catch(() => null);
      if (response?.status === 429) {
        console.log("429 from the Archive: stopping this batch");
        break;
      }
      let readable: string | null = null;
      if (response?.ok) {
        const body = Buffer.from(await response.arrayBuffer());
        const text = await bodyText(body, response.headers.get("content-type") ?? "");
        if ("text" in text) readable = text.text;
      }
      texts.set(address, readable);
      await Bun.sleep(LOOKUP_GAP_MS);
    }
    const text = texts.get(address);
    if (text != null) {
      const found = wanted.filter((s) => anchorStatement(s, text) !== "unanchored").length;
      records[url] = judged(record, { found, of: wanted.length });
    }
    if (done % 25 === 0) {
      save(records);
      console.log(`compared ${done}`);
    }
  }
  save(records);
  console.log(`compared ${done}`);
}

/** Apply an attempt to every source of a page, and have `lookup` go and see what it produced. */
function applyAttempt(records: Records, urls: string[], attempt: SaveAttempt) {
  for (const url of urls) {
    records[url] = {
      ...(records[url] ?? { url: "", timestamp: "", digest: "", checked_at: "" }),
      save: attempt,
      ...(attempt.snapshot ? { checked_at: "" } : {}),
    };
  }
}

async function anonymousRequests(queue: ReturnType<typeof saveQueue>, records: Records, limit: number) {
  let done = 0;
  let accepted = 0;
  for (const { page, urls } of queue.slice(0, limit)) {
    done++;
    const at = new Date().toISOString();
    const response = await fetch(`${SAVE_ENDPOINT}/${page}`, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(90_000),
    }).catch(() => null);
    if (response?.status === 429) {
      console.log("429 from the Archive: stopping this batch");
      break;
    }
    const ok = response && response.status < 400;
    if (ok) accepted++;
    const attempt: SaveAttempt = { at, via: "anonymous", outcome: ok ? "asked" : "failed" };
    if (!ok) attempt.error = response ? String(response.status) : "no-response";
    const named = response?.headers.get("location")?.match(/\/web\/(\d{14})\//)?.[1];
    applyAttempt(records, urls, named ? settled(attempt, { status: "success", timestamp: named }) : attempt);
    save(records);
    await Bun.sleep(SAVE_GAP_MS);
  }
  console.log(`asked for ${done} snapshots, ${accepted} accepted`);
}

/** Save Page Now with a key. Never log `auth`, or a request that carries it. */
export async function keyedRequests(
  auth: string,
  queue: ReturnType<typeof saveQueue>,
  records: Records,
  limit: number,
  persist: (records: Records) => void = save,
  gaps = { save: KEYED_SAVE_GAP_MS, drain: DRAIN_GAP_MS, drainFor: DRAIN_MS },
) {
  const api = {
    ...headers,
    Accept: "application/json",
    Authorization: auth,
    "Content-Type": "application/x-www-form-urlencoded",
  };

  // Jobs from an earlier run may have finished since.
  const pending = new Map<string, { attempt: SaveAttempt; urls: string[] }>();
  for (const [url, { save: attempt }] of Object.entries(records)) {
    if (attempt?.outcome !== "pending" || !attempt.job_id) continue;
    const job = pending.get(attempt.job_id) ?? { attempt, urls: [] };
    job.urls.push(url);
    pending.set(attempt.job_id, job);
  }

  let stopped = false;
  const stop = (why: string) => {
    console.log(`${why}: stopping this batch`);
    stopped = true;
  };

  const collect = async () => {
    if (!pending.size) return;
    const response = await fetch(`${SAVE_ENDPOINT}/status`, {
      method: "POST",
      headers: api,
      body: new URLSearchParams({ job_ids: [...pending.keys()].join(",") }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!response?.ok) return;
    const body = await response.json().catch(() => null);
    const jobs = (Array.isArray(body) ? body : [body]) as ({ job_id?: string } & Parameters<typeof settled>[1])[];
    const seen = new Map(jobs.map((job) => [job?.job_id, job]));
    for (const [id, { attempt, urls }] of pending) {
      const job = seen.get(id);
      if (!job) {
        if (Date.now() - Date.parse(attempt.at) < STATUS_KEPT_MS) continue;
        applyAttempt(records, urls, { ...attempt, outcome: "failed", error: "status-expired" });
        pending.delete(id);
        continue;
      }
      const result = settled(attempt, job);
      if (result.outcome === "pending") continue;
      applyAttempt(records, urls, result);
      pending.delete(id);
      if (result.error && QUOTA_ERRORS.has(result.error)) stop(result.error);
    }
  };

  const hasSession = async () => {
    const response = await fetch(`${SAVE_ENDPOINT}/status/user?_t=${Date.now()}`, {
      headers: api,
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    const body = response?.ok ? await response.json().catch(() => null) : null;
    return typeof body?.available !== "number" || body.available > 0;
  };

  await collect();
  const counts: Record<string, number> = {};
  let done = 0;
  for (const { page, urls } of queue) {
    if (done >= limit || stopped) break;
    if (!(await hasSession())) {
      await Bun.sleep(gaps.save);
      await collect();
      if (!(await hasSession())) {
        stop("no capture sessions free");
        break;
      }
    }
    done++;
    const at = new Date().toISOString();
    const response = await fetch(SAVE_ENDPOINT, {
      method: "POST",
      headers: api,
      body: new URLSearchParams({
        url: page,
        if_not_archived_within: `${FRESH_DAYS}d`,
        skip_first_archive: "1",
      }),
      signal: AbortSignal.timeout(90_000),
    }).catch(() => null);
    if (response?.status === 429) {
      done--;
      stop("429 from the Archive");
      break;
    }
    const body = (await response?.json().catch(() => null)) as {
      job_id?: string;
      status_ext?: string;
    } | null;
    const attempt: SaveAttempt = { at, via: "key", outcome: "pending" };
    if (body?.job_id) {
      attempt.job_id = body.job_id;
      pending.set(body.job_id, { attempt, urls });
    } else {
      attempt.outcome = "failed";
      attempt.error = body?.status_ext ?? (response ? String(response.status) : "no-response");
      if (QUOTA_ERRORS.has(attempt.error)) stop(attempt.error);
    }
    applyAttempt(records, urls, attempt);
    await collect();
    persist(records);
    await Bun.sleep(gaps.save);
  }

  const until = Date.now() + gaps.drainFor;
  while (pending.size && Date.now() < until) {
    await collect();
    persist(records);
    if (pending.size) await Bun.sleep(gaps.drain);
  }
  persist(records);

  for (const { save: attempt } of Object.values(records)) {
    if (attempt && attempt.via === "key") counts[attempt.outcome] = (counts[attempt.outcome] ?? 0) + 1;
  }
  console.log(`asked for ${done} snapshots with a key. Sources by outcome: ${JSON.stringify(counts)}`);
}

async function requestSnapshots() {
  const limit = option("--limit", 100);
  const records = load();
  const { sources } = JSON.parse(readFileSync("sources.json", "utf8")) as SourceList;
  const queue = saveQueue(sources, records);
  console.log(`${queue.length} pages need a snapshot`);
  const auth = key();
  if (auth) await keyedRequests(auth, queue, records, limit);
  else await anonymousRequests(queue, records, limit);
}

if (import.meta.main) {
  const [command, root] = process.argv.slice(2);
  if (command === "lookup") await lookup();
  else if (command === "compare" && root) await compare(root);
  else if (command === "save") await requestSnapshots();
  else throw new Error("usage: archive.ts lookup | compare <endorsements> | save [--limit n]");
}
