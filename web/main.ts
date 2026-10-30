// The browser verifier's page. All of the checking is src/verify-core.ts, the same code the CLI
// runs; this file only fetches or reads bytes and shows the result. Nothing from a run is ever
// treated as HTML or as a link: a capture is someone else's bytes.

import sigstoreRoot from "../trust/sigstore-trusted-root.json";
import tsaRoots from "../trust/tsa-roots.json";
import type { RunInput, RunReport, Trust, UrlFacts } from "../src/verify-core";
import { verifyRun } from "../src/verify-core";
import { type FolderIndex, type FoundFile, fromFolder, fromMirror, indexFolder } from "./load";

const REPOSITORY = "cinderblock/openslate-source-captures";
const DEFAULT_BASE = `https://raw.githubusercontent.com/${REPOSITORY}/master/`;

const trust: Trust = {
  tsaRootsDer: tsaRoots.certificates.map(({ der_base64 }) =>
    Uint8Array.from(atob(der_base64), (c) => c.charCodeAt(0)),
  ),
  sigstore: sigstoreRoot as unknown as Trust["sigstore"],
};

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type Child = Node | string | null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  for (const child of children) if (child !== null) node.append(child);
  return node;
}

/** The viewer's local time first, UTC beside it in smaller text. */
function timeNode(iso: string): HTMLElement {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const local =
    `${part("year")}-${part("month")}-${part("day")} ` +
    `${part("hour")}:${part("minute")} ${part("dayPeriod")} ${part("timeZoneName")}`;
  return el(
    "span",
    {},
    el("time", { datetime: iso }, local),
    " ",
    el("small", {}, `(${iso.slice(11, 16)}Z)`),
  );
}

const say = (message: string) => {
  byId("status").textContent = message;
};

// --- Showing a report ----------------------------------------------------------------------------

const describe = (status: number | null, error: string | null) =>
  status === null ? (error ?? "no response") : String(status);

const BYTES_LABEL: Record<UrlFacts["bytes"], string> = {
  present: "Here",
  withheld: "Elsewhere",
  missing: "Missing",
};

function renderRows(report: RunReport) {
  const needle = byId<HTMLInputElement>("filter-text").value.trim().toLowerCase();
  const status = byId<HTMLSelectElement>("filter-status").value;
  const bytes = byId<HTMLSelectElement>("filter-bytes").value;
  const rows = report.urls.filter((url) => {
    if (needle && !`${url.url} ${url.response_sha256}`.toLowerCase().includes(needle)) return false;
    if (bytes !== "all" && url.bytes !== bytes) return false;
    if (status === "200") return url.status === 200;
    if (status === "other") return url.status !== null && url.status !== 200;
    if (status === "none") return url.status === null;
    return true;
  });
  byId("urls").replaceChildren(
    ...rows.map((url) =>
      el(
        "tr",
        {},
        el("td", {}, el("code", {}, url.url)),
        el("td", {}, describe(url.status, url.error)),
        el("td", {}, BYTES_LABEL[url.bytes]),
        el("td", {}, el("code", { class: "hash" }, url.response_sha256)),
      ),
    ),
  );
  byId("url-count").textContent = `Showing ${rows.length} of ${report.urls.length} URLs.`;
}

function witnessNodes(report: RunReport): Node[] {
  if (!report.witness) {
    return [el("p", { id: "witness-state" }, `Not witnessed: ${report.witness_failure}`)];
  }
  const { identity, log_index, integrated_time } = report.witness;
  const row = (term: string, value: Node | string) => [el("dt", {}, term), el("dd", {}, value)];
  return [
    el("p", { id: "witness-state" }, "Witnessed by public CI."),
    el(
      "dl",
      {},
      ...row("Workflow", el("code", {}, identity.build_signer_uri)),
      ...row("Commit", el("code", {}, identity.source_repository_digest)),
      ...row("Runner", identity.runner_environment),
      ...row("Run", el("code", {}, identity.run_invocation_uri)),
      ...row("Log index", log_index),
      ...row("Logged", timeNode(integrated_time)),
    ),
  ];
}

function renderReport(report: RunReport) {
  const failed = report.problems.length > 0 || report.stamp_failures.length > 0;
  const count = (test: (url: UrlFacts) => boolean) => report.urls.filter(test).length;

  byId("verdict").textContent = failed ? "This run failed verification" : "This run verified";
  byId("verdict").dataset.failed = String(failed);
  byId("run-id").textContent = report.run_id;
  byId("manifest-hash").textContent = report.manifest_sha256;
  byId("existed-by").replaceChildren(report.existed_by ? timeNode(report.existed_by) : "Not shown");

  byId("stamps").replaceChildren(
    ...report.stamps.map((stamp) =>
      el("li", {}, `${stamp.name}: `, timeNode(stamp.gen_time), `, root ${stamp.root}`),
    ),
    ...report.stamp_failures.map((failure) => el("li", {}, `Failed: ${failure}`)),
  );
  byId("witness").replaceChildren(...witnessNodes(report));

  byId("totals").textContent =
    `${report.urls.length} URLs: ${count((u) => u.status === 200)} returned 200, ` +
    `${count((u) => u.status !== null && u.status !== 200)} another status, ` +
    `${count((u) => u.status === null)} no response. Bytes: ` +
    `${count((u) => u.bytes === "present")} here, ` +
    `${count((u) => u.bytes === "withheld")} elsewhere, ` +
    `${count((u) => u.bytes === "missing")} missing.`;

  byId("problems-section").hidden = report.problems.length === 0;
  byId("problems").replaceChildren(...report.problems.map((problem) => el("li", {}, problem)));

  for (const id of ["filter-text", "filter-status", "filter-bytes"]) {
    byId(id).oninput = () => renderRows(report);
  }
  renderRows(report);
  byId("results").hidden = false;
  byId("verdict").focus();
}

