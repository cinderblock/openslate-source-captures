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
import { join, resolve } from "node:path";
import { decodeBody, parseResponse } from "./capture";
import { allHops, type Manifest } from "./manifest";
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
  for (const capture of manifest.captures) {
    const { intended, rendered } = capture;
    const responses = [
      ...allHops(capture).map((hop) => hop.response_sha256),
      rendered?.document_sha256,
      rendered?.dom_sha256,
    ].filter((hash): hash is string => Boolean(hash));
    for (const hash of responses) {
      if (withheldUrls.has(intended)) withheld.add(hash);
      else if (containsGuarded(read(hash), guards)) guarded.add(hash);
    }
  }
  return { withheld, guarded };
}

if (import.meta.main) {
  const out = process.argv[2];
  const flag = process.argv.indexOf("--private");
  // Absolute, because Bun on Windows fails a recursive mkdir of an existing "..\\" path.
  const privateRoot = flag > 0 ? resolve(process.argv[flag + 1] as string) : undefined;
  if (!out) throw new Error("usage: publish.ts <out dir> [--private <dir>]");

  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as Manifest;
  const list = JSON.parse(readFileSync("sources.json", "utf8")) as SourceList;
  // Placing is resumable: a blob may already be where it belongs, from a stopped attempt or an
  // earlier run with the same bytes. Those stay put, and the record says where they are.
  const privateBlobs = privateRoot ? join(privateRoot, "blobs") : null;
  const placements = (hash: string) => ({
    fresh: join(out, "blobs", hash),
    public: blobPath("blobs", hash),
    large: join("large", hash),
    private: privateBlobs ? blobPath(privateBlobs, hash) : null,
  });
  const locate = (hash: string) => {
    const at = placements(hash);
    return [at.fresh, at.public, at.large, at.private].find((path) => path && existsSync(path));
  };
  const read = (hash: string) => {
    const path = locate(hash);
    if (!path) throw new Error(`run is missing blob ${hash}`);
    return readFileSync(path);
  };
  const guards = (process.env.CAPTURE_GUARD_IPS ?? "").split(",").filter(Boolean);
  const { withheld, guarded } = classify(manifest, list, read, guards);

  const every = new Set<string>([manifest.sources_sha256]);
  for (const capture of manifest.captures) {
    const { rendered } = capture;
    for (const hop of allHops(capture)) {
      every.add(hop.request_sha256).add(hop.response_sha256);
      for (const hash of hop.tls?.chain_sha256 ?? []) every.add(hash);
    }
    if (rendered?.document_sha256) every.add(rendered.document_sha256);
    if (rendered?.dom_sha256) every.add(rendered.dom_sha256);
  }

  const placement: Placement = { withheld: [], guarded: [], release: [] };
  mkdirSync("large", { recursive: true });
  for (const hash of [...every].sort()) {
    const at = placements(hash);
    const found = locate(hash);
    if (!found) throw new Error(`run is missing blob ${hash}`);
    let target = found;
    if (found === at.fresh) {
      if (withheld.has(hash) || guarded.has(hash)) {
        if (!at.private) throw new Error("this run has withheld bytes: pass --private");
        target = at.private;
      } else {
        target = Bun.file(found).size >= LARGE_BYTES ? at.large : at.public;
      }
      mkdirSync(join(target, ".."), { recursive: true });
      renameSync(found, target);
    }
    if (target === at.large) placement.release.push(hash);
    else if (target === at.private) {
      (guarded.has(hash) ? placement.guarded : placement.withheld).push(hash);
    }
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
