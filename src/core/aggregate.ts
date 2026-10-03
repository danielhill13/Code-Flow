import type { Exclusion, PrFact } from "./facts.ts";
import { METRICS, type Metric, type MetricContext, type Population } from "./metrics.ts";
import { inPeriod, type Period } from "./periods.ts";
import { percentile, percentileStat } from "./stats.ts";

export type MetricValue = {
  metric: Metric;
  /** Null when hidden (see `hidden`) or when no PR had a value. */
  value: number | null;
  /** PRs the value rests on. */
  n: number;
  /** Why a percentile is hidden. */
  hidden?: string;
  /** PRs in the population the metric did not apply to, such as merges too recent to judge. */
  notApplicable: number;
};

export type Phase = "coding" | "pickup" | "review" | "mergeWait";

/**
 * A phase's share of all the cycle hours in the period. Shares of summed hours add up to 100%,
 * which medians never do. `largestPr` is the PR holding the most hours of this phase, and
 * `largestShare` how much of the phase it holds: a large share means one PR moved the number.
 */
export type PhaseShare = { phase: Phase; share: number; largestPr: number; largestShare: number };

export type Measurement = {
  period: Period;
  /** When the data was last known complete, ISO 8601. */
  asOf: string;
  /** The percentile used for distributions; 0.5 is the median. */
  percentile: number;
  values: MetricValue[];
  /** Null when no merged PR had a cycle time. */
  phases: PhaseShare[] | null;
  /** Merged in the period but not counted, by reason. */
  excluded: Record<Exclusion, number>;
  /** Counted PRs merged in the period whose data GitHub cut short, by number. */
  truncated: number[];
  /** A snapshot as of `asOf`, whatever the period. */
  open: { count: number; drafts: number; medianAgeDays: number | null };
};

/** A phase holding this share of its hours in one PR deserves a warning: one PR moved it. */
export const CONCENTRATION_SHARE = 0.25;

const PHASE_FIELDS = {
  coding: "codingHours",
  pickup: "pickupHours",
  review: "reviewHours",
  mergeWait: "mergeWaitHours",
} as const satisfies Record<Phase, keyof PrFact>;

const DAY_MS = 86_400_000;

/** Every metric for one period. Distributions use the given percentile, the median by default. */
export function measure(
  facts: readonly PrFact[],
  period: Period,
  options: { asOf: Date; percentile?: number },
): Measurement {
  const p = options.percentile ?? 0.5;
  const ctx: MetricContext = { asOf: options.asOf };
  const counted = facts.filter((pr) => pr.counted);
  const groups = populations(facts, period);
  const merged = groups.merged;

  const excluded: Record<Exclusion, number> = { bot: 0, base: 0, promotion: 0 };
  for (const pr of facts) {
    if (!pr.counted && pr.exclusion && pr.state === "merged" && inPeriod(period, pr.mergedAt)) {
      excluded[pr.exclusion] += 1;
    }
  }

  const open = counted.filter((pr) => pr.state === "open");
  const ages = open
    .map((pr) => (options.asOf.getTime() - Date.parse(pr.createdAt)) / DAY_MS)
    .sort((a, b) => a - b);

  return {
    period,
    asOf: options.asOf.toISOString(),
    percentile: p,
    values: METRICS.map((metric) => metricValue(metric, groups[metric.population], p, ctx)),
    phases: phaseShares(merged),
    excluded,
    truncated: merged.filter((pr) => pr.truncated.length > 0).map((pr) => pr.number),
    open: {
      count: open.length,
      drafts: open.filter((pr) => pr.draft).length,
      medianAgeDays: ages.length > 0 ? percentile(ages, 0.5) : null,
    },
  };
}

/** The counted PRs each population holds for a period (see Population). */
export function populations(
  facts: readonly PrFact[],
  period: Period,
): Record<Population, PrFact[]> {
  const counted = facts.filter((pr) => pr.counted);
  return {
    merged: counted.filter((pr) => pr.state === "merged" && inPeriod(period, pr.mergedAt)),
    ended: counted.filter((pr) =>
      pr.state === "merged"
        ? inPeriod(period, pr.mergedAt)
        : pr.state === "closed" && inPeriod(period, pr.closedAt),
    ),
  };
}

/** One PR's value for a metric: a number, a yes/no for shares, or null where it doesn't apply. */
export function prValue(metric: Metric, pr: PrFact, ctx: MetricContext): number | boolean | null {
  switch (metric.kind) {
    case "count":
      return true;
    case "sum":
    case "distribution":
      return metric.value(pr, ctx);
    case "share":
      return metric.test(pr, ctx);
  }
}

function metricValue(
  metric: Metric,
  prs: readonly PrFact[],
  p: number,
  ctx: MetricContext,
): MetricValue {
  switch (metric.kind) {
    case "count":
      return { metric, value: prs.length, n: prs.length, notApplicable: 0 };
    case "sum": {
      const values = present(prs.map((pr) => metric.value(pr, ctx)));
      return {
        metric,
        value: values.length > 0 ? values.reduce((a, b) => a + b, 0) : null,
        n: values.length,
        notApplicable: prs.length - values.length,
      };
    }
    case "distribution": {
      const stat = percentileStat(
        prs.map((pr) => metric.value(pr, ctx)),
        p,
      );
      return { metric, ...stat, notApplicable: prs.length - stat.n };
    }
    case "share": {
      const tests = present(prs.map((pr) => metric.test(pr, ctx)));
      return {
        metric,
        value: tests.length > 0 ? tests.filter(Boolean).length / tests.length : null,
        n: tests.length,
        notApplicable: prs.length - tests.length,
      };
    }
  }
}

function phaseShares(merged: readonly PrFact[]): PhaseShare[] | null {
  const timed = merged.filter((pr) => pr.cycleHours !== null);
  const total = timed.reduce((sum, pr) => sum + (pr.cycleHours ?? 0), 0);
  if (total <= 0) return null;
  return (Object.keys(PHASE_FIELDS) as Phase[]).map((phase) => {
    let phaseTotal = 0;
    let largest = { pr: 0, hours: 0 };
    for (const pr of timed) {
      const hours = pr[PHASE_FIELDS[phase]] ?? 0;
      phaseTotal += hours;
      if (hours > largest.hours) largest = { pr: pr.number, hours };
    }
    return {
      phase,
      share: phaseTotal / total,
      largestPr: largest.pr,
      largestShare: phaseTotal > 0 ? largest.hours / phaseTotal : 0,
    };
  });
}

function present<T>(values: readonly (T | null)[]): T[] {
  return values.filter((value): value is T => value !== null);
}
