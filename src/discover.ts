#!/usr/bin/env bun
// Find the data behind a page. Some sources load their text with script, so a plain GET of the page
// holds none of it. This loads a page once in headless Chrome, watches what it fetches, and reports
// which responses hold the names we expected.
//
//   bun src/discover.ts --from <endorsements checkout> <url> [url...] [--out <file>]
//   bun src/discover.ts --names "Ann Lee,Bob Ruiz" <url>
//
// It proposes, a person decides. This never edits the capture list: anything worth keeping goes in
// discovered.json by hand. Capture only sends a POST that entry spells out. Bodies are measured and thrown away, so
// the report holds URLs and counts only. It speaks to Chrome over the DevTools Protocol directly,
// which needs no dependency and no browser download, and uses a throwaway profile.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_AGENT } from "./user-agent";
import { comparable } from "./text";

export const SHARE_NEEDED = 0.5;

/** Saves the sites some bytes: nothing we're looking for is in these. */
export const BLOCKED = ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.svg", "*.woff", "*.woff2", "*.mp4"];

export const LOAD_LIMIT_MS = 45_000;
/** Pages keep loading after the load event, so wait for the network to go quiet. */
export const QUIET_MS = 3_000;
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v", "phd", "md", "esq"]);

/** The last word of a person's name, in comparable form. Null if it can't be a surname. */
export function surnameOf(name: string): string | null {
  const words = comparable(name.replace(/\([^)]*\)/g, " "))
    .split(" ")
    .filter((word) => word.length > 1 && !SUFFIXES.has(word));
  if (words.length < 2) return null;
  const last = words.at(-1) as string;
  return last.length >= 3 ? last : null;
}

/** Each distinct surname once, so a common name doesn't count twice. */
export function expectedSurnames(names: string[]): string[] {
  const surnames = names.map(surnameOf).filter((name): name is string => name !== null);
  return [...new Set(surnames)].sort();
}

/** Pure: how many surnames appear as whole words in this text? */
export function countHits(text: string, surnames: string[]): number {
  const words = new Set(comparable(text).split(" "));
  return surnames.filter((surname) => words.has(surname)).length;
}

export interface Seen {
  url: string;
  /** Chrome's resource type: XHR, Fetch, Document, Script, Stylesheet and so on. */
  type: string;
  method: string;
  status: number | null;
  mime: string | null;
  bytes: number;
  hits: number;
}

export interface Proposal extends Seen {
  share: number;
  same_site: boolean;
  /** Capture only does GET today. */
  needs_post: boolean;
}

/** Last two labels: close enough for "is this the same site?", which a person then checks. */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().split(".").slice(-2).join(".");
  } catch {
    return url;
  }
}

/** Pages often fetch the same URL twice: one row each, keeping the fullest. */
function distinct(seen: Seen[]): Seen[] {
  const byUrl = new Map<string, Seen>();
  for (const response of seen) {
    const known = byUrl.get(response.url);
    if (!known || response.hits > known.hits) byUrl.set(response.url, response);
  }
  return [...byUrl.values()];
}

/** Pure: the PDFs in a page load. A zero here would mean unread, not absent. */
export const unreadDocuments = (seen: Seen[]) =>
  distinct(seen).filter(({ mime }) => /pdf/i.test(mime ?? ""));

/** Pure: which responses hold enough of the expected names, best first. */
export function propose(page: string, seen: Seen[], total: number): Proposal[] {
  const pageUrl = page.split("#")[0];
  const site = siteOf(page);
  return distinct(seen)
    .filter(({ url }) => url.split("#")[0] !== pageUrl)
    .map((response) => ({
      ...response,
      share: total ? response.hits / total : 0,
      same_site: siteOf(response.url) === site,
      needs_post: response.method !== "GET",
    }))
    .filter(({ share }) => total > 0 && share >= SHARE_NEEDED)
    .sort((a, b) => b.hits - a.hits || a.url.localeCompare(b.url));
}

export interface Discovery {
  page: string;
  final_url: string | null;
  loaded_at: string;
  error: string | null;
  expected: number;
  /** Names in the page's HTML as served, and in the text once scripts had run. */
  document_hits: number;
  rendered_hits: number;
  frames: string[];
  requests: number;
  /** Every XHR and fetch, matching or not, so a person can see what was there. */
  data_requests: Seen[];
  proposals: Proposal[];
  /** PDFs the page loaded. This check can't read them, so they're listed rather than scored. */
  unread_documents: Seen[];
}