async function verify(load: () => Promise<RunInput>) {
  byId("results").hidden = true;
  try {
    const input = await load();
    say("Checking signatures and hashes.");
    const report = await verifyRun(input);
    renderReport(report);
    say(report.problems.length ? "Verification finished with problems." : "Verification finished.");
  } catch (error) {
    say(`Couldn't verify: ${(error as Error).message}`);
  }
}

// --- From a mirror -------------------------------------------------------------------------------

async function listRuns() {
  // A convenience only: the page works without it, since a run id can be typed in.
  try {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/contents/runs`);
    if (!response.ok) return;
    const entries = (await response.json()) as { name: string }[];
    byId("run-list").replaceChildren(
      ...entries
        .map(({ name }) => name)
        .sort()
        .reverse()
        .map((name) => el("option", { value: name })),
    );
    const input = byId<HTMLInputElement>("run");
    if (!input.value) input.value = entries.at(-1)?.name ?? "";
  } catch {
    // Offline, or rate limited.
  }
}

byId<HTMLFormElement>("mirror-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const id = byId<HTMLInputElement>("run").value.trim();
  const given = byId<HTMLInputElement>("base").value.trim() || DEFAULT_BASE;
  const base = given.endsWith("/") ? given : `${given}/`;
  if (!id) {
    say("Enter a run id first.");
    return;
  }
  say(`Fetching run ${id}.`);
  void verify(() =>
    fromMirror(base, id, trust, (done, total) => {
      if (done % 25 === 0 || done === total) say(`Fetched ${done} of ${total} files.`);
    }),
  );
});

// --- From a folder -------------------------------------------------------------------------------

let folder: FolderIndex | null = null;

const verifyFolderRun = (dir: string) => {
  const index = folder;
  if (!index) return;
  say(`Reading ${dir || "the folder"}.`);
  void verify(() => fromFolder(index, dir, trust));
};

function useFolder(found: FoundFile[]) {
  folder = indexFolder(found);
  const { runs } = folder;
  const select = byId<HTMLSelectElement>("folder-run");
  select.replaceChildren(...runs.map((dir) => el("option", { value: dir }, dir || "(top level)")));
  byId("folder-run-row").hidden = runs.length < 2;
  if (!runs.length) {
    say("That folder has no manifest.json in it.");
    return;
  }
  verifyFolderRun(runs[0] as string);
}

const fromPicked = (file: File): FoundFile => ({
  path: file.webkitRelativePath || file.name,
  read: async () => new Uint8Array(await file.arrayBuffer()),
});

byId<HTMLInputElement>("folder").addEventListener("change", (event) => {
  const { files } = event.target as HTMLInputElement;
  if (files?.length) useFolder([...files].map(fromPicked));
});

byId<HTMLButtonElement>("folder-run-verify").addEventListener("click", () => {
  verifyFolderRun(byId<HTMLSelectElement>("folder-run").value);
});

/** Walk a dropped folder. A directory reader hands out its entries in batches. */
async function walk(entry: FileSystemEntry, found: FoundFile[]): Promise<void> {
  const path = entry.fullPath.replace(/^\//, "");
  if (entry.isFile) {
    found.push({
      path,
      read: () =>
        new Promise((resolve, reject) => {
          (entry as FileSystemFileEntry).file(
            (file) => file.arrayBuffer().then((bytes) => resolve(new Uint8Array(bytes)), reject),
            reject,
          );
        }),
    });
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (!batch.length) return;
    for (const child of batch) await walk(child, found);
  }
}

const zone = byId("drop-zone");
zone.addEventListener("dragover", (event) => {
  event.preventDefault();
  zone.dataset.over = "true";
});
zone.addEventListener("dragleave", () => {
  delete zone.dataset.over;
});
zone.addEventListener("drop", (event) => {
  event.preventDefault();
  delete zone.dataset.over;
  const entries = [...(event.dataTransfer?.items ?? [])]
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);
  void (async () => {
    const found: FoundFile[] = [];
    for (const entry of entries) await walk(entry, found);
    useFolder(found);
  })();
});

byId<HTMLInputElement>("base").placeholder = DEFAULT_BASE;
void listRuns();
