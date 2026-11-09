import { describe, expect, test } from "bun:test";
import { kindOf, recurringFailures, report, type RunOutcomes } from "./failing";
import type { Manifest, ManifestHop } from "./manifest";

const capture = (intended: string, status: number | null, tries = 1): Manifest["captures"][number] => {
  const hops = [{ status, error: status === null ? "timeout: no data" : null } as ManifestHop];
  return tries > 1 ? { intended, earlier_attempts: Array.from({ length: tries - 1 }, () => hops), hops } : { intended, hops };
};

const run = (run_id: string, statuses: Record<string, number | null>, witnessed = true): RunOutcomes => ({
  run_id,
  witnessed,
  captures: Object.entries(statuses).map(([url, status]) => capture(url, status)),
});

const A = "https://a.org/x";
const B = "https://b.org/y";

describe("recurringFailures", () => {
  test("lists a URL failing in the newest run and in 3 of the last 4", () => {
    const runs = [
      run("2026-11-01T1000Z", { [A]: 200, [B]: 403 }),
      run("2026-11-02T1000Z", { [A]: 200, [B]: 403 }),
      run("2026-11-03T1000Z", { [A]: 503, [B]: 403 }),
      run("2026-11-04T1000Z", { [A]: 200, [B]: 200 }),
      run("2026-11-05T1000Z", { [A]: 503, [B]: 200 }),
    ];
    expect(recurringFailures(runs)).toEqual([]);
    const later = [...runs, run("2026-11-06T1000Z", { [A]: 503, [B]: 403 })];
    expect(recurringFailures(later).map(({ url, kind }) => [url, kind])).toEqual([[A, "server-error"]]);
  });

  test("one that recovered in the newest run isn't listed", () => {
    const runs = ["01", "02", "03"].map((day) => run(`2026-11-${day}T1000Z`, { [A]: 403 }));
    expect(recurringFailures(runs)).toHaveLength(1);
    expect(recurringFailures([...runs, run("2026-11-04T1000Z", { [A]: 200 })])).toEqual([]);
  });

  test("home runs are context, never counted, and only one after the window starts", () => {
    const runs = [
      run("2026-10-20T1000Z", { [A]: 200 }, false),
      ...["01", "02", "03"].map((day) => run(`2026-11-${day}T1000Z`, { [A]: 403 })),
    ];
    expect(recurringFailures(runs)[0]?.home).toBeNull();
    const withHome = [...runs, run("2026-11-03T1100Z", { [A]: 200 }, false)];
    expect(recurringFailures(withHome)[0]?.home).toMatchObject({ run_id: "2026-11-03T1100Z", status: 200 });
  });
});

describe("kindOf", () => {
  test("sorts statuses into what a developer would check", () => {
    expect([null, 401, 403, 429, 202, 404, 410, 500, 520, 310].map((status) => kindOf({ status }))).toEqual([
      "no-response",
      "refused",
      "refused",
      "rate-limited",
      "not-the-page",
      "gone",
      "gone",
      "server-error",
      "server-error",
      "other",
    ]);
  });
});

describe("report", () => {
  const generated = new Date("2026-11-09T10:30:00Z");

  test("says when nothing is failing, which is what closes the issue", () => {
    expect(report([], generated)).toContain("\nNothing is failing repeatedly.");
  });

  test("puts URLs that work from home last, and shows retries", () => {
    const runs = [
      ...["01", "02", "03"].map((day) => ({
        run_id: `2026-11-${day}T1000Z`,
        witnessed: true,
        captures: [capture(A, null, 3), capture(B, 403)],
      })),
      run("2026-11-03T1100Z", { [B]: 200 }, false),
    ];
    const text = report(recurringFailures(runs), generated);
    expect(text).toContain("Updated 2026-11-09 2:30 AM PST (10:30Z)");
    expect(text.indexOf(A)).toBeLessThan(text.indexOf("## Refusing CI only"));
    expect(text.indexOf(B)).toBeGreaterThan(text.indexOf("## Refusing CI only"));
    expect(text).toContain("no response (timeout: no data) after 3 tries");
  });
});
