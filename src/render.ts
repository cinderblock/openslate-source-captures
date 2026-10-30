// For a page a plain GET can't see: load it once in headless Chrome and keep what the browser got.
// This sits beside the socket capture, never instead of it, and is recorded as what it is. Chrome
// has already decoded the body, so these aren't socket bytes, and the DOM is what scripts built.
// Same honest user agent as a plain GET, and nothing here hides that it's automated.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BLOCKED, Cdp, devtoolsUrl, findChrome, LOAD_LIMIT_MS, QUIET_MS } from "./discover";
import { putBlob } from "./manifest";
import { USER_AGENT } from "./user-agent";

export interface Rendered {
  method: "headless-chrome";
  chrome_version: string;
  url: string;
  started_at: string;
  ended_at: string;
  final_url: string | null;
  status: number | null;
  error: string | null;
  /** Status line, headers and body as Chrome reported them: rebuilt, not socket bytes. */
  document_sha256: string | null;
  document_bytes: number;
  /** document.documentElement.outerHTML once the page went quiet. */
  dom_sha256: string | null;
  dom_bytes: number;
}

const CALL_LIMIT_MS = 30_000;

interface Head {
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

const DROPPED_HEADERS = new Set(["content-encoding", "transfer-encoding", "content-length"]);

/** Pure: headers Chrome reports describe the wire, and this body is already decoded. */
export function rebuildResponse(
  status: number,
  statusText: string,
  headers: Record<string, string>,
  body: Buffer,
): Buffer {
  const lines = Object.entries(headers).map(([name, value]) =>
    DROPPED_HEADERS.has(name.toLowerCase())
      ? `x-chrome-original-${name}: ${value}`
      : `${name}: ${value}`,
  );
  return Buffer.concat([
    Buffer.from(`HTTP/1.1 ${status} ${statusText}\r\n${lines.join("\r\n")}\r\n\r\n`, "latin1"),
    body,
  ]);
}

/** Load one page, once. Nothing is retried. */
export async function renderPage(url: string, blobs: string): Promise<Rendered> {
  const profile = mkdtempSync(join(tmpdir(), "openslate-render-"));
  const chrome = Bun.spawn(
    [
      findChrome(),
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      ...(process.env.GITHUB_ACTIONS ? ["--no-sandbox"] : []),
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--user-agent=${USER_AGENT}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  const result: Rendered = {
    method: "headless-chrome",
    chrome_version: "",
    url,
    started_at: new Date().toISOString(),
    ended_at: "",
    final_url: null,
    status: null,
    error: null,
    document_sha256: null,
    document_bytes: 0,
    dom_sha256: null,
    dom_bytes: 0,
  };

  let close: () => Promise<unknown> = async () => {};
  try {
    const cdp = await Cdp.connect(await devtoolsUrl(profile));
    result.chrome_version = (await cdp.send("Browser.getVersion")).product;
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    close = () => Promise.race([cdp.send("Browser.close").catch(() => {}), Bun.sleep(3000)]);
    const call = (method: string, params: object = {}) =>
      Promise.race([
        cdp.send(method, params, sessionId),
        Bun.sleep(CALL_LIMIT_MS).then(() => {
          throw new Error(`${method} timed out`);
        }),
      ]);

    // The last main-document response wins: a JS check reloads the page, and that's the real one.
    // Its body has to be read as it finishes, because Chrome drops it when the page moves on.
    const documents = new Map<string, { response: Head; read: Promise<void> | null }>();
    let final: { response: Head; body: Buffer } | null = null;
    let lastActivity = Date.now();
    cdp.on((method, params, session) => {
      if (session !== sessionId) return;
      lastActivity = Date.now();
      if (method === "Network.responseReceived" && params.type === "Document") {
        documents.set(params.requestId, { response: params.response, read: null });
      } else if (method === "Network.loadingFinished") {
        const document = documents.get(params.requestId);
        if (!document) return;
        document.read = call("Network.getResponseBody", { requestId: params.requestId })
          .then(({ body, base64Encoded }) => {
            const bytes = Buffer.from(body, base64Encoded ? "base64" : "utf8");
            final = { response: document.response, body: bytes };
          })
          .catch(() => {});
      }
    });

    await call("Network.enable", { maxResourceBufferSize: 64_000_000 });
    await call("Network.setCacheDisabled", { cacheDisabled: true });
    await call("Network.setBlockedURLs", { urls: BLOCKED });
    await call("Page.enable");
    const navigation = await call("Page.navigate", { url });
    if (navigation.errorText) result.error = navigation.errorText;

    const started = Date.now();
    while (Date.now() - started < LOAD_LIMIT_MS) {
      await Bun.sleep(250);
      if (Date.now() - started > QUIET_MS && Date.now() - lastActivity > QUIET_MS) break;
    }

    const evaluate = async (expression: string) =>
      (await call("Runtime.evaluate", { expression, returnByValue: true })).result?.value;
    result.final_url = (await evaluate("location.href")) ?? null;
    const dom = Buffer.from(String((await evaluate("document.documentElement.outerHTML")) ?? ""));
    result.dom_sha256 = putBlob(blobs, dom);
    result.dom_bytes = dom.length;

    await Promise.allSettled([...documents.values()].map(({ read }) => read));
    const document = final as { response: Head; body: Buffer } | null;
    if (document) {
      const { status, statusText, headers } = document.response;
      const rebuilt = rebuildResponse(status, statusText, headers, document.body);
      result.status = status;
      result.document_sha256 = putBlob(blobs, rebuilt);
      result.document_bytes = rebuilt.length;
    }
  } catch (error) {
    result.error = (error as Error).message;
  } finally {
    // Always, or a failed page leaves a browser running and holds this process open.
    await close();
    chrome.kill();
    await Promise.race([chrome.exited, Bun.sleep(5000)]);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await Bun.sleep(300);
      }
    }
  }
  result.ended_at = new Date().toISOString();
  return result;
}
