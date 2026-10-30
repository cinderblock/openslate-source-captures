#!/usr/bin/env bun
// Place a sealed run: proofs and public bytes in this repo, withheld bytes in a private store, and
// anything big in a directory bound for a Release. The manifest doesn't change, so placement can't
// affect any proof. It only decides who can read the bytes the proofs already name.
//
//   bun src/publish.ts <out dir> [--private <dir>]
//
// CAPTURE_GUARD_IPS (comma separated, from the environment, never logged) lists this machine's
// public addresses. Bot-block pages often print the visitor's address, so a local run keeps any
// response containing one private. A CI run doesn't need it: the runner's address isn't personal.

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeBody, parseResponse } from "./capture";
import type { Manifest } from "./manifest";
import type { SourceList } from "./sources";

export const LARGE_BYTES = 5 * 1024 * 1024;

export interface Placement {
  /** Response hashes in the private store, by reason. */
  withheld: string[];
  guarded: string[];
  /** Hashes that are assets on this repo's `large-blobs` release. */
  release: string[];
}

export const blobPath = (root: string, hash: string) => join(root, hash.slice(0, 2), hash);

function containsGuarded(raw: Buffer, guards: string[]): boolean {
  if (!guards.length) return false;
  const haystacks = [raw.toString("latin1")];
  try {
    haystacks.push(decodeBody(parseResponse(raw)).toString("latin1"));
  } catch {
    // Not decodable: the raw text above is all there is to check.
  }
  return guards.some((guard) => haystacks.some((text) => text.includes(guard)));
}

/** Pure: which responses stay private. */
export function classify(
  manifest: Manifest,
  list: SourceList,
  read: (hash: string) => Buffer,
  guards: string[],
) {
  const withheldUrls = new Set(
    list.sources.filter(({ publish }) => publish === "withheld").map(({ url }) => url),
  );
  const withheld = new Set<string>();
  const guarded = new Set<string>();
  for (const { intended, hops } of manifest.captures) {
    for (const hop of hops) {
      if (withheldUrls.has(intended)) withheld.add(hop.response_sha256);
      else if (containsGuarded(read(hop.response_sha256), guards)) guarded.add(hop.response_sha256);
    }
  }
  return { withheld, guarded };
}

if (import.meta.main) {
  const out = process.argv[2];
  const flag = process.argv.indexOf("--private");
  const privateRoot = flag > 0 ? process.argv[flag + 1] : undefined;
  if (!out) throw new Error("usage: publish.ts <out dir> [--private <dir>]");

  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as Manifest;
  const list = JSON.parse(readFileSync("sources.json", "utf8")) as SourceList;
  const source = (hash: string) => join(out, "blobs", hash);
  const guards = (process.env.CAPTURE_GUARD_IPS ?? "").split(",").filter(Boolean);
  const { withheld, guarded } = classify(manifest, list, (hash) => readFileSync(source(hash)), guards);

  const every = new Set<string>([manifest.sources_sha256]);
  for (const { hops } of manifest.captures) {
    for (const hop of hops) {
      every.add(hop.request_sha256).add(hop.response_sha256);
      for (const hash of hop.tls?.chain_sha256 ?? []) every.add(hash);
    }
  }

  const placement: Placement = { withheld: [], guarded: [], release: [] };
  mkdirSync("large", { recursive: true });
  for (const hash of [...every].sort()) {
    if (!existsSync(source(hash))) throw new Error(`run is missing blob ${hash}`);
    const size = Bun.file(source(hash)).size;
    let target: string;
    if (withheld.has(hash) || guarded.has(hash)) {
      if (!privateRoot) throw new Error("this run has withheld bytes: pass --private");
      (withheld.has(hash) ? placement.withheld : placement.guarded).push(hash);
      target = blobPath(join(privateRoot, "blobs"), hash);
    } else if (size >= LARGE_BYTES) {
      placement.release.push(hash);
      target = join("large", hash);
    } else {
      target = blobPath("blobs", hash);
    }
    mkdirSync(join(target, ".."), { recursive: true });
    renameSync(source(hash), target);
  }

  const run = join("runs", manifest.run_id);
  mkdirSync(run, { recursive: true });
  cpSync(join(out, "manifest.json"), join(run, "manifest.json"));
  cpSync(join(out, "stamps"), join(run, "stamps"), { recursive: true });
  const sigstore = join(out, "manifest.sigstore.json");
  if (existsSync(sigstore)) cpSync(sigstore, join(run, "manifest.sigstore.json"));
  writeFileSync(join(run, "placement.json"), `${JSON.stringify(placement, null, 1)}\n`);
  console.log(
    `${run}: ${every.size} blobs, ${placement.withheld.length} withheld, ` +
      `${placement.guarded.length} guarded, ${placement.release.length} for the release`,
  );
}
