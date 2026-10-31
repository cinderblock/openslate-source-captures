#!/usr/bin/env bun
// Rebuild provenance/<org>/<election>.json from the runs and the published bundles. Runs offline.
//
//   bun src/build-provenance.ts <endorsements checkout> [--private <dir>] [--large <dir>]
//
// Claims are recomputed here from each run's proofs by verify-core. A slate's statements are looked
// for in the captured text and the counts recorded. A miss is a fact about the text, nothing more.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "./manifest";
import {
  type Archived,
  type CaptureRef,
  type Claim,
  type Derivation,
  hostFact,
  PROVENANCE_FORMAT,
  type SlateProvenance,
  type SourceProvenance,
} from "./provenance";
import { bodyText, responseText } from "./readable";
import type { SourceList } from "./sources";
import { anchorStatement } from "./text";
import { verifyRun } from "./verify-core";
import { loadTrust } from "./verify";
import type { Placement } from "./publish";

export interface ArchiveRecord extends Archived {
  checked_at: string;
  /** Statements found in the snapshot's text, of those citing this URL. */
  statements?: { found: number; of: number };
  /** The snapshot's digest equals the digest of the bytes we captured. */
  identical?: boolean;
}

interface Position {
  statement?: string;
  source?: string;
}

interface Bundle {
  attribution?: { mode?: string; sources?: string[]; of?: { uri?: string } };
  positions?: Position[];
}

const option = (name: string) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};

/** Newest first, with the claims each run's proofs actually support. */
async function loadCaptures() {
  const byUrl = new Map<string, CaptureRef[]>();
  const trust = loadTrust();
  const runs = existsSync("runs") ? readdirSync("runs").sort().reverse() : [];
  for (const run of runs) {
    const dir = join("runs", run);
    const manifestBytes = readFileSync(join(dir, "manifest.json"));
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
    const placement = JSON.parse(readFileSync(join(dir, "placement.json"), "utf8")) as Placement;
    const sigstorePath = join(dir, "manifest.sigstore.json");
    const report = await verifyRun({
      manifestBytes,
      stamps: readdirSync(join(dir, "stamps")).map((file) => ({
        name: file,
        token: readFileSync(join(dir, "stamps", file)),
      })),
      sigstoreBundle: existsSync(sigstorePath) ? readFileSync(sigstorePath, "utf8") : null,
      // Only the proofs matter here; bytes are checked when they're read.
      blob: async () => null,
      withheld: new Set(),
      trust,
    });
    const claims: Claim[] = ["captured"];
    if (new Set(report.stamps.map(({ root }) => root)).size >= 2) claims.push("time-stamped");
    if (report.witness) claims.push("witnessed-by-public-ci");

    const withheld = new Set([...placement.withheld, ...placement.guarded]);
    const release = new Set(placement.release);
    manifest.captures.forEach(({ intended, hops, rendered }, index) => {
      const last = hops.at(-1);
      if (!last) return;
      const hash = last.response_sha256;
      const ref: CaptureRef = {
        run,
        index,
        captured_at: last.started_at,
        status: last.status,
        error: last.error,
        final_url: last.url,
        response_sha256: hash,
        bytes: withheld.has(hash) ? "withheld" : release.has(hash) ? "release" : "public",
        claims,
        ...(rendered
          ? { rendered: { status: rendered.status, dom_sha256: rendered.dom_sha256 } }
          : {}),
      };
      byUrl.set(intended, [...(byUrl.get(intended) ?? []), ref]);
    });
  }
  return { byUrl, runs };
}

function blobReader(privateRoot?: string, largeRoot?: string) {
  return (hash: string): Buffer | null => {
    const candidates = [
      join("blobs", hash.slice(0, 2), hash),
      ...(privateRoot ? [join(privateRoot, "blobs", hash.slice(0, 2), hash)] : []),
      ...(largeRoot ? [join(largeRoot, hash)] : []),
    ];
    const found = candidates.find((path) => existsSync(path));
    return found ? readFileSync(found) : null;
  };
}

