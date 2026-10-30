// What ties a slate to its captures: one file per slate, provenance/<org>/<election>.json, rebuilt
// from the runs and the published bundles. It lives here, not in the endorsements repo, so a sweep
// that changes no position doesn't republish a slate. Claims are recomputed by verify-core; this
// file says where to look, and nothing in it is taken on trust.

export const PROVENANCE_FORMAT = "openslate-source-provenance/1";

export type Claim =
  /** Raw bytes exist and their hash is sealed. */
  | "captured"
  /** Two independent authorities timestamped the run. */
  | "time-stamped"
  /** A pinned public workflow on a GitHub-hosted runner produced the run. */
  | "witnessed-by-public-ci"
  /** An Internet Archive snapshot's text agrees with what the slate used. */
  | "independently-archived";

/** Exact, or the source sits somewhere other than the organization's own domain. */
export interface HostFact {
  match: "exact" | "subdomain" | "hosted-elsewhere" | "unknown";
  host: string;
  /** Host of attribution.of.uri, when the bundle has one. */
  org_host: string | null;
}

export interface CaptureRef {
  run: string;
  /** Position in the manifest's captures array. */
  index: number;
  captured_at: string;
  status: number | null;
  error: string | null;
  final_url: string;
  response_sha256: string;
  /** Where the bytes are: this repo, the private store, or the large-blobs release. */
  bytes: "public" | "withheld" | "release";
  claims: Claim[];
  /** Headless Chrome's view, for hosts a plain GET can't see. Chrome's view, not socket bytes. */
  rendered?: { status: number | null; dom_sha256: string | null };
}

/** Whether we asked the Archive for this snapshot, or it had it already. Absent when we can't tell. */
export type Origin = "requested" | "existing";

export interface Archived {
  url: string;
  /** Wayback's 14-digit timestamp. */
  timestamp: string;
  /** Wayback's base32 SHA-1 of the page as it stored it. */
  digest: string;
  origin?: Origin;
  /** This slate's statements found in the snapshot's own text. What keeps a dead page checkable. */
  statements?: { found: number; of: number };
}

/** How the slate's text relates to this source. Facts only: a failed anchor isn't a judgement. */
export interface Derivation {
  kind: "anchored" | "not-checkable";
  /** Why it couldn't be checked: no bytes, a PDF, an image, a non-200. */
  reason?: string;
  exact: number;
  quoted_parts: number;
  unanchored: number;
  /** Positions citing this source with no statement to check. */
  no_statement: number;
}

export interface SourceProvenance {
  url: string;
  positions: number;
  host: HostFact;
  /** The newest capture, whatever it was. A 404 here is the record that the page went away. */
  latest: CaptureRef | null;
  /** The newest capture that returned 200, if that isn't `latest`. */
  last_ok: CaptureRef | null;
  archived: Archived | null;
  derivation: Derivation;
}

export interface SlateProvenance {
  format: typeof PROVENANCE_FORMAT;
  org: string;
  election: string;
  /** "scraped", "transcribed", "inferred", as the bundle says. */
  mode: string | null;
  org_uri: string | null;
  generated_from: { endorsements_commit: string; runs: string[] };
  sources: SourceProvenance[];
}

/** Pure: compare a source's host with the organization's. */
export function hostFact(url: string, orgUri: string | null | undefined): HostFact {
  const clean = (value: string) => new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  let host: string;
  try {
    host = clean(url);
  } catch {
    return { match: "unknown", host: url, org_host: null };
  }
  let orgHost: string | null = null;
  try {
    orgHost = orgUri ? clean(orgUri) : null;
  } catch {
    orgHost = null;
  }
  if (!orgHost) return { match: "unknown", host, org_host: null };
  if (host === orgHost) return { match: "exact", host, org_host: orgHost };
  if (host.endsWith(`.${orgHost}`)) return { match: "subdomain", host, org_host: orgHost };
  return { match: "hosted-elsewhere", host, org_host: orgHost };
}
