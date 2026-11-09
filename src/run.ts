#!/usr/bin/env bun
// One capture run: fetch every URL in sources.json, verbatim, and write a manifest naming all of it.
//
//   bun src/run.ts <out dir> [--only-hosts a.org,b.org]
//
// The URL list is a committed file, never an argument, so a run can't be pointed somewhere new
// without a public commit. Same tool, same rules and same user agent for every organization. A URL
// that doesn't come back 200 is asked again by the rule in src/retry.ts, and every attempt is kept.
// --only-hosts narrows a run to hosts another run failed on; the manifest still says exactly what
// it set out to fetch.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture, header, parseResponse, sha256 } from "./capture";
import {
  encodeManifest,
  MANIFEST_FORMAT,
  type Manifest,
  type ManifestHop,
  putBlob,
  recordHop,
} from "./manifest";
import { isThinHtml } from "./readable";
import { type Rendered, renderPage } from "./render";
import { DOWN_AFTER, LATER_RETRY_MS, needsRetry, noResponse, quickDelay } from "./retry";
import type { SourceList } from "./sources";
import { USER_AGENT } from "./user-agent";

const ACCEPT = "text/html,application/json,application/pdf,*/*;q=0.8";
const HOST_GAP_MS = 1500;
const HOSTS_AT_ONCE = 12;

export const withoutFragment = (url: string) => url.split("#")[0] as string;

