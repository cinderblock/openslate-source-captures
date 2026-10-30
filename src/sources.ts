#!/usr/bin/env bun
// Generate sources.json: every URL a published slate cites, plus any data URLs a human found behind
// a page (discovered.json). Mechanical on purpose: selection is the one place a capture system can
// cherry-pick, so it's a pure function of a public commit, and a run reads the committed result.
//
//   bun src/sources.ts <openslate-public-endorsements checkout>
//
// `publish` is also mechanical. A URL is withheld if its host is cited by a news organization or
// editorial board, or is listed in withheld-hosts.json: those pages are their publishers' copyrighted
// work or may carry personal data, so the bytes stay private and only the hash goes public.
// Everything is still captured and proven the same way.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const NEWS_KINDS = new Set(["news_organization", "editorial_board"]);

export interface Source {
  url: string;
  /** "<org>/<election>", every bundle citing this URL. */
  cited_by: string[];
  positions: number;
  publish: "public" | "withheld";
  /** "discovered" if a human added it, with why, in discovered.json. */
  origin: "cited" | "discovered";
  note?: string;
}

export interface SourceList {
  format: "openslate-source-list/1";
  generated_from: { repository: string; commit: string };
  sources: Source[];
}

interface Bundle {
  attribution?: { sources?: string[]; of?: { kind?: string } };
  positions?: { source?: string }[];
}

export interface Discovered {
  url: string;
  /** The page a person found this behind, and how. */
  found_behind: string;
  cited_by: string[];
  note: string;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url;
  }
};

/** Pure: bundles in, source list out, sorted so the same input always gives the same bytes. */
export function buildSources(
  bundles: { id: string; bundle: Bundle }[],
  discovered: Discovered[],
  extraWithheld: string[] = [],
): Source[] {
  const byUrl = new Map<string, Source>();
  const newsHosts = new Set<string>(extraWithheld);
  for (const { id, bundle } of bundles) {
    const counts = new Map<string, number>();
    for (const url of bundle.attribution?.sources ?? []) counts.set(url, counts.get(url) ?? 0);
    for (const { source } of bundle.positions ?? []) {
      if (source) counts.set(source, (counts.get(source) ?? 0) + 1);
    }
    const news = NEWS_KINDS.has(bundle.attribution?.of?.kind ?? "");
    for (const [url, count] of counts) {
      if (news) newsHosts.add(hostOf(url));
      const entry = byUrl.get(url) ?? {
        url,
        cited_by: [],
        positions: 0,
        publish: "public" as const,
        origin: "cited" as const,
      };
      entry.cited_by.push(id);
      entry.positions += count;
      byUrl.set(url, entry);
    }
  }
  for (const { url, cited_by, found_behind, note } of discovered) {
    const known = byUrl.get(url);
    if (known) {
      known.note = `${note} Found behind ${found_behind}.`;
      continue;
    }
    byUrl.set(url, {
      url,
      cited_by,
      positions: 0,
      publish: "public",
      origin: "discovered",
      note: `${note} Found behind ${found_behind}.`,
    });
  }
  return [...byUrl.values()]
    .map((source) => ({
      ...source,
      cited_by: [...source.cited_by].sort(),
      publish: newsHosts.has(hostOf(source.url)) ? ("withheld" as const) : ("public" as const),
    }))
    .sort((a, b) => (a.url < b.url ? -1 : 1));
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("usage: sources.ts <endorsements checkout>");
  const bundles: { id: string; bundle: Bundle }[] = [];
  for (const org of readdirSync(join(root, "orgs"))) {
    const orgDir = join(root, "orgs", org);
    if (!statSync(orgDir).isDirectory()) continue;
    for (const election of readdirSync(orgDir)) {
      const file = join(orgDir, election, "positions.json");
      if (!existsSync(file)) continue;
      bundles.push({ id: `${org}/${election}`, bundle: JSON.parse(readFileSync(file, "utf8")) });
    }
  }
  const discovered: Discovered[] = existsSync("discovered.json")
    ? JSON.parse(readFileSync("discovered.json", "utf8"))
    : [];
  const extra = JSON.parse(readFileSync("withheld-hosts.json", "utf8"));
  const list: SourceList = {
    format: "openslate-source-list/1",
    generated_from: {
      repository: "cinderblock/openslate-public-endorsements",
      commit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim(),
    },
    sources: buildSources(bundles, discovered, [...extra.news, ...extra.personal_data_risk]),
  };
  writeFileSync("sources.json", `${JSON.stringify(list, null, 1)}\n`);
  const withheld = list.sources.filter((source) => source.publish === "withheld").length;
  console.log(`${list.sources.length} sources from ${bundles.length} bundles, ${withheld} withheld`);
}
