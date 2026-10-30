// The verifier, with no Node APIs and no network: WebCrypto and pkijs only, so a browser runs exactly
// the same checks as the CLI. Input is bytes; output is a list of facts. A verifier recomputes every
// claim from these, and nothing here trusts text stored in a run.

import * as pkijs from "pkijs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const unbase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const buffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

const rawSha256 = async (bytes: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(bytes)));
export const sha256Hex = async (bytes: Uint8Array) => hex(await rawSha256(bytes));

const parseCertificate = (der: Uint8Array) => pkijs.Certificate.fromBER(buffer(der));

// --- RFC 3161 timestamps -------------------------------------------------------------------------

export interface StampCheck {
  name: string;
  gen_time: string;
  signer: string;
  root: string;
  serial: string;
}

const TIME_STAMPING = "1.3.6.1.5.5.7.3.8";
const EXTENDED_KEY_USAGE = "2.5.29.37";

const commonName = (certificate: pkijs.Certificate) =>
  String(
    certificate.subject.typesAndValues.find(({ type }) => type === "2.5.4.3")?.value.valueBlock
      .value ?? "(unknown)",
  );

const inForce = (certificate: pkijs.Certificate, at: Date) =>
  at >= certificate.notBefore.value && at <= certificate.notAfter.value;

/** Walk signer to a pinned root, every link valid at the token's own time. */
async function pinnedPath(
  signer: pkijs.Certificate,
  pool: pkijs.Certificate[],
  roots: pkijs.Certificate[],
  at: Date,
): Promise<string> {
  const usage = signer.extensions?.find(({ extnID }) => extnID === EXTENDED_KEY_USAGE);
  const purposes = (usage?.parsedValue as pkijs.ExtKeyUsage | undefined)?.keyPurposes ?? [];
  if (!purposes.includes(TIME_STAMPING)) {
    throw new Error(`${commonName(signer)} is not a timestamping certificate`);
  }
  let current = signer;
  for (let depth = 0; depth < 6; depth++) {
    if (!inForce(current, at)) {
      throw new Error(`${commonName(current)} was not valid at the token's time`);
    }
    const verifies = async (candidate: pkijs.Certificate) =>
      current.issuer.isEqual(candidate.subject) && (await current.verify(candidate));
    for (const root of roots) {
      if (await verifies(root)) return commonName(root);
    }
    let next: pkijs.Certificate | undefined;
    for (const candidate of pool) {
      if (await verifies(candidate)) next = candidate;
    }
    if (!next) throw new Error(`no issuer for ${commonName(current)}`);
    current = next;
  }
  throw new Error("chain never reached a pinned timestamp root");
}

/** A real signature, over exactly this data, from a pinned authority. */
export async function verifyStamp(
  name: string,
  token: Uint8Array,
  data: Uint8Array,
  rootsDer: Uint8Array[],
): Promise<StampCheck> {
  const response = pkijs.TimeStampResp.fromBER(buffer(token));
  const status = response.status.status;
  if (status !== 0 && status !== 1) throw new Error(`TSA refused: status ${status}`);
  if (!response.timeStampToken) throw new Error("no token in the response");
  const signed = new pkijs.SignedData({ schema: response.timeStampToken.content });
  const content = signed.encapContentInfo.eContent;
  if (!content) throw new Error("no TSTInfo");
  const info = pkijs.TSTInfo.fromBER(content.getValue());

  const imprint = new Uint8Array(info.messageImprint.hashedMessage.getValue());
  if (!same(imprint, await rawSha256(data))) throw new Error("token is over a different document");

  const result = await signed.verify({
    signer: 0,
    data: buffer(data),
    checkChain: false,
    extendedMode: true,
  });
  if (!result.signatureVerified || !result.signerCertificate) {
    throw new Error(`token does not verify: ${result.message ?? "bad signature"}`);
  }
  const pool = (signed.certificates ?? []).filter(
    (certificate): certificate is pkijs.Certificate => certificate instanceof pkijs.Certificate,
  );
  return {
    name,
    gen_time: info.genTime.toISOString(),
    signer: commonName(result.signerCertificate),
    root: await pinnedPath(
      result.signerCertificate,
      pool,
      rootsDer.map(parseCertificate),
      info.genTime,
    ),
    serial: hex(new Uint8Array(info.serialNumber.valueBlock.valueHexView)),
  };
}

// --- Sigstore ------------------------------------------------------------------------------------

