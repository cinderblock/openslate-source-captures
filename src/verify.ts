#!/usr/bin/env bun
// Verify a run with the network off, and say exactly what it does and doesn't show.
//
//   bun src/verify.ts runs/<id> [--private <dir>] [--large <dir>] [--json]
//
// Without --private, withheld pages report as withheld: their hashes and proofs still check, and
// their bytes can be checked by whoever is given them. The reference Sigstore library runs as well
// as our WebCrypto check, so two implementations have to agree.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bundleFromJSON } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";
import { localFirst } from "./time";
import { type Trust, verifyRun } from "./verify-core";

globalThis.fetch = (() => {
  throw new Error("the verifier must not touch the network");
}) as unknown as typeof fetch;

export function loadTrust(root = "."): Trust {
  const tsa = JSON.parse(readFileSync(join(root, "trust", "tsa-roots.json"), "utf8")) as {
    certificates: { der_base64: string }[];
  };
  return {
    tsaRootsDer: tsa.certificates.map(({ der_base64 }) => Buffer.from(der_base64, "base64")),
    sigstore: JSON.parse(readFileSync(join(root, "trust", "sigstore-trusted-root.json"), "utf8")),
  };
}

const option = (name: string) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};

if (import.meta.main) {
  const run = process.argv[2];
  if (!run) throw new Error("usage: verify.ts runs/<id> [--private <dir>] [--large <dir>] [--json]");
  const privateRoot = option("--private");
  const largeRoot = option("--large");

  const placement = existsSync(join(run, "placement.json"))
    ? JSON.parse(readFileSync(join(run, "placement.json"), "utf8"))
    : { withheld: [], guarded: [], release: [] };
  const elsewhere = new Set<string>([...placement.withheld, ...placement.guarded]);

  const candidates = (hash: string) => [
    join("blobs", hash.slice(0, 2), hash),
    ...(privateRoot ? [join(privateRoot, "blobs", hash.slice(0, 2), hash)] : []),
    ...(largeRoot ? [join(largeRoot, hash)] : []),
  ];
  const sigstorePath = join(run, "manifest.sigstore.json");
  const sigstoreBundle = existsSync(sigstorePath) ? readFileSync(sigstorePath, "utf8") : null;
  const trust = loadTrust();

  const report = await verifyRun({
    manifestBytes: readFileSync(join(run, "manifest.json")),
    stamps: readdirSync(join(run, "stamps")).map((file) => ({
      name: file,
      token: readFileSync(join(run, "stamps", file)),
    })),
    sigstoreBundle,
    blob: async (hash) => {
      const path = candidates(hash).find((candidate) => existsSync(candidate));
      return path ? readFileSync(path) : null;
    },
    withheld: new Set([...elsewhere, ...placement.release]),
    trust,
  });

  if (sigstoreBundle) {
    const verifier = new Verifier(toTrustMaterial(TrustedRoot.fromJSON(trust.sigstore)));
    try {
      verifier.verify(toSignedEntity(bundleFromJSON(JSON.parse(sigstoreBundle))));
      if (!report.witness) report.problems.push("the two Sigstore verifiers disagree");
    } catch (error) {
      if (report.witness) report.problems.push("the two Sigstore verifiers disagree");
      if (!report.witness_failure) report.witness_failure = (error as Error).message;
    }
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`run ${report.run_id}, manifest sha256 ${report.manifest_sha256}`);
    for (const stamp of report.stamps) {
      console.log(`  ${stamp.name}: ${localFirst(stamp.gen_time)}, root ${stamp.root}`);
    }
    for (const failure of report.stamp_failures) console.log(`  STAMP FAILED ${failure}`);
    if (report.existed_by) console.log(`  existed by ${localFirst(report.existed_by)}`);
    if (report.witness) {
      const { identity, log_index, integrated_time } = report.witness;
      console.log(`  witnessed: ${identity.build_signer_uri}`);
      console.log(`    commit ${identity.source_repository_digest}, ${identity.runner_environment}`);
      console.log(`    ${identity.run_invocation_uri}`);
      console.log(`    log index ${log_index}, ${localFirst(integrated_time)}`);
    } else {
      console.log(`  not witnessed: ${report.witness_failure}`);
    }
    const count = (test: (url: (typeof report.urls)[number]) => boolean) =>
      report.urls.filter(test).length;
    console.log(
      `  ${report.urls.length} URLs: ${count((u) => u.status === 200)} 200, ` +
        `${count((u) => u.status !== null && u.status !== 200)} other status, ` +
        `${count((u) => u.status === null)} no response`,
    );
    console.log(
      `  bytes: ${count((u) => u.bytes === "present")} here, ` +
        `${count((u) => u.bytes === "withheld")} elsewhere, ${count((u) => u.bytes === "missing")} missing`,
    );
    console.log(
      "\nShown: these bytes existed by the time above, unchanged. If witnessed, this public code on " +
        "GitHub's\nrunner produced them. Not shown: that the site wasn't hacked or showing bots " +
        "something else, or that a\ndomain speaks for an organization.",
    );
  }
  for (const problem of report.problems) console.error(`PROBLEM ${problem}`);
  process.exit(report.problems.length || report.stamp_failures.length ? 1 : 0);
}
