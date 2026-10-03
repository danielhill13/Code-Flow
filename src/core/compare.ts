import type { MetricValue } from "./aggregate.ts";
import { formatValue, num, percent } from "./format.ts";
import { metricOf } from "./metrics.ts";

/**
 * How a metric moved from an earlier span. Shares move in percentage points, everything else by
 * a relative amount, and a move too small to mean anything is "same". A count or a total of an
 * unfinished span gets no change at all: it is bound to be lower, so the comparison would only
 * say the span isn't over (rule 7).
 */
export type Change =
  | { kind: "relative"; value: number }
  | { kind: "points"; value: number }
  | { kind: "fromZero" }
  | { kind: "same" }
  | { kind: "none"; reason: string };

/** Moves smaller than these read as "same as before": noise, not news. */
export const SAME_RELATIVE = 0.03;
export const SAME_POINTS = 0.5;

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
  return Math.abs(relative) < SAME_RELATIVE
    ? { kind: "same" }
    : { kind: "relative", value: relative };
}

/** "↑ 125% from 1.3 d", "↓ 10 pts from 32%", "same as before (2)", or why there's no change. */
export function changeText(c: Change, previous: MetricValue | null): string {
  const before = previous ? formatValue(previous) : "";
  switch (c.kind) {
    case "relative":
      return `${arrow(c.value)} ${num(Math.round(Math.abs(c.value) * 100))}% from ${before}`;
    case "points":
      return `${arrow(c.value)} ${points(c.value)} from ${before}`;
    case "fromZero":
      return "↑ from 0";
    case "same":
      return `same as before (${before})`;
    case "none":
      return c.reason;
  }
}

/** The change without its baseline, for a table column: "↓ 29%", "↑ 10 pts", "same". */
export function changeShort(c: Change): string {
  switch (c.kind) {
    case "relative":
      return `${arrow(c.value)} ${num(Math.round(Math.abs(c.value) * 100))}%`;
    case "points":
      return `${arrow(c.value)} ${points(c.value)}`;
    case "fromZero":
      return "↑ from 0";
    case "same":
      return "same";
    case "none":
      return c.reason;
  }
}

/** Just the direction, for a dense table: "↑", "↓" or "". */
export function changeArrow(c: Change): string {
  if (c.kind === "relative" || c.kind === "points") return arrow(c.value);
  return c.kind === "fromZero" ? "↑" : "";
}

const arrow = (value: number) => (value > 0 ? "↑" : "↓");

/** "10 pts", or one decimal under 10: "3.8 pts". */
function points(value: number): string {
  const size = Math.abs(value);
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} pts`;
}

/** A share's move as text, for values that aren't metrics (a team's top-2 share). */
export function sharePointsText(current: number, previous: number): string {
  const moved = (current - previous) * 100;
  return Math.abs(moved) < SAME_POINTS
    ? `same as before (${percent(previous)})`
    : `${arrow(moved)} ${points(moved)} from ${percent(previous)}`;
}