interface TrustedRoot {
  tlogs: {
    baseUrl: string;
    publicKey: { rawBytes: string; keyDetails: string };
    logId: { keyId: string };
  }[];
  certificateAuthorities: {
    certChain: { certificates: { rawBytes: string }[] };
    validFor: { start: string; end?: string };
  }[];
}

/** What Fulcio certified about the workflow that signed, from GitHub's OIDC token. */
export interface WorkflowIdentity {
  oidc_issuer: string;
  build_signer_uri: string;
  runner_environment: string;
  source_repository_uri: string;
  source_repository_digest: string;
  source_repository_ref: string;
  build_trigger: string;
  run_invocation_uri: string;
}

export interface SigstoreCheck {
  identity: WorkflowIdentity;
  /** sha256 of each attested subject. */
  subjects: string[];
  log_index: string;
  integrated_time: string;
}

const FULCIO_CLAIMS: Record<string, keyof WorkflowIdentity> = {
  "1.3.6.1.4.1.57264.1.8": "oidc_issuer",
  "1.3.6.1.4.1.57264.1.9": "build_signer_uri",
  "1.3.6.1.4.1.57264.1.11": "runner_environment",
  "1.3.6.1.4.1.57264.1.12": "source_repository_uri",
  "1.3.6.1.4.1.57264.1.13": "source_repository_digest",
  "1.3.6.1.4.1.57264.1.14": "source_repository_ref",
  "1.3.6.1.4.1.57264.1.20": "build_trigger",
  "1.3.6.1.4.1.57264.1.21": "run_invocation_uri",
};

function workflowIdentity(leaf: pkijs.Certificate): WorkflowIdentity {
  const claims: Partial<WorkflowIdentity> = {};
  for (const extension of leaf.extensions ?? []) {
    const name = FULCIO_CLAIMS[extension.extnID];
    if (!name) continue;
    // These values are DER UTF8Strings: skip the tag and length.
    const value = extension.extnValue.valueBlock.valueHexView;
    const second = value[1] as number;
    claims[name] = decoder.decode(value.subarray(second >= 0x80 ? 2 + (second & 0x7f) : 2));
  }
  for (const name of Object.values(FULCIO_CLAIMS)) {
    if (!claims[name]) throw new Error(`certificate has no ${name}`);
  }
  return claims as WorkflowIdentity;
}

/** WebCrypto wants r||s; X.509 and Sigstore carry DER. */
function rawEcdsaSignature(der: Uint8Array, size: number): Uint8Array {
  if (der[0] !== 0x30) throw new Error("malformed signature");
  let at = (der[1] as number) >= 0x80 ? 2 + ((der[1] as number) & 0x7f) : 2;
  const integer = () => {
    if (der[at] !== 0x02) throw new Error("malformed signature");
    const length = der[at + 1] as number;
    let value = der.subarray(at + 2, at + 2 + length);
    at += 2 + length;
    while (value.length > size && value[0] === 0) value = value.subarray(1);
    if (value.length > size) throw new Error("malformed signature");
    return concat(new Uint8Array(size - value.length), value);
  };
  return concat(integer(), integer());
}

async function verifyEcdsa(spki: Uint8Array, signature: Uint8Array, data: Uint8Array) {
  for (const [namedCurve, hash, size] of [
    ["P-256", "SHA-256", 32],
    ["P-384", "SHA-384", 48],
  ] as const) {
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey("spki", buffer(spki), { name: "ECDSA", namedCurve }, false, [
        "verify",
      ]);
    } catch {
      continue;
    }
    return crypto.subtle.verify(
      { name: "ECDSA", hash },
      key,
      buffer(rawEcdsaSignature(signature, size)),
      buffer(data),
    );
  }
  throw new Error("unsupported public key");
}

const pae = (type: string, payload: Uint8Array) =>
  concat(
    encoder.encode(`DSSEv1 ${encoder.encode(type).length} ${type} ${payload.length} `),
    payload,
  );

