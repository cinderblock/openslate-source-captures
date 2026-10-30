#!/usr/bin/env bun
// Drive the built page in real headless Chrome, because the whole point of web/ is that the checks
// hold up outside Bun. Takes a capture folder from `bun src/run.ts` plus `bun src/seal.ts`:
//
//   bun run build-web && bun web/e2e.ts out/smoke [<repository checkout with runs/>]
//
// Covers a folder pick served from localhost, a folder pick from file:// with the network off, a
// mirror fetched over HTTP, and tampers that must be rejected. With a checkout, it also fetches that
// checkout's newest published run from the real raw.githubusercontent.com.

import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find(existsSync);
if (!CHROME) throw new Error("no Chrome found");

const capture = resolve(process.argv[2] ?? "out/smoke");
const checkout = process.argv[3] && resolve(process.argv[3]);
const site = resolve("site");
if (!existsSync(join(site, "main.js"))) throw new Error("run `bun run build-web` first");

const work = mkdtempSync(join(tmpdir(), "oss-e2e-"));

// --- The folders under test ----------------------------------------------------------------------

const copy = (name: string) => {
  const dir = join(work, name);
  cpSync(capture, dir, { recursive: true });
  return dir;
};
const clean = copy("clean");

const flipByte = (path: string) => {
  const bytes = readFileSync(path);
  bytes[bytes.length >> 1] = (bytes[bytes.length >> 1] as number) ^ 1;
  writeFileSync(path, bytes);
};

const tamperedBlob = copy("tampered-blob");
const manifest = JSON.parse(readFileSync(join(capture, "manifest.json"), "utf8"));
flipByte(join(tamperedBlob, "blobs", manifest.captures[0].hops[0].response_sha256));

const tamperedManifest = copy("tampered-manifest");
const manifestPath = join(tamperedManifest, "manifest.json");
writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace('"local"', '"LOCAL"'));

// A real Sigstore bundle, from someone else's workflow: every cryptographic check passes, and only
// the pin should refuse it. That exercises Sigstore's whole path in the browser.
const foreign = copy("foreign-witness");
const bundle = readFileSync("test-fixtures/sigstore/bundle.json", "utf8");
writeFileSync(join(foreign, "manifest.sigstore.json"), bundle);

// The same bundle with its log entry's time changed: now the cryptography itself must refuse it.
const forged = copy("forged-witness");
const edited = JSON.parse(bundle);
const entry = edited.verificationMaterial.tlogEntries[0];
entry.integratedTime = String(Number(entry.integratedTime) + 60);
writeFileSync(join(forged, "manifest.sigstore.json"), JSON.stringify(edited));

// A mirror: the published layout, served over HTTP.
const mirror = join(work, "mirror");
const runDir = join(mirror, "runs", manifest.run_id);
mkdirSync(join(runDir, "stamps"), { recursive: true });
cpSync(join(capture, "manifest.json"), join(runDir, "manifest.json"));
cpSync(join(capture, "stamps"), join(runDir, "stamps"), { recursive: true });
for (const hash of readdirSync(join(capture, "blobs"))) {
  mkdirSync(join(mirror, "blobs", hash.slice(0, 2)), { recursive: true });
  cpSync(join(capture, "blobs", hash), join(mirror, "blobs", hash.slice(0, 2), hash));
}

// --- Servers and the browser ---------------------------------------------------------------------

const serveFrom = (root: string, headers: Record<string, string> = {}) =>
  Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = decodeURIComponent(new URL(request.url).pathname);
      const file = join(root, path === "/" ? "index.html" : path);
      if (!existsSync(file)) return new Response("not found", { status: 404, headers });
      return new Response(Bun.file(file), { headers });
    },
  });
const page = serveFrom(site);
const raw = serveFrom(mirror, { "access-control-allow-origin": "*" });

const profile = join(work, "profile");
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--disable-gpu",
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function devtoolsPort(): Promise<number> {
  const file = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    if (existsSync(file)) {
      const port = Number(readFileSync(file, "utf8").split("\n")[0]);
      if (port) return port;
    }
    await Bun.sleep(100);
  }
  throw new Error("Chrome never opened its debugging port");
}

const port = await devtoolsPort();
const target = (await (
  await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })
).json()) as { webSocketDebuggerUrl: string };

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ready) => socket.addEventListener("open", ready));
let nextId = 1;
const pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
const consoleErrors: string[] = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id) pending.get(message.id)?.(message);
  if (message.method === "Runtime.exceptionThrown") {
    consoleErrors.push(message.params.exceptionDetails.exception?.description ?? "exception");
  }
});
const cdp = async <T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> => {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  const reply = await new Promise<{ result?: unknown; error?: unknown }>((done) =>
    pending.set(id, done),
  );
  if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
  return reply.result as T;
};

const evaluate = async <T>(expression: string): Promise<T> => {
  const reply = await cdp<{ result: { value: T } }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return reply.result.value;
};

async function open(url: string) {
  await cdp("Page.navigate", { url });
  for (let i = 0; i < 100; i++) {
    if (await evaluate<boolean>(`document.readyState === "complete" && !!document.getElementById("folder")`)) return;
    await Bun.sleep(50);
  }
  throw new Error(`${url} never loaded`);
}

interface Outcome {
  verdict: string;
  status: string;
  stamps: string[];
  witness: string;
  problems: string[];
  rows: number;
  totals: string;
}