export function findChrome(): string {
  const candidates =
    process.platform === "win32"
      ? [
          `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error(`Chrome not found in: ${candidates.join(", ")}`);
  return found;
}

/** A DevTools Protocol session: send a command, await its reply, listen for events. */
export class Cdp {
  private id = 0;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners: ((method: string, params: any, session?: string) => void)[] = [];

  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const pending = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        if (message.error) pending?.reject(new Error(message.error.message));
        else pending?.resolve(message.result);
        return;
      }
      for (const listen of this.listeners) listen(message.method, message.params, message.sessionId);
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(new Cdp(socket)));
      socket.addEventListener("error", () => reject(new Error("no DevTools connection")));
    });
  }

  on(listen: (method: string, params: any, session?: string) => void) {
    this.listeners.push(listen);
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close() {
    this.socket.close();
  }
}

export async function devtoolsUrl(profile: string): Promise<string> {
  const file = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    try {
      const [port, path] = readFileSync(file, "utf8").split("\n");
      if (port && path) return `ws://127.0.0.1:${port.trim()}${path.trim()}`;
    } catch {
      // Not written yet, or Chrome still has it open, which is EBUSY on Windows.
    }
    await Bun.sleep(100);
  }
  throw new Error("Chrome never opened its DevTools port");
}

interface Pending {
  url: string;
  type: string;
  method: string;
  status: number | null;
  mime: string | null;
}

