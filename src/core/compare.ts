import type { MetricValue } from "./aggregate.ts";
import { num } from "./format.ts";

/**
 * How a metric moved from the previous period. Shares move in percentage points, everything else
 * by a relative amount. A count or a total of an unfinished period gets no change at all: it is
 * bound to be lower, so the comparison would only say the period isn't over (rule 7).
 */
export type Change =
  | { kind: "relative"; value: number }
  | { kind: "points"; value: number }
  | { kind: "none"; reason: string };

export function change(
  current: MetricValue,
  previous: MetricValue | null,
  currentComplete: boolean,
): Change {
  const { metric } = current;
  if ((metric.kind === "count" || metric.kind === "sum") && !currentComplete) {
    return { kind: "none", reason: "period not over" };
  }
  if (previous === null) return { kind: "none", reason: "no earlier data" };
  if (current.value === null || previous.value === null) return { kind: "none", reason: "" };
  if (metric.kind === "share")
    return { kind: "points", value: (current.value - previous.value) * 100 };
  if (previous.value === 0) return { kind: "none", reason: "" };
  return { kind: "relative", value: (current.value - previous.value) / previous.value };
}

/** "+12%", "−3 pts", or the reason there is none. */
export function formatChange(c: Change): string {
  const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "±");
  switch (c.kind) {
    case "relative":
      return `${sign(c.value)}${num(Math.round(Math.abs(c.value) * 100))}%`;
    case "points":
      return `${sign(c.value)}${num(Math.round(Math.abs(c.value)))} pts`;
    case "none":
      return c.reason;
  }
}
