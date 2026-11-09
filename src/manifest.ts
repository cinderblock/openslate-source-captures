// A capture run on disk: one manifest and the raw bytes it names. Proofs are made over the
// manifest's file bytes, so no canonical JSON is needed: a verifier hashes the file it holds.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Exchange, parseResponse, sha256 } from "./capture";
import type { Rendered } from "./render";

export const MANIFEST_FORMAT = "openslate-source-capture/1";

export interface ManifestHop {
  url: string;
  started_at: string;
  ended_at: string;
  remote_ip: string | null;
  status: number | null;
  error: string | null;
  truncated: boolean;
  request_sha256: string;
  response_sha256: string;
  response_bytes: number;
  tls: {
    protocol: string | null;
    cipher: string | null;
    alpn: string | false | null;
    authorized: boolean;
    authorization_error: string | null;
    /** Leaf first. */
    chain_sha256: string[];
  } | null;
}

export interface Manifest {
  format: typeof MANIFEST_FORMAT;
  run_id: string;
  started_at: string;
  ended_at: string;
  /** sha256 of the sources.json this run read, whose URLs are the run's intended list. */
  sources_sha256: string;
  /** Hosts this run was narrowed to, or null for the whole list. */
  narrowed_to: string[] | null;
  /** The URLs we set out to fetch, in order, fixed before the first request. */
  intended: string[];
  capturer: {
    tool_repository: string;
    tool_commit: string;
    tool_dirty: boolean;
    user_agent: string;
    runtime: string;
    platform: string;
    /** "github-actions" or "local". Says where it ran; only a Sigstore bundle proves it. */
    environment: string;
    run_url: string | null;
  };
  /** One chain of hops per intended URL, in the same order. */
  captures: {
    intended: string;
    /**
     * Attempts before `hops`, oldest first, present only when the first didn't return a 200 (see
     * `src/retry.ts`). Each is a whole redirect chain, kept like the last one.
     */
    earlier_attempts?: ManifestHop[][];
    /** The last attempt: the run's outcome for this URL. */
    hops: ManifestHop[];
    /** A browser's view, beside the hops, for hosts listed in render-hosts.json. */
    rendered?: Rendered;
  }[];
}

/** Write bytes under their own hash; the name is the integrity check. */
export function putBlob(dir: string, bytes: Buffer): string {
  const hash = sha256(bytes);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, hash), bytes);
  return hash;
}

export function recordHop(blobDir: string, hop: Exchange): ManifestHop {
  return {
    url: hop.url,
    started_at: hop.started_at,
    ended_at: hop.ended_at,
    remote_ip: hop.remote_ip,
    status: parseResponse(hop.response).status,
    error: hop.error,
    truncated: hop.truncated,
    request_sha256: putBlob(blobDir, hop.request),
    response_sha256: putBlob(blobDir, hop.response),
    response_bytes: hop.response.length,
    tls: hop.tls && {
      protocol: hop.tls.protocol,
      cipher: hop.tls.cipher,
      alpn: hop.tls.alpn,
      authorized: hop.tls.authorized,
      authorization_error: hop.tls.authorization_error,
      chain_sha256: hop.tls.chain_der.map((der) => putBlob(blobDir, Buffer.from(der, "base64"))),
    },
  };
}

/** Every exchange recorded for one URL, earlier attempts first. Each names bytes the run must hold. */
export const allHops = (capture: Manifest["captures"][number]): ManifestHop[] => [
  ...(capture.earlier_attempts ?? []).flat(),
  ...capture.hops,
];

export const encodeManifest = (manifest: Manifest) =>
  Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);

/** Read named bytes, refusing anything that doesn't hash to its name. */
export function getBlob(path: string, hash: string): Buffer {
  const bytes = readFileSync(path);
  if (sha256(bytes) !== hash) throw new Error(`blob ${hash} does not match its name`);
  return bytes;
}
