import { expect, test } from "bun:test";
import { blobHashes, type FoundFile, fromFolder, indexFolder } from "./load";

const file = (path: string, text = ""): FoundFile => ({
  path,
  read: async () => new TextEncoder().encode(text),
});

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

test("blobHashes names every hash once", () => {
  const hop = { request_sha256: A, response_sha256: B, tls: { chain_sha256: [C, A] } };
  const hashes = blobHashes({
    sources_sha256: C,
    captures: [{ hops: [hop, { ...hop, tls: null }] }],
  });
  expect(hashes.sort()).toEqual([A, B, C]);
});

test("blobHashes names earlier attempts' bytes too", () => {
  const D = "d".repeat(64);
  const hop = { request_sha256: A, response_sha256: B, tls: null };
  const hashes = blobHashes({
    sources_sha256: C,
    captures: [{ earlier_attempts: [[{ ...hop, response_sha256: D }]], hops: [hop] }],
  });
  expect(hashes.sort()).toEqual([A, B, C, D]);
});

test("indexFolder finds a repository's runs and blobs, skipping tooling", () => {
  const index = indexFolder([
    file("repo/runs/2026-10-30T1700Z/manifest.json"),
    file("repo/runs/2026-10-31T1000Z/manifest.json"),
    file(`repo/blobs/aa/${A}`),
    file(`repo/large/${B}`),
    file(`repo/node_modules/thing/${C}`),
    file("repo/.git/manifest.json"),
  ]);
  expect(index.runs).toEqual(["repo/runs/2026-10-31T1000Z/", "repo/runs/2026-10-30T1700Z/"]);
  expect([...index.blobs.keys()].sort()).toEqual([A, B]);
});

test("indexFolder takes a run fresh from run.ts, with flat blobs", () => {
  const index = indexFolder([file("smoke/manifest.json"), file(`smoke/blobs/${A}`)]);
  expect(index.runs).toEqual(["smoke/"]);
  expect(index.blobs.has(A)).toBe(true);
});

test("fromFolder gathers a run's own stamps and placement", async () => {
  const placement = JSON.stringify({ withheld: [A], guarded: [B], release: [C] });
  const index = indexFolder([
    file("r/manifest.json", "{}"),
    file("r/placement.json", placement),
    file("r/stamps/digicert.tsr", "x"),
    file("other/stamps/sectigo.tsr", "y"),
  ]);
  const trust = { tsaRootsDer: [], sigstore: { tlogs: [], certificateAuthorities: [] } };
  const input = await fromFolder(index, "r/", trust);
  expect(input.stamps.map(({ name }) => name)).toEqual(["digicert.tsr"]);
  expect([...input.withheld].sort()).toEqual([A, B, C]);
  expect(input.sigstoreBundle).toBeNull();
  expect(await input.blob(A)).toBeNull();
});
