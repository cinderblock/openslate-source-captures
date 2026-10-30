import { describe, expect, test } from "bun:test";
import { parseResponse } from "./capture";
import type { Manifest } from "./manifest";
import { hostFact } from "./provenance";
import { classify } from "./publish";
import { bodyText, isThinHtml, responseText, THIN_CHARACTERS } from "./readable";
import { rebuildResponse } from "./render";
import { withoutFragment } from "./run";
import { buildSources, type SourceList } from "./sources";

const http = (body: string, extra = "") =>
  Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n${extra}\r\n${body}`);

describe("buildSources", () => {
  const bundles = [
    {
      id: "a-paper/2026-11-03",
      bundle: {
        attribution: { of: { kind: "news_organization" }, sources: ["https://www.paper.com/list"] },
        positions: [{ source: "https://www.paper.com/list" }],
      },
    },
    {
      id: "a-club/2026-11-03",
      bundle: {
        attribution: { of: { kind: "organization" }, sources: ["https://club.org/x"] },
        positions: [{ source: "https://club.org/x" }, { source: "https://paper.com/other" }],
      },
    },
  ];

  test("withholds every URL on a host a news bundle cites, whoever else cites it", () => {
    const sources = buildSources(bundles, []);
    expect(sources.map(({ url, publish }) => [url, publish])).toEqual([
      ["https://club.org/x", "public"],
      ["https://paper.com/other", "withheld"],
      ["https://www.paper.com/list", "withheld"],
    ]);
  });

  test("the extra list withholds a host the kind rule can't see", () => {
    const [club] = buildSources(bundles, [], ["club.org"]);
    expect(club?.publish).toBe("withheld");
  });

  test("the same input gives the same bytes", () => {
    expect(JSON.stringify(buildSources(bundles, []))).toBe(
      JSON.stringify(buildSources([...bundles].reverse(), [])),
    );
  });

  test("a discovered URL says it was discovered, and why", () => {
    const sources = buildSources(bundles, [
      {
        url: "https://club.org/data.json",
        found_behind: "https://club.org/x",
        cited_by: ["a-club/2026-11-03"],
        note: "The picks.",
      },
    ]);
    const found = sources.find(({ url }) => url.endsWith("data.json"));
    expect(found?.origin).toBe("discovered");
    expect(found?.note).toContain("https://club.org/x");
  });
});

describe("classify", () => {
  const list: SourceList = {
    format: "openslate-source-list/1",
    generated_from: { repository: "", commit: "" },
    sources: [
      { url: "https://news/a", cited_by: [], positions: 0, publish: "withheld", origin: "cited" },
      { url: "https://org/b", cited_by: [], positions: 0, publish: "public", origin: "cited" },
    ],
  };
  const hop = (hash: string) => ({ response_sha256: hash }) as Manifest["captures"][0]["hops"][0];
  const manifest = {
    captures: [
      { intended: "https://news/a", hops: [hop("n1"), hop("n2")] },
      { intended: "https://org/b", hops: [hop("o1")] },
    ],
  } as Manifest;
  const bytes: Record<string, Buffer> = {
    n1: http("news"),
    n2: http("news"),
    o1: http("blocked: your address is 203.0.113.9"),
  };

  test("a withheld URL's redirects are withheld too", () => {
    const { withheld, guarded } = classify(manifest, list, (hash) => bytes[hash] as Buffer, []);
    expect([...withheld]).toEqual(["n1", "n2"]);
    expect(guarded.size).toBe(0);
  });

  test("a page printing the capturer's address stays private", () => {
    const { guarded } = classify(manifest, list, (hash) => bytes[hash] as Buffer, ["203.0.113.9"]);
    expect([...guarded]).toEqual(["o1"]);
  });
});

describe("hostFact", () => {
  test("names each relationship without judging it", () => {
    expect(hostFact("https://www.club.org/x", "https://club.org").match).toBe("exact");
    expect(hostFact("https://sf.club.org/x", "https://club.org").match).toBe("subdomain");
    expect(hostFact("https://docs.google.com/x", "https://club.org").match).toBe("hosted-elsewhere");
    expect(hostFact("https://docs.google.com/x", null).match).toBe("unknown");
    expect(hostFact("not a url", "https://club.org").match).toBe("unknown");
  });
});

describe("rebuildResponse", () => {
  test("keeps wire headers visible but out of the way of a decoded body", () => {
    const raw = rebuildResponse(
      200,
      "OK",
      { "content-encoding": "gzip", "content-type": "text/html" },
      Buffer.from("<p>hi</p>"),
    );
    const parsed = parseResponse(raw);
    expect(parsed.status).toBe(200);
    expect(parsed.wire_body.toString()).toBe("<p>hi</p>");
    expect(parsed.headers).toContainEqual(["x-chrome-original-content-encoding", "gzip"]);
    expect(parsed.headers.find(([name]) => name === "content-encoding")).toBeUndefined();
  });
});

test("a fragment never reaches the server", () => {
  expect(withoutFragment("https://a.org/x.pdf#page=57")).toBe("https://a.org/x.pdf");
  expect(withoutFragment("https://a.org/x?y=1")).toBe("https://a.org/x?y=1");
});

describe("isThinHtml", () => {
  const page = (text: string) => http(`<html><body><p>${text}</p></body></html>`);

  test("a challenge page is thin, a real page isn't", async () => {
    expect(await isThinHtml(page("a required part of this site could not load"))).toBe(true);
    expect(await isThinHtml(page("word ".repeat(THIN_CHARACTERS)))).toBe(false);
  });

  test("only HTML that answered 200 counts", async () => {
    const pdf = Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\n\r\n%PDF-");
    const gone = Buffer.from("HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\n\r\ngone");
    expect(await isThinHtml(pdf)).toBe(false);
    expect(await isThinHtml(gone)).toBe(false);
  });
});

describe("reading stored bytes", () => {
  test("HTML becomes comparable text", async () => {
    expect(await responseText(http("<p>Vote&nbsp;<b>Yes</b> on A!</p>"))).toEqual({
      text: "vote yes on a",
    });
  });

  test("an image has no text, and says so", async () => {
    expect(await bodyText(Buffer.from([1, 2, 3]), "image/png")).toEqual({ reason: "image" });
  });

  test("a broken stream reports why instead of throwing", async () => {
    const result = await responseText(http("not gzip", "Content-Encoding: gzip\r\n"));
    expect(result).toHaveProperty("reason");
  });
});
