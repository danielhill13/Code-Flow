// Rolling windows: the report's tabs look back from the moment the data was complete, so a
// window is never partial and its counts compare with the window before it (rule 7).
import { instant, type Span } from "./periods.ts";

export type WindowKey = "30d" | "60d" | "90d" | "ytd";

export const WINDOW_KEYS: readonly WindowKey[] = ["30d", "60d", "90d", "ytd"];

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

/** Year to date switches to monthly points once it is this long. */
export const WEEKLY_YTD_LIMIT_DAYS = 13 * 7;

export function windowOf(key: WindowKey, asOf: Date): Window {
  const end = new Date(Math.floor(asOf.getTime() / 1000) * 1000);
  if (key === "ytd") {
    const year = end.getUTCFullYear();
    const lastYear = new Date(end);
    lastYear.setUTCFullYear(year - 1);
    return {
      key,
      current: span(new Date(Date.UTC(year, 0, 1)), end, "year to date"),
      previous: span(new Date(Date.UTC(year - 1, 0, 1)), lastYear, `the same span of ${year - 1}`),
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

/** Weekly points, except for a year to date long enough to read better by month. */
export function grainOf(window: Window): Grain {
  const length = Date.parse(window.current.end) - Date.parse(window.current.start);
  return window.key === "ytd" && length > WEEKLY_YTD_LIMIT_DAYS * DAY_MS ? "month" : "week";
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
