// From stored bytes to the text a statement is looked for in. Comparison only: this never changes
// what was captured, and it's pure, so anyone re-running it on the same bytes gets the same answer.

import { decodeBody, header, parseResponse } from "./capture";
import { comparable, htmlText } from "./text";

function jsonStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(jsonStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(jsonStrings);
  return [];
}

async function pdfText(body: Buffer): Promise<string> {
  // pdf.js is slow to load, and most runs that get here only need it for a few files.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await getDocument({
    data: new Uint8Array(body),
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  const pages: string[] = [];
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    for (const item of content.items) if ("str" in item) pages.push(item.str);
  }
  await document.loadingTask.destroy();
  return pages.join(" ");
}

/** Comparable text, or why there isn't any. Never throws on a strange file. */
export async function bodyText(
  body: Buffer,
  contentType: string,
): Promise<{ text: string } | { reason: string }> {
  const type = contentType.toLowerCase();
  try {
    if (type.includes("pdf") || body.subarray(0, 5).toString("latin1") === "%PDF-") {
      return { text: comparable(await pdfText(body)) };
    }
    if (/^(image|audio|video)\//.test(type)) return { reason: type.split("/")[0] as string };
    const text = body.toString("utf8");
    if (type.includes("json")) {
      try {
        return { text: comparable(htmlText(jsonStrings(JSON.parse(text)).join(" "))) };
      } catch {
        // Not the JSON it claimed to be: read it as text.
      }
    }
    return { text: comparable(htmlText(text)) };
  } catch (error) {
    return { reason: `unreadable: ${(error as Error).message.slice(0, 60)}` };
  }
}

/** Fewer readable characters than this, and an HTML page isn't the page: see isThinHtml. */
export const THIN_CHARACTERS = 500;

/**
 * Did a GET get almost no text from an HTML page? That's a stub, a bot check, or an app that loads
 * its content later. Mechanical on purpose: nobody decides which pages deserve a second look.
 */
export async function isThinHtml(raw: Buffer): Promise<boolean> {
  const parsed = parseResponse(raw);
  if (parsed.status !== 200 || !/html/i.test(header(parsed, "content-type") ?? "")) return false;
  const text = await responseText(raw);
  return "text" in text && text.text.length < THIN_CHARACTERS;
}

/** The same, from a stored response: raw socket bytes, framing and encoding included. */
export async function responseText(raw: Buffer) {
  const parsed = parseResponse(raw);
  try {
    return await bodyText(decodeBody(parsed), header(parsed, "content-type") ?? "");
  } catch (error) {
    return { reason: `unreadable: ${(error as Error).message.slice(0, 60)}` };
  }
}
