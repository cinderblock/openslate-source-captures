#!/usr/bin/env bun
// One capture run: fetch every URL in sources.json, verbatim, and write a manifest naming all of it.
//
//   bun src/run.ts <out dir> [--only-hosts a.org,b.org]
//
// The URL list is a committed file, never an argument, so a run can't be pointed somewhere new
// without a public commit. Same tool, same rules and same user agent for every organization.
// --only-hosts narrows a run to hosts another run failed on; the manifest still says exactly what
// it set out to fetch.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture, sha256 } from "./capture";
import {
  encodeManifest,
  MANIFEST_FORMAT,
  type Manifest,
  type ManifestHop,
  putBlob,
  recordHop,
} from "./manifest";
import { type Rendered, renderPage } from "./render";
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

  const results = new Map<string, Manifest["captures"][number]>();
  // "x.pdf#page=57" and "x.pdf#page=58" are one request: a fragment never reaches the server.
  const fetched = new Map<string, ManifestHop[]>();
  const queue = [...byHost.values()];
  let done = 0;
  const worker = async () => {
    for (let urls = queue.shift(); urls; urls = queue.shift()) {
      for (const url of urls) {
        const resource = withoutFragment(url);
        const known = fetched.get(resource);
        const hops =
          known ??
          (await capture(resource, { userAgent: USER_AGENT, accept: ACCEPT })).map((hop) =>
            recordHop(blobs, hop),
          );
        fetched.set(resource, hops);
        results.set(url, { intended: url, hops });
        done++;
        if (done % 50 === 0) console.log(`${done}/${intended.length}`);
        if (!known) await Bun.sleep(HOST_GAP_MS);
      }
    }
  };
  await Promise.all(Array.from({ length: HOSTS_AT_ONCE }, worker));

  // Beside the plain GET, never instead of it, for hosts that only answer a browser.
  const renderHosts = JSON.parse(readFileSync("render-hosts.json", "utf8")).hosts as Record<
    string,
    string
  >;
  const toRender = new Set(intended.filter((url) => renderHosts[hostOf(url)]).map(withoutFragment));
  const renders = new Map<string, Rendered>();
  for (const url of toRender) {
    renders.set(url, await renderPage(url, blobs));
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
  process.exit(0);
}
