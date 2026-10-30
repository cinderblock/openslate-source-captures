// RFC 3161 timestamps: a request is 60-odd bytes of hand-written DER; verifying a token is pkijs,
// which runs the same in Bun and in a browser because it only needs WebCrypto.

import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";
import * as pkijs from "pkijs";

const SHA256_ALGORITHM = Buffer.from("300d06096086480165030402010500", "hex");

const der = (tag: number, content: Buffer) => {
  if (content.length < 0x80) return Buffer.concat([Buffer.from([tag, content.length]), content]);
  return Buffer.concat([Buffer.from([tag, 0x81, content.length]), content]);
};

/** TimeStampReq, version 1, SHA-256, with a nonce, asking for the signer's certificates. */
export function timestampRequest(digest: Buffer): Buffer {
  const nonce = randomBytes(8);
  nonce[0] = (nonce[0] as number) & 0x7f;
  return der(
    0x30,
    Buffer.concat([
      Buffer.from([0x02, 0x01, 0x01]),
      der(0x30, Buffer.concat([SHA256_ALGORITHM, der(0x04, digest)])),
      der(0x02, nonce),
      Buffer.from([0x01, 0x01, 0xff]),
    ]),
  );
}

export async function requestTimestamp(url: string, digest: Buffer): Promise<Buffer> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/timestamp-query" },
    body: new Uint8Array(timestampRequest(digest)),
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const arrayBufferOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

export interface StampCheck {
  gen_time: string;
  policy: string;
  serial: string;
  signer: string;
  root: string;
  token_bytes: number;
}

/**
 * Who we accept timestamps from. These are Mozilla-listed roots, named by the SHA-256 of their DER,
 * because a token must not get to nominate its own anchor. A browser build would embed these two
 * certificates; here they come out of the runtime's bundle.
 */
export const PINNED_TSA_ROOTS: Record<string, string> = {
  "DigiCert Trusted Root G4": "552f7bdcf1a7af9e6ce672017f4f12abf77240c78e761ac203d1d9d20ac89988",
  "USERTrust RSA Certification Authority":
    "e793c9b02fd8aa13e21c31228accb08119643b749c898964b1746d46c3d4cbd2",
};

const fingerprintOf = (certificate: X509Certificate) =>
  certificate.fingerprint256.replaceAll(":", "").toLowerCase();

const pinnedRoots = rootCertificates
  .map((pem) => new X509Certificate(pem))
  .filter((root) => Object.values(PINNED_TSA_ROOTS).includes(fingerprintOf(root)));

const TIME_STAMPING = "1.3.6.1.5.5.7.3.8";

/** Walk signer to a pinned root, every link valid at the token's own time. */
function pinnedPath(signer: X509Certificate, pool: X509Certificate[], at: Date): string {
  if (!signer.keyUsage?.includes(TIME_STAMPING)) {
    throw new Error(`${signer.subject} is not a timestamping certificate`);
  }
  let current = signer;
  for (let depth = 0; depth < 6; depth++) {
    if (at < new Date(current.validFrom) || at > new Date(current.validTo)) {
      throw new Error(`${current.subject} was not valid at the token's time`);
    }
    const subject = current.issuer;
    const verifies = (candidate: X509Certificate) =>
      candidate.subject === subject && current.verify(candidate.publicKey);
    const root = pinnedRoots.find(verifies);
    if (root) return root.subject.split("\n").at(-1) ?? "(unknown)";
    const issuer = pool.find(verifies);
    if (!issuer) throw new Error(`no issuer for ${current.subject}`);
    current = issuer;
  }
  throw new Error("chain never reached a pinned timestamp root");
}

/** Verify a token offline: a real signature, over this exact data, from a pinned authority. */
export async function verifyStamp(token: Buffer, data: Buffer): Promise<StampCheck> {
  const response = pkijs.TimeStampResp.fromBER(arrayBufferOf(token));
  const statusCode = response.status.status;
  if (statusCode !== 0 && statusCode !== 1) {
    throw new Error(`TSA refused: status ${statusCode}`);
  }
  if (!response.timeStampToken) throw new Error("no token in the response");
  const signed = new pkijs.SignedData({ schema: response.timeStampToken.content });
  const content = signed.encapContentInfo.eContent;
  if (!content) throw new Error("no TSTInfo");
  const info = pkijs.TSTInfo.fromBER(content.getValue());

  const imprint = Buffer.from(info.messageImprint.hashedMessage.getValue());
  const expected = createHash("sha256").update(data).digest();
  if (!imprint.equals(expected)) throw new Error("token is over a different document");

  const result = await signed.verify({
    signer: 0,
    data: arrayBufferOf(data),
    checkChain: false,
    extendedMode: true,
  });
  if (!result.signatureVerified || !result.signerCertificate) {
    throw new Error(`token does not verify: ${result.message ?? "bad signature"}`);
  }
  const pool = (signed.certificates ?? [])
    .filter((certificate) => certificate instanceof pkijs.Certificate)
    .map((certificate) => new X509Certificate(Buffer.from(certificate.toSchema().toBER())));
  const signer = new X509Certificate(Buffer.from(result.signerCertificate.toSchema().toBER()));
  return {
    gen_time: info.genTime.toISOString(),
    policy: info.policy,
    serial: Buffer.from(info.serialNumber.valueBlock.valueHexView).toString("hex"),
    signer: signer.subject.split("\n").at(-1) ?? "(unknown)",
    root: pinnedPath(signer, pool, info.genTime),
    token_bytes: token.length,
  };
}