/** Wait for a verdict, or for the page to say it couldn't get one. */
async function outcome(limitMs = 60_000): Promise<Outcome> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const status = await evaluate<string>(`document.getElementById("status").textContent`);
    if (status.startsWith("Verification finished") || status.startsWith("Couldn't")) break;
    await Bun.sleep(100);
  }
  return evaluate<Outcome>(`({
    verdict: document.getElementById("results").hidden ? "" : document.getElementById("verdict").textContent,
    status: document.getElementById("status").textContent,
    stamps: [...document.querySelectorAll("#stamps li")].map((li) => li.textContent),
    witness: document.getElementById("witness-state")?.textContent ?? "",
    problems: [...document.querySelectorAll("#problems li")].map((li) => li.textContent),
    rows: document.querySelectorAll("#urls tr").length,
    totals: document.getElementById("totals").textContent,
  })`);
}

async function pickFolder(dir: string) {
  const { root } = await cdp<{ root: { nodeId: number } }>("DOM.getDocument");
  const { nodeId } = await cdp<{ nodeId: number }>("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: "#folder",
  });
  // Chrome expands a directory for a webkitdirectory input, as a real pick does.
  await cdp("DOM.setFileInputFiles", { nodeId, files: [dir] });
  return outcome();
}

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) {
    failures.push(name);
    console.log(detail);
  }
};

await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("DOM.enable");
await cdp("Network.enable");

// --- The tests -----------------------------------------------------------------------------------

try {
  const expected = manifest.captures.length as number;
  const home = `http://127.0.0.1:${page.port}/`;

  await open(home);
  const good = await pickFolder(clean);
  check(
    "folder pick: a good run verifies, both stamps checked in the browser",
    good.verdict === "This run verified" &&
      good.stamps.length === 2 &&
      good.rows === expected &&
      good.problems.length === 0,
    good,
  );
  console.log(`  ${good.totals}`);
  console.log(`  ${good.stamps.join("\n  ")}`);

  await open(home);
  const blob = await pickFolder(tamperedBlob);
  check(
    "tamper: one flipped byte in a response is rejected",
    blob.verdict === "This run failed verification" &&
      blob.problems.some((problem) => problem.includes("does not match its name")),
    blob,
  );

  await open(home);
  const edit = await pickFolder(tamperedManifest);
  check(
    "tamper: one edited byte in the manifest fails both stamps",
    edit.verdict === "This run failed verification" &&
      edit.stamps.filter((stamp) => stamp.includes("different document")).length === 2,
    edit,
  );

  await open(home);
  const stranger = await pickFolder(foreign);
  check(
    "real Sigstore bundle from another project: signature accepted, pin refuses it",
    stranger.witness.startsWith("Not witnessed: signed by another repository"),
    stranger,
  );

  await open(home);
  const fake = await pickFolder(forged);
  check(
    "forged Sigstore bundle: the cryptography refuses it in the browser",
    fake.witness.includes("signed entry timestamp does not verify"),
    fake,
  );

  await open(home);
  await evaluate(`(() => {
    document.getElementById("run").value = ${JSON.stringify(manifest.run_id)};
    document.getElementById("base").value = ${JSON.stringify(`http://127.0.0.1:${raw.port}/`)};
    document.querySelector("#mirror-form button").click();
  })()`);
  const fetched = await outcome();
  check(
    "mirror: the same run fetched over HTTP verifies",
    fetched.verdict === "This run verified" && fetched.rows === expected,
    fetched,
  );

  await evaluate(`(() => {
    const input = document.getElementById("filter-status");
    input.value = "none";
    input.dispatchEvent(new Event("input"));
  })()`);
  const filtered = await evaluate<number>(`document.querySelectorAll("#urls tr").length`);
  check("filter: narrows the table", filtered < expected, filtered);

  // Offline for real: the page from file://, a blocked network, and only the folder.
  await open(`file:///${join(site, "index.html").replaceAll("\\", "/")}`);
  await cdp("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  const offline = await pickFolder(clean);
  check(
    "offline: page from file://, network off, a good run still verifies",
    offline.verdict === "This run verified" && offline.stamps.length === 2,
    offline,
  );
  await cdp("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });

  if (checkout) {
    const runs = readdirSync(join(checkout, "runs")).sort();
    const newest = runs.at(-1) as string;
    const report = JSON.parse(readFileSync(join(checkout, "runs", newest, "manifest.json"), "utf8"));
    await open(home);
    await evaluate(`(() => {
      document.getElementById("run").value = ${JSON.stringify(newest)};
      document.querySelector("#mirror-form button").click();
    })()`);
    const live = await outcome(300_000);
    check(
      `live: run ${newest} from raw.githubusercontent.com verifies and is witnessed`,
      live.verdict === "This run verified" &&
        live.witness === "Witnessed by public CI." &&
        live.rows === report.captures.length,
      live,
    );
    console.log(`  ${live.totals}`);
  }

  check("no uncaught exceptions in the page", consoleErrors.length === 0, consoleErrors);
} finally {
  socket.close();
  chrome.kill();
  page.stop(true);
  raw.stop(true);
  await Bun.sleep(500);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // Chrome may still hold its profile for a moment. It's a temp directory.
  }
}

console.log(failures.length ? `\n${failures.length} FAILED` : "\nAll passed.");
process.exit(failures.length ? 1 : 0);
