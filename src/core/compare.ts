import type { MetricValue } from "./aggregate.ts";
import { duration, durationLike, formatValue, num, percent } from "./format.ts";
import { metricOf } from "./metrics.ts";

/**
 * How a metric moved from an earlier span, in neutral words: an increase or a decrease, never
 * better or worse (decision D35). Shares move in percentage points. A small base moves by an
 * absolute amount, since "528% from 1 min" would make noise look like news. Everything else
 * moves by a relative amount, and a move too small to mean anything is "same". A count or a
 * total of an unfinished span gets no change at all: it is bound to be lower, so the comparison
 * would only say the span isn't over (rule 7).
 */
export type Change =
  | { kind: "relative"; value: number }
  | { kind: "absolute"; value: number }
  | { kind: "points"; value: number }
  | { kind: "fromZero" }
  | { kind: "same" }
  | { kind: "none"; reason: string };

/** Moves smaller than these read as "same as before": noise, not news. */
export const SAME_RELATIVE = 0.03;
export const SAME_POINTS = 0.5;
/** Bases below these move by an absolute amount: under an hour, or fewer than five. */
export const SMALL_BASE_HOURS = 1;
export const SMALL_BASE_COUNT = 5;

export function change(
  current: MetricValue,
  previous: MetricValue | null,
  currentComplete = true,
): Change {
  const metric = metricOf(current.key);
  if ((metric.kind === "count" || metric.kind === "sum") && !currentComplete) {
    return { kind: "none", reason: "period not over" };
  }
  if (previous === null) return { kind: "none", reason: "no earlier data" };
  if (current.value === null || previous.value === null) return { kind: "none", reason: "" };
  if (metric.kind === "share") {
    const points = (current.value - previous.value) * 100;
    return Math.abs(points) < SAME_POINTS ? { kind: "same" } : { kind: "points", value: points };
  }
  if (previous.value === 0) return current.value === 0 ? { kind: "same" } : { kind: "fromZero" };
  const relative = (current.value - previous.value) / previous.value;
  if (Math.abs(relative) < SAME_RELATIVE) return { kind: "same" };
  const small = isHours(current.key)
    ? previous.value < SMALL_BASE_HOURS
    : metric.kind === "count" && previous.value < SMALL_BASE_COUNT;
  return small
    ? { kind: "absolute", value: current.value - previous.value }
    : { kind: "relative", value: relative };
}

/**
 * "135% increase from 1.3 d", "6 min increase from 1 min", "4.0 pts decrease from 50%",
 * "same as before (2)", or why there's no change. The baseline is in the current value's unit,
 * so 3.1 d is compared with 1.3 d, not with 31.6 h.
 */
export function changeText(
  c: Change,
  previous: MetricValue | null,
  current: MetricValue | null = null,
): string {
  const before = previous ? baseline(previous, current) : "";
  switch (c.kind) {
    case "relative":
      return `${num(Math.round(Math.abs(c.value) * 100))}% ${direction(c.value)} from ${before}`;
    case "absolute":
      return `${amount(c.value, previous)} ${direction(c.value)} from ${before}`;
    case "points":
      return `${points(c.value)} ${direction(c.value)} from ${before}`;
    case "fromZero":
      return "increase from 0";
    case "same":
      return `same as before (${before})`;
    case "none":
      return c.reason;
  }
}

/** The change without its baseline, for a table column: "29% decrease", "10 pts increase". */
export function changeShort(c: Change, previous: MetricValue | null = null): string {
  switch (c.kind) {
    case "relative":
      return `${num(Math.round(Math.abs(c.value) * 100))}% ${direction(c.value)}`;
    case "absolute":
      return `${amount(c.value, previous)} ${direction(c.value)}`;
    case "points":
      return `${points(c.value)} ${direction(c.value)}`;
    case "fromZero":
      return "increase from 0";
    case "same":
      return "same";
    case "none":
      return c.reason;
  }
}

/**
 * Just the direction, for a dense table: "↑" for an increase, "↓" for a decrease, "" for
 * neither. Shown with `changeWord` as its accessible name.
 */
export function changeArrow(c: Change): string {
  if (c.kind === "relative" || c.kind === "points" || c.kind === "absolute") {
    return c.value > 0 ? "↑" : "↓";
  }
  return c.kind === "fromZero" ? "↑" : "";
}

/** "increase", "decrease" or "" : what an arrow from changeArrow means, in words. */
export function changeWord(c: Change): string {
  const arrow = changeArrow(c);
  return arrow === "↑" ? "increase" : arrow === "↓" ? "decrease" : "";
}

/** Whether a metric is a duration in hours (not a share or a count). */
function isHours(key: string): boolean {
  const metric = metricOf(key);
  return "unit" in metric && metric.unit === "hours";
}

const direction = (value: number) => (value > 0 ? "increase" : "decrease");

/** "10 pts", or one decimal under 10: "3.8 pts". */
function points(value: number): string {
  const size = Math.abs(value);
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} pts`;
}

/** An absolute move in the metric's unit: "6 min", "3". */
function amount(value: number, previous: MetricValue | null): string {
  const size = Math.abs(value);
  if (previous && isHours(previous.key)) return duration(size);
  return Number.isInteger(size) ? num(size) : size.toFixed(1);
}

/** The earlier value, written in the current value's unit when both are durations. */
function baseline(previous: MetricValue, current: MetricValue | null): string {
  if (current?.value != null && previous.value !== null && isHours(previous.key)) {
    return durationLike(previous.value, current.value);
  }
  return formatValue(previous);
}

/** A share's move as text, for values that aren't metrics (a team's top-2 share). */
export function sharePointsText(current: number, previous: number): string {
  const moved = (current - previous) * 100;
  return Math.abs(moved) < SAME_POINTS
    ? `same as before (${percent(previous)})`
    : `${points(moved)} ${direction(moved)} from ${percent(previous)}`;
}
