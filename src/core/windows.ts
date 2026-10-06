// The report's windows: rolling ones that look back from the moment the data was complete (30,
// 60 or 90 days), periods to date (month, quarter, year), and any one calendar month, quarter or
// year. Each compares with the span before it of the same kind, and a period still running with
// the same days of the one before, so a partial span is never set against a whole one (rule 7).
import { instant, type Span } from "./periods.ts";

/** The windows offered as quick choices. */
export type PresetKey = "30d" | "60d" | "90d" | "mtd" | "qtd" | "ytd";

/** A preset, or one calendar period: "2026-09" (a month), "2026-Q3" (a quarter), "2025" (a year). */
export type WindowKey = PresetKey | (string & {});

export const PRESET_KEYS: readonly PresetKey[] = ["30d", "60d", "90d", "mtd", "qtd", "ytd"];

/** @deprecated The quick choices; any calendar period is a window too (isWindowKey). */
export const WINDOW_KEYS = PRESET_KEYS;

const CALENDAR = /^(\d{4})(?:-(0[1-9]|1[0-2])|-Q([1-4]))?$/;

/** Whether text names a window: a preset, or a month, quarter or year. */
export function isWindowKey(text: string): text is WindowKey {
  return (PRESET_KEYS as readonly string[]).includes(text) || CALENDAR.test(text);
}

export type Window = {
  key: WindowKey;
  /** Ends when the data does. */
  current: Span;
  /** The same length just before; for year to date, the same span a year earlier. */
  previous: Span;
};

/** How trends inside a window are cut: Monday weeks, or calendar months. */
export type Grain = "week" | "month";

