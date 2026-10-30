#!/usr/bin/env bun
// Seal a run: timestamp its manifest with two authorities that don't share an operator. Everything
// else in the run is named by hash inside the manifest, so this covers all of it.
//
//   bun src/seal.ts <out dir>
//
// Each authority only ever sees a hash, so sealing reveals nothing about withheld pages.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./capture";
import { requestTimestamp } from "./rfc3161";

export const AUTHORITIES = {
  digicert: "http://timestamp.digicert.com",
  sectigo: "http://timestamp.sectigo.com",
};

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) throw new Error("usage: seal.ts <out dir>");
  const digest = Buffer.from(sha256(readFileSync(join(out, "manifest.json"))), "hex");
  mkdirSync(join(out, "stamps"), { recursive: true });
  for (const [name, url] of Object.entries(AUTHORITIES)) {
    // An authority being down must not lose a run: retry, and fail loudly only at the end.
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const token = await requestTimestamp(url, digest);
        writeFileSync(join(out, "stamps", `${name}.tsr`), token);
        console.log(`${name}: ${token.length} byte token`);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await Bun.sleep(5000 * (attempt + 1));
      }
    }
    if (lastError) throw lastError;
  }
}