/** Load one page, once, and report what it fetched. Nothing is retried. */
export async function discoverPage(page: string, names: string[]): Promise<Discovery> {
  const surnames = expectedSurnames(names);
  const profile = mkdtempSync(join(tmpdir(), "openslate-discover-"));
  const chrome = Bun.spawn(
    [
      findChrome(),
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--user-agent=${USER_AGENT}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  const result: Discovery = {
    page,
    final_url: null,
    loaded_at: new Date().toISOString(),
    error: null,
    expected: surnames.length,
    document_hits: 0,
    rendered_hits: 0,
    frames: [],
    requests: 0,
    data_requests: [],
    proposals: [],
    unread_documents: [],
  };

  try {
    const cdp = await Cdp.connect(await devtoolsUrl(profile));
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const call = (method: string, params: object = {}) => cdp.send(method, params, sessionId);

    const pending = new Map<string, Pending>();
    const seen: Seen[] = [];
    const reads: Promise<void>[] = [];
    let lastActivity = Date.now();
    let inFlight = 0;

    cdp.on((method, params, session) => {
      if (session !== sessionId) return;
      lastActivity = Date.now();
      if (method === "Network.requestWillBeSent") {
        if (!pending.has(params.requestId)) inFlight++;
        result.requests++;
        pending.set(params.requestId, {
          url: params.request.url,
          type: params.type ?? "Other",
          method: params.request.method,
          status: null,
          mime: null,
        });
      } else if (method === "Network.responseReceived") {
        const request = pending.get(params.requestId);
        if (!request) return;
        request.status = params.response.status;
        request.mime = params.response.mimeType ?? null;
        request.url = params.response.url;
      } else if (method === "Network.loadingFailed") {
        if (pending.delete(params.requestId)) inFlight--;
      } else if (method === "Network.loadingFinished") {
        const request = pending.get(params.requestId);
        if (!request) return;
        pending.delete(params.requestId);
        reads.push(
          call("Network.getResponseBody", { requestId: params.requestId })
            .then(({ body, base64Encoded }) => {
              const text = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
              const textual = /json|html|text|xml|javascript/i.test(request.mime ?? "");
              seen.push({
                ...request,
                bytes: Number(params.encodedDataLength) || 0,
                hits: textual ? countHits(text, surnames) : 0,
              });
            })
            .catch(() => {
              seen.push({ ...request, bytes: 0, hits: 0 });
            })
            .finally(() => {
              inFlight--;
            }),
        );
      }
    });

    await call("Network.enable", { maxResourceBufferSize: 64_000_000 });
    await call("Network.setCacheDisabled", { cacheDisabled: true });
    await call("Network.setBlockedURLs", { urls: BLOCKED });
    await call("Network.setUserAgentOverride", { userAgent: USER_AGENT });
    await call("Page.enable");

    const navigation = await call("Page.navigate", { url: page });
    if (navigation.errorText) result.error = navigation.errorText;

    const started = Date.now();
    while (Date.now() - started < LOAD_LIMIT_MS) {
      await Bun.sleep(250);
      if (Date.now() - started > QUIET_MS && Date.now() - lastActivity > QUIET_MS) break;
      if (inFlight <= 0 && Date.now() - lastActivity > QUIET_MS) break;
    }
    await Promise.allSettled(reads);

    const evaluate = async (expression: string) =>
      (await call("Runtime.evaluate", { expression, returnByValue: true })).result?.value;
    result.final_url = (await evaluate("location.href")) ?? null;
    result.rendered_hits = countHits((await evaluate("document.body?.innerText ?? ''")) ?? "", surnames);
    result.frames = (await evaluate("[...document.querySelectorAll('iframe')].map(f => f.src)")) ?? [];

    const main = seen.find(({ url }) => url.split("#")[0] === page.split("#")[0]);
    result.document_hits = main?.hits ?? 0;
    result.data_requests = distinct(seen)
      .filter(({ type }) => type === "XHR" || type === "Fetch")
      .sort((a, b) => b.hits - a.hits || a.url.localeCompare(b.url));
    result.proposals = propose(page, seen, surnames.length);
    result.unread_documents = unreadDocuments(seen);
    // The process we spawned isn't the browser on Windows: it hands off and exits, so only asking
    // the browser itself to quit reaches it and its helpers.
    await Promise.race([cdp.send("Browser.close").catch(() => {}), Bun.sleep(3000)]);
    cdp.close();
  } catch (error) {
    result.error = (error as Error).message;
  } finally {
    chrome.kill();
    await chrome.exited;
    // Helpers take a few seconds to let go of the profile.
    for (let attempt = 0; attempt < 100 && existsSync(profile); attempt++) {
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        await Bun.sleep(300);
      }
    }
  }
  return result;
}

/** The names a page should hold: the choices of every position citing it. */
export function namesCiting(checkout: string, url: string) {
  const names = new Set<string>();
  const citedBy = new Set<string>();
  const orgs = join(checkout, "orgs");
  for (const org of readdirSync(orgs)) {
    if (!statSync(join(orgs, org)).isDirectory()) continue;
    for (const election of readdirSync(join(orgs, org))) {
      const file = join(orgs, org, election, "positions.json");
      if (!existsSync(file)) continue;
      const bundle = JSON.parse(readFileSync(file, "utf8"));
      const positions = (bundle.positions ?? []).filter(
        (position: { source?: string }) => position.source === url,
      );
      if (!positions.length && !bundle.attribution?.sources?.includes(url)) continue;
      citedBy.add(`${org}/${election}`);
      for (const { choice } of positions) if (typeof choice === "string") names.add(choice);
    }
  }
  return { names: [...names], cited_by: [...citedBy].sort() };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const take = (flag: string) => {
    const at = args.indexOf(flag);
    return at < 0 ? undefined : args.splice(at, 2)[1];
  };
  const checkout = take("--from");
  const given = take("--names");
  const outFile = take("--out");
  if (!args.length || (!checkout && !given)) {
    throw new Error("usage: discover.ts (--from <checkout> | --names a,b) <url>... [--out <file>]");
  }

  const reports: (Discovery & { cited_by: string[] })[] = [];
  for (const url of args) {
    const { names, cited_by } = checkout
      ? namesCiting(checkout, url)
      : { names: (given as string).split(","), cited_by: [] };
    const report = await discoverPage(url, names);
    reports.push({ ...report, cited_by });
    console.log(
      `${url}: ${report.error ?? "loaded"}, ${report.expected} names, document ` +
        `${report.document_hits}, rendered ${report.rendered_hits}, ${report.requests} requests, ` +
        `${report.data_requests.length} XHR/fetch, ${report.proposals.length} proposals, ` +
        `${report.unread_documents.length} PDFs unread`,
    );
    for (const { url: found, type, method, hits, share, same_site } of report.proposals) {
      console.log(
        `  ${Math.round(share * 100)}% (${hits}) ${method} ${type} ` +
          `${same_site ? "same-site" : "other site"} ${found}`,
      );
    }
    await Bun.sleep(1500);
  }
  if (outFile) await Bun.write(outFile, `${JSON.stringify(reports, null, 1)}\n`);
}