/** One point of a trend. The last one is usually still running, which `partial` says. */
export type Bucket = Span & {
  /** Short, for an axis: "Sep 7", "Sep". */
  short: string;
  /** Still running as of the data: drawn hollow, and its counts can still grow. */
  partial: boolean;
};

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = [
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

/**
 * A window switches to monthly points once it is longer than this: every quarter (at most 92
 * days) and the 90-day window stay weekly; a year, or a year to date past mid-April, is monthly.
 */
export const WEEKLY_YTD_LIMIT_DAYS = 14 * 7;

export function windowOf(key: WindowKey, asOf: Date): Window {
  const end = new Date(Math.floor(asOf.getTime() / 1000) * 1000);
  const y = end.getUTCFullYear();
  const m = end.getUTCMonth();
  if (key === "ytd")
    return toDate(key, Date.UTC(y, 0, 1), Date.UTC(y - 1, 0, 1), end, "year", `${y - 1}`);
  if (key === "mtd") {
    return toDate(key, Date.UTC(y, m, 1), Date.UTC(y, m - 1, 1), end, "month", monthName(y, m - 1));
  }
  if (key === "qtd") {
    const q = Math.floor(m / 3);
    return toDate(
      key,
      Date.UTC(y, q * 3, 1),
      Date.UTC(y, q * 3 - 3, 1),
      end,
      "quarter",
      quarterName(y, q - 1),
    );
  }
  const calendar = CALENDAR.exec(key);
  if (calendar) {
    const year = Number(calendar[1]);
    const [from, to, before, name, previousName] = calendar[2]
      ? (() => {
          const month = Number(calendar[2]) - 1;
          return [
            Date.UTC(year, month, 1),
            Date.UTC(year, month + 1, 1),
            Date.UTC(year, month - 1, 1),
            monthName(year, month),
            monthName(year, month - 1),
          ] as const;
        })()
      : calendar[3]
        ? (() => {
            const q = Number(calendar[3]) - 1;
            return [
              Date.UTC(year, q * 3, 1),
              Date.UTC(year, q * 3 + 3, 1),
              Date.UTC(year, q * 3 - 3, 1),
              quarterName(year, q),
              quarterName(year, q - 1),
            ] as const;
          })()
        : ([
            Date.UTC(year, 0, 1),
            Date.UTC(year + 1, 0, 1),
            Date.UTC(year - 1, 0, 1),
            `${year}`,
            `${year - 1}`,
          ] as const);
    // Still running: up to the data, against the same days of the period before.
    if (to > end.getTime()) {
      const ran = Math.max(0, end.getTime() - from);
      return {
        key,
        current: span(new Date(from), new Date(Math.max(from, end.getTime())), `${name} so far`),
        previous: span(
          new Date(before),
          new Date(before + ran),
          `the same days of ${previousName}`,
        ),
      };
    }
    return {
      key,
      current: span(new Date(from), new Date(to), name),
      previous: span(new Date(before), new Date(from), previousName),
    };
  }
  const days = Number.parseInt(key, 10);
  const start = new Date(end.getTime() - days * DAY_MS);
  return {
    key,
    current: span(start, end, `last ${days} days`),
    previous: span(new Date(start.getTime() - days * DAY_MS), start, `the previous ${days} days`),
  };
}

/** Weekly points, except for a window long enough (over 13 weeks) to read better by month. */
export function grainOf(window: Window): Grain {
  const length = Date.parse(window.current.end) - Date.parse(window.current.start);
  return length > WEEKLY_YTD_LIMIT_DAYS * DAY_MS ? "month" : "week";
}

/**
 * A period to date: from its start to the data, against the same days of the period before.
 * Ninety days into a quarter, the previous quarter's first ninety days; a month runs as far
 * into the month before as it can (March 31 to date, against February's whole).
 */
function toDate(
  key: WindowKey,
  start: number,
  before: number,
  end: Date,
  unit: "month" | "quarter" | "year",
  previousName: string,
): Window {
  const ran = end.getTime() - start;
  const previousEnd = Math.min(before + ran, start);
  return {
    key,
    current: span(new Date(start), end, `${unit} to date`),
    previous: span(new Date(before), new Date(previousEnd), `the same days of ${previousName}`),
  };
}

/** "September 2026"; a month before January is the previous year's December. */
export function monthName(year: number, month: number): string {
  const date = new Date(Date.UTC(year, month, 1));
  return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** "Q3 2026"; quarter is 0-based, and one before the first is the previous year's last. */
export function quarterName(year: number, quarter: number): string {
  const date = new Date(Date.UTC(year, quarter * 3, 1));
  return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`;
}

/**
 * The calendar periods to offer, newest first: months, quarters and years from the one holding
 * `from` (the first covered day) to the one holding the data's end.
 */
export function calendarChoices(
  from: string,
  asOf: Date,
): {
  months: { key: string; label: string }[];
  quarters: { key: string; label: string }[];
  years: { key: string; label: string }[];
} {
  const first = new Date(`${from.slice(0, 10)}T00:00:00Z`);
  const months: { key: string; label: string }[] = [];
  const quarters: { key: string; label: string }[] = [];
  const years: { key: string; label: string }[] = [];
  for (
    let d = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));
    d >= new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1))
  ) {
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth();
    months.push({ key: `${y}-${String(mo + 1).padStart(2, "0")}`, label: monthName(y, mo) });
    if (mo % 3 === 2 || months.length === 1) {
      const key = `${y}-Q${Math.floor(mo / 3) + 1}`;
      if (!quarters.some((q) => q.key === key)) {
        quarters.push({ key, label: quarterName(y, Math.floor(mo / 3)) });
      }
    }
    if (!years.some((x) => x.key === `${y}`)) years.push({ key: `${y}`, label: `${y}` });
  }
  return { months, quarters, years };
}

/**
 * The trend's points: every whole week (or month) that overlaps the window, oldest first. The
 * first may begin before the window does, so that every point but the last is a whole week; the
 * last ends when the data does.
 */
export function bucketsOf(window: Window): Bucket[] {
  const grain = grainOf(window);
  const end = window.current.end;
  const buckets: Bucket[] = [];
  let start = grain === "week" ? mondayOf(window.current.start) : monthOf(window.current.start);
  while (instant(start) < end) {
    const next =
      grain === "week"
        ? new Date(start.getTime() + 7 * DAY_MS)
        : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const partial = instant(next) > end;
    const month = start.getUTCMonth();
    buckets.push({
      start: instant(start),
      end: partial ? end : instant(next),
      label:
        grain === "week"
          ? `week of ${MONTHS[month]} ${start.getUTCDate()}`
          : `${MONTH_NAMES[month]} ${start.getUTCFullYear()}`,
      short: grain === "week" ? `${MONTHS[month]} ${start.getUTCDate()}` : (MONTHS[month] ?? ""),
      partial,
    });
    start = next;
  }
  return buckets;
}

/** A span moved back by some days, as the revert rate's window is (see REVERT_WINDOW_DAYS). */
export function shiftBack(original: Span, days: number): Span {
  const start = new Date(Date.parse(original.start) - days * DAY_MS);
  const end = new Date(Date.parse(original.end) - days * DAY_MS);
  return span(start, end, `${dayLabel(start)} – ${dayLabel(end)}`);
}

/** Whether the synced data covers the whole span: `from` is the first covered day. */
export const covers = (from: string, s: Pick<Span, "start">) => s.start >= from;

/** "Sep 7". */
export const dayLabel = (date: Date) => `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;

function span(start: Date, end: Date, label: string): Span {
  return { start: instant(start), end: instant(end), label };
}

function mondayOf(iso: string): Date {
  const date = new Date(iso);
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return new Date(day - ((date.getUTCDay() + 6) % 7) * DAY_MS);
}

function monthOf(iso: string): Date {
  const date = new Date(iso);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}
