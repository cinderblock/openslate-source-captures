import { describe, expect, test } from "bun:test";
import {
  countHits,
  expectedSurnames,
  propose,
  type Seen,
  siteOf,
  surnameOf,
  unreadDocuments,
} from "./discover";

const response = (over: Partial<Seen>): Seen => ({
  url: "https://example.org/api/picks.json",
  type: "XHR",
  method: "GET",
  status: 200,
  mime: "application/json",
  bytes: 100,
  hits: 0,
  ...over,
});

describe("surnameOf", () => {
  test("takes the last word of a name", () => {
    expect(surnameOf("Xavier Becerra")).toBe("becerra");
  });

  test("ignores suffixes, nicknames and accents", () => {
    expect(surnameOf("Donald P. (Don) Wagner Jr.")).toBe("wagner");
    expect(surnameOf("José Núñez")).toBe("nunez");
  });

  test("a measure's stance isn't a name", () => {
    expect(surnameOf("Yes")).toBeNull();
    expect(surnameOf("No")).toBeNull();
  });
});

test("expectedSurnames counts a repeated surname once", () => {
  expect(expectedSurnames(["Ann Lee", "Bob Lee", "Cy Ruiz", "Yes"])).toEqual(["lee", "ruiz"]);
});

describe("countHits", () => {
  test("matches whole words, so a short name isn't found inside another", () => {
    expect(countHits("Sleep well, Mr. Leeds", ["lee"])).toBe(0);
    expect(countHits('{"name":"LEE, ANN"}', ["lee"])).toBe(1);
  });

  test("finds names inside JSON, across punctuation and accents", () => {
    expect(countHits('[{"n":"Núñez"},{"n":"O-Brien"}]', ["nunez", "brien"])).toBe(2);
  });
});

test("siteOf treats subdomains as the same site", () => {
  expect(siteOf("https://api.example.org/x")).toBe("example.org");
  expect(siteOf("https://www.example.org/")).toBe("example.org");
});

describe("propose", () => {
  const page = "https://example.org/picks";

  test("keeps responses with at least half the names, best first", () => {
    const found = propose(
      page,
      [
        response({ url: "https://example.org/a.json", hits: 5 }),
        response({ url: "https://cdn.other.net/b.json", hits: 10 }),
        response({ url: "https://example.org/c.json", hits: 4 }),
      ],
      10,
    );
    expect(found.map(({ url }) => url)).toEqual([
      "https://cdn.other.net/b.json",
      "https://example.org/a.json",
    ]);
    expect(found[0]?.same_site).toBe(false);
    expect(found[1]?.same_site).toBe(true);
    expect(found[1]?.share).toBe(0.5);
  });

  test("the page itself isn't a discovery", () => {
    expect(propose(page, [response({ url: `${page}#top`, hits: 10 })], 10)).toEqual([]);
  });

  test("flags a POST, which capture can't do today", () => {
    expect(propose(page, [response({ method: "POST", hits: 10 })], 10)[0]?.needs_post).toBe(true);
  });

  test("lists a URL fetched twice once", () => {
    expect(propose(page, [response({ hits: 10 }), response({ hits: 10 })], 10)).toHaveLength(1);
  });

  test("proposes nothing when no names were expected", () => {
    expect(propose(page, [response({ hits: 0 })], 0)).toEqual([]);
  });
});

test("a PDF is listed as unread, not scored as empty", () => {
  const pdf = response({ url: "https://example.org/guide", mime: "application/pdf" });
  expect(unreadDocuments([pdf, response({})])).toEqual([pdf]);
});
