import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bundleFromJSON } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";
import { loadTrust } from "./verify";
import { sha256Hex, verifySigstore, verifyStamp } from "./verify-core";

const trust = loadTrust();
const bundleText = readFileSync("test-fixtures/sigstore/bundle.json", "utf8");
const manifest = readFileSync("test-fixtures/stamp/manifest.json");

const reference = (text: string) => {
  const verifier = new Verifier(toTrustMaterial(TrustedRoot.fromJSON(trust.sigstore)));
  return verifier.verify(toSignedEntity(bundleFromJSON(JSON.parse(text))));
};

/** Each tamper, against both implementations: they must never disagree. */
const tampers: [string, (bundle: any) => void][] = [
  [
    "attest different bytes",
    (bundle) => {
      const statement = JSON.parse(atob(bundle.dsseEnvelope.payload));
      statement.subject[0].digest = { sha256: "0".repeat(64) };
      bundle.dsseEnvelope.payload = btoa(JSON.stringify(statement));
    },
  ],
  [
    "flip a signature bit",
    (bundle) => {
      const sig = Buffer.from(bundle.dsseEnvelope.signatures[0].sig, "base64");
      sig[10] = (sig[10] as number) ^ 1;
      bundle.dsseEnvelope.signatures[0].sig = sig.toString("base64");
    },
  ],
  ["remove the log entry", (bundle) => (bundle.verificationMaterial.tlogEntries = [])],
  [
    "flip a checkpoint character",
    (bundle) => {
      const proof = bundle.verificationMaterial.tlogEntries[0].inclusionProof;
      proof.checkpoint.envelope = proof.checkpoint.envelope.replace(/\n\d/, "\n9");
    },
  ],
  [
    "shorten the inclusion path",
    (bundle) => bundle.verificationMaterial.tlogEntries[0].inclusionProof.hashes.pop(),
  ],
  [
    "change the logged time",
    (bundle) => {
      const entry = bundle.verificationMaterial.tlogEntries[0];
      entry.integratedTime = String(Number(entry.integratedTime) + 60);
    },
  ],
];

describe("verifySigstore", () => {
  test("accepts a real bundle, and reads the workflow's identity", async () => {
    const check = await verifySigstore(bundleText, trust.sigstore);
    expect(() => reference(bundleText)).not.toThrow();
    expect(check.identity.runner_environment).toBe("github-hosted");
    expect(check.identity.source_repository_uri).toBe("https://github.com/sigstore/sigstore-js");
    expect(check.identity.oidc_issuer).toBe("https://token.actions.githubusercontent.com");
    // npm provenance names its subject by sha512, so there's no sha256 for us to report.
    expect(check.subjects).toEqual([]);
  });

  for (const [name, tamper] of tampers) {
    test(`rejects: ${name}, as the reference library does`, async () => {
      const bundle = JSON.parse(bundleText);
      tamper(bundle);
      const text = JSON.stringify(bundle);
      expect(verifySigstore(text, trust.sigstore)).rejects.toThrow();
      expect(() => reference(text)).toThrow();
    });
  }
});

describe("verifyStamp", () => {
  for (const name of ["digicert", "sectigo"]) {
    const token = readFileSync(`test-fixtures/stamp/${name}.tsr`);

    test(`${name}: a real token over this manifest`, async () => {
      const check = await verifyStamp(name, token, manifest, trust.tsaRootsDer);
      expect(check.gen_time).toStartWith("2026-10-30T");
    });

    test(`${name}: rejects a token over other bytes`, async () => {
      const edited = Buffer.from(manifest);
      edited[20] = (edited[20] as number) ^ 1;
      expect(verifyStamp(name, token, edited, trust.tsaRootsDer)).rejects.toThrow(
        "different document",
      );
    });

    test(`${name}: rejects when its root isn't pinned`, async () => {
      expect(verifyStamp(name, token, manifest, [])).rejects.toThrow();
    });
  }
});

test("sha256Hex agrees with a known vector", async () => {
  expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
