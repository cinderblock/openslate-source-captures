// Pure functions from raw HTML to comparable text. Comparison only: this never touches what was
// captured, and a verifier can re-run it on the same bytes and get the same answer.

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
};

/** Visible text: drop scripts, styles and tags, decode entities. */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (entity, name) => ENTITIES[name.toLowerCase()] ?? entity);
}

/** Lower case, no accents, no punctuation, single spaces: the form two texts are compared in. */
export function comparable(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export type Anchor = "exact" | "quoted-parts" | "unanchored";

/** Is a position's supporting text really in the source? Yes, or no, with no judgement call. */
export function anchorStatement(statement: string, source: string): Anchor {
  const haystack = ` ${source} `;
  if (haystack.includes(` ${comparable(statement)} `)) return "exact";
  const quoted = [...statement.matchAll(/["“]([^"”]+)["”]/g)].map((m) => comparable(m[1] ?? ""));
  if (quoted.length && quoted.every((part) => part && haystack.includes(` ${part} `))) {
    return "quoted-parts";
  }
  return "unanchored";
}
