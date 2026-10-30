export const LOCAL_ZONE = "America/Los_Angeles";

/** "2026-10-30 3:11 AM PDT (10:11Z)": local first, UTC beside it. */
export function localFirst(iso: string): string {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LOCAL_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const zulu = date.toISOString().slice(11, 16);
  return (
    `${part("year")}-${part("month")}-${part("day")} ` +
    `${part("hour")}:${part("minute")} ${part("dayPeriod")} ${part("timeZoneName")} (${zulu}Z)`
  );
}
