#!/usr/bin/env bun
// The Internet Archive as an independent witness: someone unconnected to us saw this page.
//
//   bun src/archive.ts lookup  <endorsements checkout> [--limit n] [--stale-days n]
//   bun src/archive.ts compare <endorsements checkout> [--limit n]
//   bun src/archive.ts save    [--limit n]
//
// `lookup` asks which snapshots exist. `compare` reads a snapshot's original bytes (`id_`) and looks
// for the slate's statements in them; "independently archived" is only claimed when they're there.
// `save` asks the Archive to take a snapshot of a page it doesn't have recently. All of it is best
// effort and nothing depends on it: a failure here never touches a capture. No account is needed,
// so requests are spaced well apart and a 429 ends the batch.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArchiveRecord } from "./build-provenance";
import { bodyText } from "./readable";
import type { SourceList } from "./sources";
import { anchorStatement } from "./text";
import { USER_AGENT } from "./user-agent";

const FILE = "archived.json";
const LOOKUP_GAP_MS = 1500;
const SAVE_GAP_MS = 20_000;

type Records = Record<string, ArchiveRecord & { save_requested_at?: string; compared?: string }>;

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
  let done = 0;
  for (const { url } of sources) {
    if (done >= limit || daysSince(records[url]?.checked_at) < staleDays) continue;
    done++;
    const query = new URLSearchParams({
      url: url.split("#")[0] as string,
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
      if (row) {
        const [timestamp, digest] = row as [string, string];
        records[url] = {
          ...records[url],
          url: `https://web.archive.org/web/${timestamp}id_/${url}`,
          timestamp,
          digest,
          checked_at,
        };
      } else {
        const known = records[url];
        records[url] = { ...(known ?? { url: "", timestamp: "", digest: "" }), checked_at };
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
  let done = 0;
  for (const [url, record] of Object.entries(records)) {
    const wanted = statements.get(url);
    if (done >= limit || !record.timestamp || !wanted || record.compared === record.timestamp) continue;
    done++;
    const response = await fetch(record.url, {
      headers,
      signal: AbortSignal.timeout(60_000),
    }).catch(() => null);
    if (response?.status === 429) {
      console.log("429 from the Archive: stopping this batch");
      break;
    }
    if (response?.ok) {
      const body = Buffer.from(await response.arrayBuffer());
      const text = await bodyText(body, response.headers.get("content-type") ?? "");
      if ("text" in text) {
        const found = wanted.filter((s) => anchorStatement(s, text.text) !== "unanchored").length;
        records[url] = {
          ...record,
          statements: { found, of: wanted.length },
          compared: record.timestamp,
        };
      }
    }
    if (done % 25 === 0) {
      save(records);
      console.log(`compared ${done}`);
    }
    await Bun.sleep(LOOKUP_GAP_MS);
  }
  save(records);
  console.log(`compared ${done}`);
}

async function requestSnapshots() {
  const limit = option("--limit", 100);
  const records = load();
  const { sources } = JSON.parse(readFileSync("sources.json", "utf8")) as SourceList;
  const seen = new Set<string>();
  let done = 0;
  let accepted = 0;
  for (const { url } of sources) {
    const page = url.split("#")[0] as string;
    if (done >= limit || seen.has(page) || !page.startsWith("http")) continue;
    seen.add(page);
    const record = records[url];
    const fresh = record?.timestamp && daysSince(snapshotDate(record.timestamp)) < 7;
    if (fresh || daysSince(record?.save_requested_at) < 3) continue;
    done++;
    const response = await fetch(`https://web.archive.org/save/${page}`, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(90_000),
    }).catch(() => null);
    if (response?.status === 429) {
      console.log("429 from the Archive: stopping this batch");
      break;
    }
    if (response && response.status < 400) accepted++;
    records[url] = {
      ...(record ?? { url: "", timestamp: "", digest: "", checked_at: "" }),
      save_requested_at: new Date().toISOString(),
    };
    save(records);
    await Bun.sleep(SAVE_GAP_MS);
  }
  console.log(`asked for ${done} snapshots, ${accepted} accepted`);
}

if (import.meta.main) {
  const [command, root] = process.argv.slice(2);
  if (command === "lookup") await lookup();
  else if (command === "compare" && root) await compare(root);
  else if (command === "save") await requestSnapshots();
  else throw new Error("usage: archive.ts lookup | compare <endorsements> | save [--limit n]");
}
