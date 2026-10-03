/** Calendar periods in UTC. A period runs from `start` (inclusive) to `end` (exclusive). */
export type PeriodKind = "month" | "quarter" | "year";

export type Period = {
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

/** Whether an ISO timestamp falls inside the period. Null never does. */
export function inPeriod(period: Period, iso: string | null): boolean {
  return iso !== null && iso >= period.start && iso < period.end;
}

export function isComplete(period: Period, asOf: Date): boolean {
  return asOf.toISOString() >= period.end;
}

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
