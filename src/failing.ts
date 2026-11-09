#!/usr/bin/env bun
// Which sources keep failing? One bad run is weather, and the retries in src/retry.ts already ride
// most of that out. A URL that still fails in most recent CI runs needs a person: the site may be
// blocking us, may have moved or changed the address behind a page, or may just be overloaded. This
// lists those for a developer, mechanically, from the runs on disk. It says how a request went,
// never anything about what a page says.
//
//   bun src/failing.ts [out file]          (default failing-sources.md; prints how many it lists)

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "./manifest";
import { localFirst } from "./time";

/** How many recent CI runs are looked at, and how many of them must fail. */
export const WINDOW = 4;
export const THRESHOLD = 3;

export interface Outcome {
  run_id: string;
  status: number | null;
  error: string | null;
  attempts: number;
}

export interface Failing {
  url: string;
  host: string;
  /** Newest first, one per CI run in the window that set out to fetch this URL. */
  ci: Outcome[];
  /** The newest home run that tried it after the oldest CI run counted, if any. */
  home: Outcome | null;
  kind: Kind;
}

export type Kind = "refused" | "rate-limited" | "not-the-page" | "gone" | "server-error" | "no-response" | "other";

export const KIND_TEXT: Record<Kind, string> = {
  "no-response": "No response. The site may be down or overloaded, or dropping our connections.",
  refused: "Refused (401 or 403). The site may be blocking automated requests or this address range.",
  "rate-limited": "Rate limited (429). The site says we asked too often.",
  "not-the-page": "A success code that isn't the page (such as 202). Often a bot check.",
  gone: "Gone or moved (404 or 410). The slate may cite an address that no longer exists.",
  "server-error": "Server error (5xx). The site may be overloaded, or the address behind the page changed.",
  other: "Some other answer, such as a redirect loop.",
};

/** Pure: what kind of failure an outcome is. */
export function kindOf({ status }: Pick<Outcome, "status">): Kind {
  if (status === null) return "no-response";
  if (status === 401 || status === 403) return "refused";
  if (status === 429) return "rate-limited";
  if (status === 404 || status === 410) return "gone";
  if (status >= 500) return "server-error";
  if (status >= 200 && status < 300) return "not-the-page";
  return "other";
}

const outcomeOf = (run_id: string, capture: Manifest["captures"][number]): Outcome => {
  const last = capture.hops.at(-1);
  return {
    run_id,
    status: last?.status ?? null,
    error: last?.error ?? null,
    attempts: (capture.earlier_attempts?.length ?? 0) + 1,
  };
};

export interface RunOutcomes {
  run_id: string;
  witnessed: boolean;
  captures: Manifest["captures"];
}

/**
 * Pure: the URLs whose final outcome wasn't a 200 in the newest CI run that tried them and in at
 * least THRESHOLD of the last WINDOW. Sorted by host, then URL.
 */
export function recurringFailures(runs: RunOutcomes[]): Failing[] {
  const ci = runs.filter(({ witnessed }) => witnessed).sort((a, b) => b.run_id.localeCompare(a.run_id));
  const home = runs.filter(({ witnessed }) => !witnessed).sort((a, b) => b.run_id.localeCompare(a.run_id));
  const newest = ci[0];
  if (!newest) return [];
  const byUrl = (run: RunOutcomes) => new Map(run.captures.map((capture) => [capture.intended, capture]));
  const ciMaps = ci.map((run) => ({ run_id: run.run_id, urls: byUrl(run) }));
  const homeMaps = home.map((run) => ({ run_id: run.run_id, urls: byUrl(run) }));

  const failing: Failing[] = [];
  for (const { intended } of newest.captures) {
    const outcomes = ciMaps
      .filter(({ urls }) => urls.has(intended))
      .slice(0, WINDOW)
      .map(({ run_id, urls }) => outcomeOf(run_id, urls.get(intended) as Manifest["captures"][number]));
    const [latest] = outcomes;
    if (!latest || latest.status === 200) continue;
    if (outcomes.filter(({ status }) => status !== 200).length < THRESHOLD) continue;
    const oldest = outcomes.at(-1)?.run_id ?? "";
    const tried = homeMaps.find(({ run_id, urls }) => run_id > oldest && urls.has(intended));
    failing.push({
      url: intended,
      host: URL.canParse(intended) ? new URL(intended).hostname.toLowerCase() : "(unparseable)",
      ci: outcomes,
      home: tried ? outcomeOf(tried.run_id, tried.urls.get(intended) as Manifest["captures"][number]) : null,
      kind: kindOf(latest),
    });
  }
  return failing.sort((a, b) => a.host.localeCompare(b.host) || a.url.localeCompare(b.url));
}

