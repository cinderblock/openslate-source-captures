#!/usr/bin/env bun
// Which hosts need a run from a home address? Read off the newest CI run, so nobody chooses them: any
// host that answered with something other than the page, or not at all. A 404 or 410 isn't a block,
// the page is gone for everyone, and the CI run's record of that is the one to keep.
//
//   bun src/run.ts out --only-hosts "$(bun src/blocked.ts)"

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "./manifest";

const GONE = new Set([404, 410]);

/** Pure: the hosts in a run that CI couldn't read, sorted. */
export function blockedHosts(captures: Manifest["captures"]): string[] {
  const hosts = new Set<string>();
  for (const { intended, hops } of captures) {
    const status = hops.at(-1)?.status ?? null;
    if (status === 200 || (status !== null && GONE.has(status))) continue;
    if (URL.canParse(intended)) hosts.add(new URL(intended).hostname.toLowerCase());
  }
  return [...hosts].sort();
}

if (import.meta.main) {
  const newest = readdirSync("runs")
    .filter((id) => existsSync(join("runs", id, "manifest.sigstore.json")))
    .sort()
    .at(-1);
  if (!newest) throw new Error("no CI run in runs/");
  const manifest = JSON.parse(readFileSync(join("runs", newest, "manifest.json"), "utf8")) as Manifest;
  console.log(blockedHosts(manifest.captures).join(","));
}