/** RFC 9162 inclusion: does this leaf, at this index, hash up to this root? */
async function merkleRoot(leaf: Uint8Array, index: bigint, size: bigint, path: Uint8Array[]) {
  const node = (left: Uint8Array, right: Uint8Array) =>
    rawSha256(concat(Uint8Array.of(1), left, right));
  let fn = index;
  let sn = size - 1n;
  let root = await rawSha256(concat(Uint8Array.of(0), leaf));
  for (const sibling of path) {
    if (sn === 0n) throw new Error("inclusion proof is too long");
    if ((fn & 1n) === 1n || fn === sn) {
      root = await node(sibling, root);
      while ((fn & 1n) === 0n && fn !== 0n) {
        fn >>= 1n;
        sn >>= 1n;
      }
    } else {
      root = await node(root, sibling);
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  if (sn !== 0n) throw new Error("inclusion proof is too short");
  return root;
}

/** Everything needed to accept a Sigstore bundle, offline. Pinning whose it is comes after. */
export async function verifySigstore(bundleText: string, root: TrustedRoot): Promise<SigstoreCheck> {
  const bundle = JSON.parse(bundleText);
  const material = bundle.verificationMaterial;
  const leafDer = unbase64(
    material.certificate?.rawBytes ?? material.x509CertificateChain?.certificates?.[0]?.rawBytes,
  );
  const leaf = parseCertificate(leafDer);
  const entry = material.tlogEntries?.[0];
  if (!entry) throw new Error("no transparency log entry");
  if (entry.kindVersion?.kind !== "dsse") throw new Error("not a DSSE log entry");

  const log = root.tlogs.find(({ logId }) => logId.keyId === entry.logId.keyId);
  if (!log) throw new Error("log is not in the trusted root");
  const logKey = unbase64(log.publicKey.rawBytes);

  // The log's signed promise is what authenticates the time.
  const body = entry.canonicalizedBody as string;
  const logIdHex = hex(unbase64(entry.logId.keyId));
  const promised = encoder.encode(
    `{"body":"${body}","integratedTime":${entry.integratedTime},"logID":"${logIdHex}","logIndex":${entry.logIndex}}`,
  );
  const promise = entry.inclusionPromise?.signedEntryTimestamp;
  if (!promise || !(await verifyEcdsa(logKey, unbase64(promise), promised))) {
    throw new Error("log's signed entry timestamp does not verify");
  }
  const integrated = new Date(Number(entry.integratedTime) * 1000);

  // Fulcio's chain, and the certificate in force at that time.
  if (!inForce(leaf, integrated)) throw new Error("certificate not valid at log time");
  let chained = false;
  for (const authority of root.certificateAuthorities) {
    const { start, end } = authority.validFor;
    if (integrated < new Date(start) || (end && integrated > new Date(end))) continue;
    const chain = authority.certChain.certificates.map(({ rawBytes }) =>
      parseCertificate(unbase64(rawBytes)),
    );
    let current = leaf;
    let linked = true;
    for (const issuer of chain) {
      if (!(await current.verify(issuer).catch(() => false))) {
        linked = false;
        break;
      }
      current = issuer;
    }
    if (linked) chained = true;
  }
  if (!chained) throw new Error("certificate does not chain to a trusted Fulcio root");

  // The envelope's signature, by the certificate's key.
  const envelope = bundle.dsseEnvelope;
  const payload = unbase64(envelope.payload);
  const signature = unbase64(envelope.signatures?.[0]?.sig ?? "");
  const spki = new Uint8Array(leaf.subjectPublicKeyInfo.toSchema().toBER(false));
  if (!(await verifyEcdsa(spki, signature, pae(envelope.payloadType, payload)))) {
    throw new Error("DSSE signature does not verify");
  }

  // The log entry is about this envelope and this certificate.
  const logged = JSON.parse(decoder.decode(unbase64(body)));
  if (logged.spec.payloadHash.value !== (await sha256Hex(payload))) {
    throw new Error("DSSE payload hash mismatch");
  }
  const loggedSignature = logged.spec.signatures?.[0];
  if (loggedSignature?.signature !== envelope.signatures[0].sig) {
    throw new Error("log entry is for a different signature");
  }
  const pem = decoder.decode(unbase64(loggedSignature.verifier));
  const pemDer = unbase64(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""));
  if (!same(pemDer, leafDer)) throw new Error("log entry is for a different certificate");

  // Included in a tree the log signed.
  const proof = entry.inclusionProof;
  if (!proof) throw new Error("no inclusion proof");
  const computed = await merkleRoot(
    unbase64(body),
    BigInt(proof.logIndex),
    BigInt(proof.treeSize),
    (proof.hashes as string[]).map(unbase64),
  );
  if (!same(computed, unbase64(proof.rootHash))) throw new Error("inclusion proof does not match");

  const checkpoint = proof.checkpoint.envelope as string;
  const split = checkpoint.indexOf("\n\n");
  const note = checkpoint.slice(0, split + 1);
  const [, size, rootHash] = note.split("\n");
  if (size !== String(proof.treeSize) || rootHash !== proof.rootHash) {
    throw new Error("checkpoint is for a different tree");
  }
  const line = checkpoint
    .slice(split + 2)
    .split("\n")
    .find((text) => text.startsWith("— "));
  const sealed = unbase64(line?.split(" ").at(-1) ?? "");
  if (!(await verifyEcdsa(logKey, sealed.subarray(4), encoder.encode(note)))) {
    throw new Error("checkpoint signature does not verify");
  }

  const statement = JSON.parse(decoder.decode(payload));
  return {
    identity: workflowIdentity(leaf),
    subjects: (statement.subject as { digest: { sha256?: string } }[]).flatMap(
      ({ digest }) => digest.sha256 ?? [],
    ),
    log_index: String(entry.logIndex),
    integrated_time: integrated.toISOString(),
  };
}

// --- A whole run ---------------------------------------------------------------------------------

/** Whose witness we accept. A bundle signed by anyone else is a valid signature and worth nothing. */
export const PINNED_WORKFLOW = {
  repository: "https://github.com/cinderblock/openslate-source-captures",
  workflow: "https://github.com/cinderblock/openslate-source-captures/.github/workflows/capture.yml@",
  issuer: "https://token.actions.githubusercontent.com",
  runner: "github-hosted",
};

export interface Trust {
  tsaRootsDer: Uint8Array[];
  sigstore: TrustedRoot;
}

export interface RunInput {
  manifestBytes: Uint8Array;
  stamps: { name: string; token: Uint8Array }[];
  sigstoreBundle: string | null;
  /** Bytes by hash, or null if they aren't here. Hashes are always rechecked. */
  blob: (hash: string) => Promise<Uint8Array | null>;
  /** Hashes the run says are kept private, so their absence isn't a failure. */
  withheld: Set<string>;
  trust: Trust;
}

export type Bytes = "present" | "withheld" | "missing";

export interface UrlFacts {
  url: string;
  status: number | null;
  error: string | null;
  final_url: string;
  response_sha256: string;
  bytes: Bytes;
  truncated: boolean;
  /** Status a headless browser got, where the run also rendered this page. */
  rendered_status: number | null;
}

export interface RunReport {
  run_id: string;
  manifest_sha256: string;
  /** Anything here means the run failed verification. */
  problems: string[];
  /** Each authority separately: one failing doesn't hide the other. */
  stamps: StampCheck[];
  stamp_failures: string[];
  /** The earliest authenticated time. Everything in the manifest existed by then. */
  existed_by: string | null;
  witness: (SigstoreCheck & { manifest_attested: true }) | null;
  witness_failure: string | null;
  urls: UrlFacts[];
}

const statusOf = (raw: Uint8Array) => {
  const end = raw.indexOf(13);
  if (end < 0) return null;
  const line = decoder.decode(raw.subarray(0, end));
  if (!line.startsWith("HTTP/")) return null;
  return Number(line.split(" ")[1]) || null;
};

interface Hop {
  url: string;
  status: number | null;
  error: string | null;
  truncated: boolean;
  request_sha256: string;
  response_sha256: string;
  tls: { chain_sha256: string[] } | null;
}

interface ManifestShape {
  run_id: string;
  sources_sha256: string;
  narrowed_to: string[] | null;
  intended: string[];
  capturer: { tool_commit: string; tool_dirty: boolean };
  captures: {
    intended: string;
    hops: Hop[];
    rendered?: { status: number | null; document_sha256: string | null; dom_sha256: string | null };
  }[];
}

/** Recompute everything about a run from its bytes. */
export async function verifyRun(input: RunInput): Promise<RunReport> {
  const manifest = JSON.parse(decoder.decode(input.manifestBytes)) as ManifestShape;
  const manifest_sha256 = await sha256Hex(input.manifestBytes);
  const problems: string[] = [];

  const stamps: StampCheck[] = [];
  const stamp_failures: string[] = [];
  for (const { name, token } of input.stamps) {
    try {
      stamps.push(await verifyStamp(name, token, input.manifestBytes, input.trust.tsaRootsDer));
    } catch (error) {
      stamp_failures.push(`${name}: ${(error as Error).message}`);
    }
  }

  let witness: RunReport["witness"] = null;
  let witness_failure: string | null = input.sigstoreBundle ? null : "no Sigstore bundle in this run";
  if (input.sigstoreBundle) {
    try {
      const check = await verifySigstore(input.sigstoreBundle, input.trust.sigstore);
      const { identity } = check;
      if (identity.oidc_issuer !== PINNED_WORKFLOW.issuer) throw new Error("wrong OIDC issuer");
      if (identity.source_repository_uri !== PINNED_WORKFLOW.repository) {
        throw new Error(`signed by another repository: ${identity.source_repository_uri}`);
      }
      if (!identity.build_signer_uri.startsWith(PINNED_WORKFLOW.workflow)) {
        throw new Error(`signed by another workflow: ${identity.build_signer_uri}`);
      }
      if (identity.runner_environment !== PINNED_WORKFLOW.runner) {
        throw new Error(`not a GitHub-hosted runner: ${identity.runner_environment}`);
      }
      if (!check.subjects.includes(manifest_sha256)) {
        throw new Error("attestation is over a different manifest");
      }
      if (identity.source_repository_digest !== manifest.capturer.tool_commit) {
        throw new Error("attested commit differs from the manifest's tool commit");
      }
      if (manifest.capturer.tool_dirty) throw new Error("tool had uncommitted changes");
      witness = { ...check, manifest_attested: true };
    } catch (error) {
      witness_failure = (error as Error).message;
    }
  }

  const times = [...stamps.map(({ gen_time }) => gen_time), witness?.integrated_time].filter(
    (time): time is string => Boolean(time),
  );
  const existed_by = times.length
    ? new Date(Math.min(...times.map((time) => Date.parse(time)))).toISOString()
    : null;

  const checked = new Map<string, Bytes>();
  const hold = async (hash: string): Promise<{ state: Bytes; bytes: Uint8Array | null }> => {
    const bytes = await input.blob(hash);
    if (!bytes) {
      const state = input.withheld.has(hash) ? "withheld" : "missing";
      checked.set(hash, state);
      return { state, bytes: null };
    }
    if ((await sha256Hex(bytes)) !== hash) {
      problems.push(`blob ${hash} does not match its name`);
      checked.set(hash, "missing");
      return { state: "missing", bytes: null };
    }
    checked.set(hash, "present");
    return { state: "present", bytes };
  };

  const list = await hold(manifest.sources_sha256);
  if (list.bytes && !manifest.narrowed_to) {
    const { sources } = JSON.parse(decoder.decode(list.bytes)) as { sources: { url: string }[] };
    const wanted = sources.map(({ url }) => url);
    if (wanted.join("\n") !== manifest.intended.join("\n")) {
      problems.push("manifest's intended URLs differ from its source list");
    }
  } else if (list.state === "missing") {
    problems.push("source list is missing");
  }
  if (manifest.captures.map(({ intended }) => intended).join("\n") !== manifest.intended.join("\n")) {
    problems.push("an intended URL has no recorded outcome");
  }

  const urls: UrlFacts[] = [];
  for (const { intended, hops, rendered } of manifest.captures) {
    let state: Bytes = "missing";
    for (const hop of hops) {
      const request = await hold(hop.request_sha256);
      if (request.state === "missing") problems.push(`missing request ${hop.request_sha256}`);
      for (const hash of hop.tls?.chain_sha256 ?? []) {
        if ((await hold(hash)).state === "missing") problems.push(`missing certificate ${hash}`);
      }
      const response = await hold(hop.response_sha256);
      state = response.state;
      if (state === "missing") problems.push(`missing response ${hop.response_sha256}`);
      if (response.bytes && statusOf(response.bytes) !== hop.status) {
        problems.push(`manifest status disagrees with the bytes for ${hop.url}`);
      }
    }
    for (const hash of [rendered?.document_sha256, rendered?.dom_sha256]) {
      if (hash && (await hold(hash)).state === "missing") problems.push(`missing render ${hash}`);
    }
    const last = hops.at(-1);
    if (!last) {
      problems.push(`no exchange recorded for ${intended}`);
      continue;
    }
    urls.push({
      url: intended,
      status: last.status,
      error: last.error,
      final_url: last.url,
      response_sha256: last.response_sha256,
      bytes: state,
      truncated: last.truncated,
      rendered_status: rendered?.status ?? null,
    });
  }

  return {
    run_id: manifest.run_id,
    manifest_sha256,
    problems,
    stamps,
    stamp_failures,
    existed_by,
    witness,
    witness_failure,
    urls,
  };
}

export { toBase64 };
