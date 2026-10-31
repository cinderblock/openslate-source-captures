#!/usr/bin/env bun
// Fill in what CI couldn't read, from a home address: capture, timestamp, place the bytes, push. The
// hosts come off the newest CI run (src/blocked.ts). The run is timestamped but unwitnessed, and its
// manifest says so. This machine's address is looked up each time and never printed, because
// publish.ts needs it to keep private any block page that repeats it.
//
//   bun src/fill-in.ts <private store checkout>

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { blockedHosts } from "./blocked";
import type { Manifest } from "./manifest";

const newestCiRun = () => {
  const id = readdirSync("runs")
    .filter((run) => existsSync(join("runs", run, "manifest.sigstore.json")))
    .sort()
    .at(-1);
  if (!id) throw new Error("no CI run in runs/");
  return JSON.parse(readFileSync(join("runs", id, "manifest.json"), "utf8")) as Manifest;
};

const address = async (url: string) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return response.ok ? (await response.text()).trim() : null;
  } catch {
    return null;
  }
};

if (import.meta.main) {
  const privateStore = process.argv[2] && resolve(process.argv[2]);
  if (!privateStore) throw new Error("usage: fill-in.ts <private store checkout>");
  const run = (command: string, args: string[], cwd = process.cwd(), env = process.env) =>
    execFileSync(command, args, { cwd, env, stdio: "inherit" });

  run("git", ["pull", "--quiet", "--ff-only"]);
  run("git", ["pull", "--quiet", "--ff-only"], privateStore);

  const hosts = blockedHosts(newestCiRun().captures);
  if (hosts.length === 0) {
    console.log("CI read everything, so there's nothing to fill in.");
    process.exit(0);
  }
  const guards = (
    await Promise.all([address("https://api.ipify.org"), address("https://api64.ipify.org")])
  ).filter(Boolean);
  // Better no run than one that might publish this address.
  if (guards.length === 0) throw new Error("couldn't look up this machine's address");
  const env = { ...process.env, CAPTURE_GUARD_IPS: [...new Set(guards)].join(",") };

  const out = mkdtempSync(join(tmpdir(), "capture-fill-in-"));
  run("bun", ["src/run.ts", out, "--only-hosts", hosts.join(",")]);
  run("bun", ["src/seal.ts", out]);
  const { run_id } = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as Manifest;
  cpSync("sources.json", join(out, "sources.json"));
  run("bun", ["src/publish.ts", out, "--private", privateStore], process.cwd(), env);

  const message = [
    "-m",
    `capture ${run_id} (local: what CI couldn't read)`,
    "-m",
    "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
  ];
  run("git", ["add", "blobs"], privateStore);
  run("git", ["commit", "--quiet", ...message], privateStore);
  run("git", ["push", "--quiet"], privateStore);
  run("git", ["add", "runs", "blobs"]);
  run("git", ["commit", "--quiet", ...message]);
  run("git", ["pull", "--quiet", "--rebase"]);
  run("git", ["push", "--quiet"]);
  rmSync(out, { recursive: true, force: true });
  console.log(`${run_id}: ${hosts.length} hosts filled in`);
}