const show = ({ status, error, attempts }: Outcome) =>
  (status === null ? `no response (${error ?? "no error recorded"})` : String(status)) +
  (attempts > 1 ? ` after ${attempts} tries` : "");

/** Pure: the report. A URL that works from home is only refusing CI, which a home run can fill in. */
export function report(failing: Failing[], generated: Date): string {
  // The CI runs most rows were counted over, newest first. A row counted over others says which.
  const counted = [...new Set(failing.flatMap(({ ci }) => ci.map(({ run_id }) => run_id)))]
    .sort()
    .reverse()
    .slice(0, WINDOW);
  const lines = [
    "# Sources that keep failing",
    "",
    `Written by \`src/failing.ts\` after each CI run. Updated ${localFirst(generated.toISOString())}.`,
    "",
    `A URL is listed when its final outcome, after the retries in \`src/retry.ts\`, wasn't a 200 in`,
    `the newest CI run and in at least ${THRESHOLD} of the last ${WINDOW}. Each is something for a`,
    "developer to look into. This says how the requests went, never anything about a page's content.",
    "",
  ];
  if (!failing.length) return [...lines, "Nothing is failing repeatedly.", ""].join("\n");
  lines.push(`CI runs counted, newest first: ${counted.map((id) => `\`${id}\``).join(", ")}.`, "");
  const cell = (ci: Outcome[]) =>
    ci.map(({ run_id }) => run_id).join() === counted.join()
      ? ci.map(show).join(", ")
      : ci.map((outcome) => `${outcome.run_id}: ${show(outcome)}`).join("<br>");
  const homeOk = failing.filter(({ home }) => home?.status === 200);
  const needsLook = failing.filter(({ home }) => home?.status !== 200);
  const section = (title: string, intro: string, items: Failing[]) => {
    if (!items.length) return;
    lines.push(`## ${title}`, "", intro, "");
    for (const kind of Object.keys(KIND_TEXT) as Kind[]) {
      const ofKind = items.filter((item) => item.kind === kind);
      if (!ofKind.length) continue;
      lines.push(`### ${KIND_TEXT[kind]}`, "", "| URL | CI, newest first | From home |", "| --- | --- | --- |");
      for (const { url, ci, home } of ofKind) {
        const runs = cell(ci);
        const fromHome = home ? `${home.run_id}: ${show(home)}` : "not tried";
        lines.push(`| ${url.replaceAll("|", "%7C")} | ${runs} | ${fromHome} |`);
      }
      lines.push("");
    }
  };
  section(
    "Needs a look",
    `${needsLook.length} URL${needsLook.length === 1 ? "" : "s"} failing from CI, and from home too or not tried there.`,
    needsLook,
  );
  section(
    "Refusing CI only",
    `${homeOk.length} URL${homeOk.length === 1 ? "" : "s"} that came back 200 from home. Lower priority: they refuse only CI, and a home run of \`src/fill-in.ts\` can fill them in.`,
    homeOk,
  );
  return lines.join("\n");
}

if (import.meta.main) {
  const out = process.argv[2] ?? "failing-sources.md";
  const ids = readdirSync("runs").sort();
  // Only as many runs as the window needs, so this stays quick as runs/ grows.
  const witnessed = ids.filter((id) => existsSync(join("runs", id, "manifest.sigstore.json")));
  const ciIds = witnessed.slice(-WINDOW);
  const oldest = ciIds[0] ?? "";
  const homeIds = ids.filter((id) => id > oldest && !witnessed.includes(id));
  const load = (run_id: string, isWitnessed: boolean): RunOutcomes => ({
    run_id,
    witnessed: isWitnessed,
    captures: (JSON.parse(readFileSync(join("runs", run_id, "manifest.json"), "utf8")) as Manifest).captures,
  });
  const failing = recurringFailures([
    ...ciIds.map((id) => load(id, true)),
    ...homeIds.map((id) => load(id, false)),
  ]);
  writeFileSync(out, report(failing, new Date()));
  console.log(failing.length);
}
