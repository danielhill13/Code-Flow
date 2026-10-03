/**
 * A stretch of time, from `start` (inclusive) to `end` (exclusive). Both are ISO 8601 in UTC: a
 * day (YYYY-MM-DD, meaning its midnight) or an instant to the second (YYYY-MM-DDTHH:MM:SSZ, the
 * form GitHub's timestamps take). Either form compares correctly with a timestamp as a string.
 */
export type Span = {
  start: string;
  end: string;
  /** How the span reads: "September 2026", "last 30 days", "week of Sep 7". */
  label: string;
};

/** Calendar periods in UTC. */
export type PeriodKind = "month" | "quarter" | "year";

export type Period = Span & {
  kind: PeriodKind;
  /** "September 2026", "Q3 2026", "2026". */
  label: string;
  /** First day, YYYY-MM-DD. */
  start: string;
  /** The day after the last, YYYY-MM-DD. */
  end: string;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Reads "2026-09", "2026-Q3" or "2026"; returns null for anything else. */
export function parsePeriod(text: string): Period | null {
  const month = /^(\d{4})-(\d{2})$/.exec(text);
  if (month) {
    const m = Number(month[2]);
    return m >= 1 && m <= 12 ? periodOf("month", Number(month[1]), m - 1) : null;
  }
  const quarter = /^(\d{4})-?Q([1-4])$/i.exec(text);
  if (quarter) return periodOf("quarter", Number(quarter[1]), (Number(quarter[2]) - 1) * 3);
  const year = /^(\d{4})$/.exec(text);
  if (year) return periodOf("year", Number(year[1]), 0);
  return null;
}

/** The period of this kind that contains `date`. */
export function periodContaining(kind: PeriodKind, date: Date): Period {
  const month = date.getUTCMonth();
  const first = kind === "month" ? month : kind === "quarter" ? month - (month % 3) : 0;
  return periodOf(kind, date.getUTCFullYear(), first);
}

/** The most recent period of this kind that had ended by `asOf`. */
export function lastCompletePeriod(kind: PeriodKind, asOf: Date): Period {
  const current = periodContaining(kind, asOf);
  return periodContaining(kind, new Date(Date.parse(current.start) - 1));
}

/** The period of the same kind just before this one. */
export function previousPeriod(period: Period): Period {
  return periodContaining(period.kind, new Date(Date.parse(period.start) - 1));
}

/** `count` periods of the same kind ending with `last`, oldest first. */
export function periodsEnding(last: Period, count: number): Period[] {
  const periods = [last];
  while (periods.length < count) periods.unshift(previousPeriod(periods[0] as Period));
  return periods;
}

/**
 * Every period of a kind that starts on or after `from` (YYYY-MM-DD) and has begun by `asOf`,
 * newest first. The newest may still be running.
 */
export function periodsCovered(kind: PeriodKind, from: string, asOf: Date): Period[] {
  const periods: Period[] = [];
  for (
    let period = periodContaining(kind, asOf);
    period.start >= from;
    period = previousPeriod(period)
  ) {
    periods.push(period);
  }
  return periods;
}

/** A stable key for URLs and lookups: "2026-09", "2026-Q3", "2026". */
export function periodKey(period: Period): string {
  const [year, month] = period.start.split("-");
  if (period.kind === "year") return year ?? "";
  if (period.kind === "quarter") return `${year}-Q${(Number(month) - 1) / 3 + 1}`;
  return `${year}-${month}`;
}

/** Whether an ISO timestamp falls inside the span. Null never does. */
export function inPeriod(span: Pick<Span, "start" | "end">, iso: string | null): boolean {
  return iso !== null && iso >= span.start && iso < span.end;
}

/** Whether the span had ended by `asOf`, so its counts can't grow any more. */
export function isComplete(span: Pick<Span, "end">, asOf: Date): boolean {
  return instant(asOf) >= span.end;
}

/** An instant as a span boundary: ISO 8601 to the second, like GitHub's timestamps. */
export const instant = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

function periodOf(kind: PeriodKind, year: number, firstMonth: number): Period {
  const months = kind === "month" ? 1 : kind === "quarter" ? 3 : 12;
  const start = new Date(Date.UTC(year, firstMonth, 1));
  const end = new Date(Date.UTC(year, firstMonth + months, 1));
  const label =
    kind === "month"
      ? `${MONTHS[firstMonth]} ${year}`
      : kind === "quarter"
        ? `Q${firstMonth / 3 + 1} ${year}`
        : String(year);
  return { kind, label, start: day(start), end: day(end) };
}

const day = (date: Date) => date.toISOString().slice(0, 10);
