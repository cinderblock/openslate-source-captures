// Turn a run into the bytes verify-core wants, from a mirror of this repository or from a folder on
// this computer. Where the bytes come from can't change the answer: verify-core rechecks every hash
// and every signature itself, so a hostile mirror can only fail, not pass.

import type { RunInput, Trust } from "../src/verify-core";

/** The authorities `src/seal.ts` asks. A raw file host can't list a folder, so they're named here. */
export const STAMP_FILES = ["digicert.tsr", "sectigo.tsr"];

const HASH_NAME = /^[0-9a-f]{64}$/;
const FETCHES_AT_ONCE = 12;

export interface Placement {
  withheld: string[];
  guarded: string[];
  release: string[];
}

interface HopHashes {
  request_sha256: string;
  response_sha256: string;
  tls: { chain_sha256: string[] } | null;
}

interface ManifestHashes {
  sources_sha256: string;
  captures: {
    earlier_attempts?: HopHashes[][];
    hops: HopHashes[];
  }[];
}

/** Pure: every hash a manifest names. */
export function blobHashes(manifest: ManifestHashes): string[] {
  const hashes = new Set([manifest.sources_sha256]);
  for (const { earlier_attempts, hops } of manifest.captures) {
    for (const hop of [...(earlier_attempts ?? []).flat(), ...hops]) {
      hashes.add(hop.request_sha256).add(hop.response_sha256);
      for (const hash of hop.tls?.chain_sha256 ?? []) hashes.add(hash);
    }
  }
  return [...hashes];
}

/** Bytes that are meant to be elsewhere, so their absence isn't a failure. */
const elsewhere = (placement: Placement) =>
  new Set([...placement.withheld, ...placement.guarded, ...placement.release]);

const NOWHERE: Placement = { withheld: [], guarded: [], release: [] };

// --- A mirror ------------------------------------------------------------------------------------

async function fetchBytes(url: string): Promise<Uint8Array | null> {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Fetch a run from anything laid out like this repository. `base` ends in a slash. */
export async function fromMirror(
  base: string,
  id: string,
  trust: Trust,
  progress: (done: number, total: number) => void,
): Promise<RunInput> {
  const run = `${base}runs/${encodeURIComponent(id)}/`;
  const manifestBytes = await fetchBytes(`${run}manifest.json`);
  if (!manifestBytes) throw new Error(`no run ${id} at ${base}`);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ManifestHashes;

  const placementBytes = await fetchBytes(`${run}placement.json`);
  const placement: Placement = placementBytes
    ? JSON.parse(new TextDecoder().decode(placementBytes))
    : NOWHERE;
  const withheld = elsewhere(placement);

  const sigstore = await fetchBytes(`${run}manifest.sigstore.json`);
  const stamps: RunInput["stamps"] = [];
  for (const name of STAMP_FILES) {
    const token = await fetchBytes(`${run}stamps/${name}`);
    if (token) stamps.push({ name, token });
  }

  // verify-core asks for blobs one at a time, which would take minutes over HTTP.
  const wanted = blobHashes(manifest).filter((hash) => !withheld.has(hash));
  const cache = new Map<string, Uint8Array | null>();
  const queue = [...wanted];
  let done = 0;
  const worker = async () => {
    for (let hash = queue.shift(); hash; hash = queue.shift()) {
      cache.set(hash, await fetchBytes(`${base}blobs/${hash.slice(0, 2)}/${hash}`));
      progress(++done, wanted.length);
    }
  };
  await Promise.all(Array.from({ length: FETCHES_AT_ONCE }, worker));

  return {
    manifestBytes,
    stamps,
    sigstoreBundle: sigstore && new TextDecoder().decode(sigstore),
    blob: async (hash) => cache.get(hash) ?? null,
    withheld,
    trust,
  };
}

// --- A folder ------------------------------------------------------------------------------------

export interface FoundFile {
  /** Forward slashes, relative to what was picked. */
  path: string;
  read: () => Promise<Uint8Array>;
}

export interface FolderIndex {
  /** Folders holding a manifest.json. */
  runs: string[];
  files: Map<string, FoundFile>;
  /** Anything named by a SHA-256, wherever it sits: blobs/ab/, a flat blobs/, large/. */
  blobs: Map<string, FoundFile>;
}

const SKIPPED = /(^|\/)(node_modules|\.git)\//;

/** Pure. Handles this repo, a run directory fresh from `run.ts`, or any folder holding those. */
export function indexFolder(found: FoundFile[]): FolderIndex {
  const index: FolderIndex = { runs: [], files: new Map(), blobs: new Map() };
  for (const file of found) {
    if (SKIPPED.test(file.path)) continue;
    index.files.set(file.path, file);
    const name = file.path.split("/").at(-1) ?? "";
    if (HASH_NAME.test(name)) index.blobs.set(name, file);
    if (name === "manifest.json") index.runs.push(file.path.slice(0, -name.length));
  }
  index.runs.sort().reverse();
  return index;
}

export async function fromFolder(index: FolderIndex, dir: string, trust: Trust): Promise<RunInput> {
  const read = (path: string) => index.files.get(path)?.read() ?? Promise.resolve(null);
  const manifestBytes = await read(`${dir}manifest.json`);
  if (!manifestBytes) throw new Error(`no manifest.json in ${dir || "this folder"}`);

  const placementBytes = await read(`${dir}placement.json`);
  const placement: Placement = placementBytes
    ? JSON.parse(new TextDecoder().decode(placementBytes))
    : NOWHERE;
  const sigstore = await read(`${dir}manifest.sigstore.json`);

  const stamps: RunInput["stamps"] = [];
  for (const [path, file] of index.files) {
    if (path.startsWith(`${dir}stamps/`) && path.endsWith(".tsr")) {
      stamps.push({ name: path.split("/").at(-1) as string, token: await file.read() });
    }
  }

  return {
    manifestBytes,
    stamps,
    sigstoreBundle: sigstore && new TextDecoder().decode(sigstore),
    blob: async (hash) => (await index.blobs.get(hash)?.read()) ?? null,
    withheld: elsewhere(placement),
    trust,
  };
}