const git = (...args: string[]) => execFileSync("git", args).toString().trim();

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "(unparseable)";
  }
};

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) throw new Error("usage: run.ts <out dir> [--only-hosts a,b]");
  const flag = process.argv.indexOf("--only-hosts");
  const only = flag > 0 ? new Set((process.argv[flag + 1] ?? "").split(",")) : null;

  const sourcesBytes = readFileSync("sources.json");
  const list = JSON.parse(sourcesBytes.toString("utf8")) as SourceList;
  const intended = list.sources.map(({ url }) => url).filter((url) => !only || only.has(hostOf(url)));
  const posts = new Map(list.sources.flatMap(({ url, post }) => (post ? [[url, post]] : [])) as [string, string][]);

  const started_at = new Date().toISOString();
  // Read before fetching: this describes the code that ran, whatever happens to the tree later.
  const tool_commit = git("rev-parse", "HEAD");
  const tool_dirty =
    git("status", "--porcelain", "--", "src", "package.json", "bun.lock", "render-hosts.json") !== "";
  const run_id = started_at.slice(0, 16).replace(":", "") + "Z";
  const blobs = join(out, "blobs");
  mkdirSync(blobs, { recursive: true });
  // The list itself is evidence: a verifier checks the intended URLs against these exact bytes.
  putBlob(blobs, sourcesBytes);

  const byHost = new Map<string, string[]>();
  for (const url of intended) {
    const host = hostOf(url);
    byHost.set(host, [...(byHost.get(host) ?? []), url]);
  }

  // "x.pdf#page=57" and "x.pdf#page=58" are one request: a fragment never reaches the server.
  // Each resource keeps every attempt, oldest first; the last is its outcome.
  const fetched = new Map<string, ManifestHop[][]>();
  const attempt = async (resource: string, post: string | undefined) => {
    const exchanges = await capture(resource, { userAgent: USER_AGENT, accept: ACCEPT, post });
    const hops = exchanges.map((hop) => recordHop(blobs, hop));
    const attempts = fetched.get(resource) ?? [];
    attempts.push(hops);
    fetched.set(resource, attempts);
    return { hops, retryAfter: header(parseResponse(exchanges.at(-1)?.response ?? Buffer.alloc(0)), "retry-after") };
  };

  // The first pass, with the quick recheck right behind any URL that didn't come back 200.
  const later: { resource: string; post: string | undefined; due: number }[] = [];
  const quietHosts = new Map<string, number>();
  const queue = [...byHost.entries()];
  let done = 0;
  const firstPass = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [host, urls] = next;
      for (const url of urls) {
        const resource = withoutFragment(url);
        done++;
        if (done % 50 === 0) console.log(`${done}/${intended.length}`);
        if (fetched.has(resource)) continue;
        const post = posts.get(url);
        const first = await attempt(resource, post);
        await Bun.sleep(HOST_GAP_MS);
        if (!needsRetry(first.hops)) continue;
        const wait = (quietHosts.get(host) ?? 0) >= DOWN_AFTER ? null : quickDelay(first.retryAfter, Date.now());
        if (wait !== null) {
          await Bun.sleep(wait);
          const quick = await attempt(resource, post);
          await Bun.sleep(HOST_GAP_MS);
          if (!needsRetry(quick.hops)) continue;
          if (noResponse(quick.hops)) quietHosts.set(host, (quietHosts.get(host) ?? 0) + 1);
        }
        later.push({ resource, post, due: Date.now() + LATER_RETRY_MS });
      }
    }
  };
  await Promise.all(Array.from({ length: HOSTS_AT_ONCE }, firstPass));

  // The later recheck, at least LATER_RETRY_MS after the quick one, still one request at a time per
  // host.
  const laterByHost = new Map<string, typeof later>();
  for (const item of later) {
    const host = hostOf(item.resource);
    laterByHost.set(host, [...(laterByHost.get(host) ?? []), item]);
  }
  const laterQueue = [...laterByHost.values()];
  const laterPass = async () => {
    for (let items = laterQueue.shift(); items; items = laterQueue.shift()) {
      for (const { resource, post, due } of items) {
        await Bun.sleep(Math.max(0, due - Date.now()));
        await attempt(resource, post);
        await Bun.sleep(HOST_GAP_MS);
      }
    }
  };
  if (later.length) console.log(`asking ${later.length} again after ${LATER_RETRY_MS / 60_000} minutes`);
  await Promise.all(Array.from({ length: HOSTS_AT_ONCE }, laterPass));

  const results = new Map<string, Manifest["captures"][number]>();
  for (const url of intended) {
    const attempts = fetched.get(withoutFragment(url)) ?? [];
    const hops = attempts.at(-1);
    if (!hops) continue;
    const earlier = attempts.slice(0, -1);
    results.set(url, earlier.length ? { intended: url, earlier_attempts: earlier, hops } : { intended: url, hops });
  }
  const finalHops = new Map([...fetched].map(([resource, attempts]) => [resource, attempts.at(-1) ?? []]));

  // Beside the plain GET, never instead of it, for hosts that only answer a browser.
  const renderHosts = JSON.parse(readFileSync("render-hosts.json", "utf8")).hosts as Record<
    string,
    string
  >;
  const toRender = new Map<string, Rendered["trigger"]>();
  for (const url of intended) {
    if (renderHosts[hostOf(url)]) toRender.set(withoutFragment(url), "listed");
  }
  for (const [url, hops] of finalHops) {
    const final = hops.at(-1);
    if (toRender.has(url) || !final) continue;
    if (await isThinHtml(readFileSync(join(blobs, final.response_sha256)))) toRender.set(url, "thin");
  }
  const renders = new Map<string, Rendered>();
  for (const [url, trigger] of toRender) {
    renders.set(url, await renderPage(url, blobs, trigger));
    await Bun.sleep(HOST_GAP_MS);
  }

  const manifest: Manifest = {
    format: MANIFEST_FORMAT,
    run_id,
    started_at,
    ended_at: new Date().toISOString(),
    sources_sha256: sha256(sourcesBytes),
    narrowed_to: only ? [...only] : null,
    intended,
    capturer: {
      tool_repository: "cinderblock/openslate-source-captures",
      tool_commit,
      tool_dirty,
      user_agent: USER_AGENT,
      runtime: `bun ${Bun.version}`,
      platform: process.platform,
      environment: process.env.GITHUB_ACTIONS ? "github-actions" : "local",
      run_url: process.env.GITHUB_RUN_ID
        ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
    },
    captures: intended.map((url) => {
      const result = results.get(url);
      if (!result) throw new Error(`no outcome recorded for ${url}`);
      const rendered = renders.get(withoutFragment(url));
      return rendered ? { ...result, rendered } : result;
    }),
  };
  writeFileSync(join(out, "manifest.json"), encodeManifest(manifest));

  const finals = manifest.captures.map(({ hops }) => hops.at(-1));
  const tally: Record<string, number> = {};
  for (const hop of finals) {
    const key = String(hop?.status ?? `error: ${hop?.error?.split(":")[0]}`);
    tally[key] = (tally[key] ?? 0) + 1;
  }
  console.log(`run ${run_id}: ${intended.length} URLs`, tally);
  const retried = [...fetched.values()].filter((attempts) => attempts.length > 1);
  const recovered = retried.filter((attempts) => !needsRetry(attempts.at(-1) ?? []));
  console.log(`asked again: ${retried.length} resources, ${recovered.length} of them came back 200`);
  process.exit(0);
}