/** The bytes a statement should be checked against: a good render, else the newest 200. */
const textSource = (latest: CaptureRef | null, last_ok: CaptureRef | null) => {
  const good = latest?.status === 200 ? latest : last_ok;
  if (!good) return null;
  if (good.rendered?.status === 200 && good.rendered.dom_sha256) {
    return { ref: good, hash: good.rendered.dom_sha256, rendered: true };
  }
  return { ref: good, hash: good.response_sha256, rendered: false };
};

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("usage: build-provenance.ts <endorsements> [--private d] [--large d]");
  const read = blobReader(option("--private"), option("--large"));
  const { byUrl, runs } = await loadCaptures();
  const archive: Record<string, ArchiveRecord> = existsSync("archived.json")
    ? JSON.parse(readFileSync("archived.json", "utf8"))
    : {};
  // A document a slate was read from is part of its record, though no position cites it.
  const behind = new Map<string, string[]>();
  if (existsSync("sources.json")) {
    const { sources } = JSON.parse(readFileSync("sources.json", "utf8")) as SourceList;
    for (const { url, cited_by, origin } of sources) {
      if (origin === "cited") continue;
      for (const id of cited_by) behind.set(id, [...(behind.get(id) ?? []), url]);
    }
  }
  const endorsementsCommit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"])
    .toString()
    .trim();

  const texts = new Map<string, Awaited<ReturnType<typeof responseText>> | null>();
  const textOf = async (hash: string, rendered: boolean) => {
    if (!texts.has(hash)) {
      const raw = read(hash);
      texts.set(hash, raw && (rendered ? await bodyText(raw, "text/html") : await responseText(raw)));
    }
    return texts.get(hash) ?? null;
  };

  const totals = { slates: 0, sources: 0, exact: 0, quoted_parts: 0, unanchored: 0, no_statement: 0 };
  const notCheckable: Record<string, number> = {};
  const claimCounts: Record<string, number> = {};

  for (const org of readdirSync(join(root, "orgs")).sort()) {
    const orgDir = join(root, "orgs", org);
    if (!statSync(orgDir).isDirectory()) continue;
    for (const election of readdirSync(orgDir).sort()) {
      const file = join(orgDir, election, "positions.json");
      if (!existsSync(file)) continue;
      const bundle = JSON.parse(readFileSync(file, "utf8")) as Bundle;

      const citing = new Map<string, Position[]>();
      for (const url of bundle.attribution?.sources ?? []) citing.set(url, citing.get(url) ?? []);
      for (const url of behind.get(`${org}/${election}`) ?? []) citing.set(url, citing.get(url) ?? []);
      const fallback = bundle.attribution?.sources?.[0];
      for (const position of bundle.positions ?? []) {
        const url = position.source ?? fallback;
        if (url) citing.set(url, [...(citing.get(url) ?? []), position]);
      }

      const path = join("provenance", org, `${election}.json`);
      const previous = existsSync(path)
        ? (JSON.parse(readFileSync(path, "utf8")) as SlateProvenance)
        : null;

      const sources: SourceProvenance[] = [];
      for (const [url, positions] of citing) {
        const refs = byUrl.get(url) ?? [];
        const latest = refs[0] ?? null;
        const last_ok = latest?.status === 200 ? null : (refs.find((r) => r.status === 200) ?? null);
        const source = textSource(latest, last_ok);
        const stated = positions.filter(({ statement }) => statement);
        const derivation: Derivation = {
          kind: "anchored",
          exact: 0,
          quoted_parts: 0,
          unanchored: 0,
          no_statement: positions.length - stated.length,
        };
        const notChecked = (reason: string) => {
          derivation.kind = "not-checkable";
          derivation.reason = reason;
        };

        if (!latest) notChecked("no capture yet");
        else if (!source) notChecked(`no good capture: ${latest.status ?? latest.error}`);
        else {
          const text = await textOf(source.hash, source.rendered);
          if (!text) {
            // Big files aren't always at hand. If the bytes are unchanged, so is the answer.
            const before = previous?.sources.find((entry) => entry.url === url);
            const same = before?.latest?.response_sha256 === source.ref.response_sha256;
            if (same && before?.derivation.kind === "anchored") Object.assign(derivation, before.derivation);
            else notChecked("bytes not at hand");
          } else if ("reason" in text) {
            notChecked(text.reason);
          } else {
            for (const { statement } of stated) {
              const anchor = anchorStatement(statement as string, text.text);
              if (anchor === "exact") derivation.exact++;
              else if (anchor === "quoted-parts") derivation.quoted_parts++;
              else derivation.unanchored++;
            }
          }
        }

        const record = archive[url] ?? null;
        const archivedAgrees =
          record?.identical || (record?.statements && record.statements.of > 0 && record.statements.found === record.statements.of);
        const withArchive = (ref: CaptureRef | null) =>
          ref && archivedAgrees
            ? { ...ref, claims: [...ref.claims, "independently-archived" as const] }
            : ref;
        const entry: SourceProvenance = {
          url,
          positions: positions.length,
          host: hostFact(url, bundle.attribution?.of?.uri),
          latest: withArchive(latest),
          last_ok: withArchive(last_ok),
          archived: record?.timestamp
            ? {
                url: record.url,
                timestamp: record.timestamp,
                digest: record.digest,
                ...(record.origin ? { origin: record.origin } : {}),
                ...(record.statements ? { statements: record.statements } : {}),
              }
            : null,
          derivation,
        };
        sources.push(entry);

        totals.sources++;
        totals.exact += derivation.exact;
        totals.quoted_parts += derivation.quoted_parts;
        totals.unanchored += derivation.unanchored;
        totals.no_statement += derivation.no_statement;
        if (derivation.reason) {
          const key = derivation.reason.split(":")[0] as string;
          notCheckable[key] = (notCheckable[key] ?? 0) + stated.length;
        }
        for (const claim of entry.latest?.claims ?? []) {
          claimCounts[claim] = (claimCounts[claim] ?? 0) + 1;
        }
      }

      const provenance: SlateProvenance = {
        format: PROVENANCE_FORMAT,
        org,
        election,
        mode: bundle.attribution?.mode ?? null,
        org_uri: bundle.attribution?.of?.uri ?? null,
        generated_from: { endorsements_commit: endorsementsCommit, runs: [...runs].reverse() },
        sources,
      };
      mkdirSync(join("provenance", org), { recursive: true });
      writeFileSync(path, `${JSON.stringify(provenance, null, 1)}\n`);
      totals.slates++;
    }
  }
  console.log(totals);
  console.log("statements not checkable:", notCheckable);
  console.log("sources by claim on latest capture:", claimCounts);
  process.exit(0);
}
