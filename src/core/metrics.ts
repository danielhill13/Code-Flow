import type { PrFact } from "./facts.ts";

/**
 * Which PRs a metric describes in a period:
 * - `merged`: counted PRs merged during it;
 * - `ended`: counted PRs merged or closed during it.
 * Within those, a metric's function returns null for a PR it doesn't apply to, and that PR then
 * neither helps nor hurts: it isn't one of the metric's `n`.
 */
export type Population = "merged" | "ended";

export type MetricGroup = "Speed" | "Throughput" | "Review" | "Stability" | "Flow";

/** What a metric can see besides the PR itself. */
export type MetricContext = {
  /** When the data was last known complete. */
  asOf: Date;
};

type Base = {
  key: string;
  label: string;
  group: MetricGroup;
  /** One or two plain sentences: what is measured, exactly. */
  definition: string;
  population: Population;
  /**
   * The PRs of the population the metric has a value for, when that isn't all of them: what a
   * list of the PRs behind its number is narrowed to ("Reviewed").
   */
  subset?: string;
  /**
   * In a rolling window, the metric is measured over PRs merged this many days earlier, so that
   * each of them is old enough to judge. Calendar periods aren't shifted.
   */
  lagDays?: number;
};

export type Metric = Base &
  (
    | { kind: "count" }
    | { kind: "sum"; unit: "lines"; value: (pr: PrFact, ctx: MetricContext) => number | null }
    | {
        kind: "distribution";
        unit: "hours" | "lines" | "count";
        value: (pr: PrFact, ctx: MetricContext) => number | null;
      }
    | { kind: "share"; test: (pr: PrFact, ctx: MetricContext) => boolean | null }
  );

/** How long a merged PR is watched for a revert before it can count as not reverted. */
export const REVERT_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** Every metric, in the order reports list them. Add new ones here and nowhere else. */
export const METRICS: readonly Metric[] = [
  {
    key: "cycle",
    label: "Cycle time",
    group: "Speed",
    kind: "distribution",
    unit: "hours",
    population: "merged",
    value: (pr) => pr.cycleHours,
    definition: "From the first commit (or the PR's creation, if that is earlier) to merge.",
  },
  {
    key: "coding",
    label: "Coding",
    group: "Speed",
    kind: "distribution",
    unit: "hours",
    population: "merged",
    value: (pr) => pr.codingHours,
    definition: "From the start until the PR was ready for review. Time as a draft is coding.",
  },
  {
    key: "pickup",
    label: "Pickup",
    group: "Speed",
    kind: "distribution",
    unit: "hours",
    population: "merged",
    value: (pr) => pr.pickupHours,
    subset: "Reviewed",
    definition:
      "From ready for review to the first review by someone other than the author. PRs nobody reviewed have no pickup.",
  },
  {
    key: "review",
    label: "Review",
    group: "Speed",
    kind: "distribution",
    unit: "hours",
    population: "merged",
    value: (pr) => pr.reviewHours,
    subset: "Reviewed",
    definition:
      "From the first review to the last approval, or to the last review when nobody approved.",
  },
  {
    key: "mergeWait",
    label: "Merge wait",
    group: "Speed",
    kind: "distribution",
    unit: "hours",
    population: "merged",
    value: (pr) => pr.mergeWaitHours,
    definition: "From the end of review (or from ready, when nobody reviewed it) to merge.",
  },
  {
    key: "timeToApproval",
    label: "Time to approval",
    group: "Speed",
    kind: "distribution",
    unit: "hours",
    population: "merged",
    value: (pr) => pr.timeToApprovalHours,
    subset: "Approved",
    definition: "From ready for review to the first approval, for approved PRs.",
  },
  {
    key: "merged",
    label: "PRs merged",
    group: "Throughput",
    kind: "count",
    population: "merged",
    definition:
      "PRs merged into a measured branch, counted once: not bot PRs, not promotions between long-lived branches.",
  },
  {
    key: "size",
    label: "PR size",
    group: "Throughput",
    kind: "distribution",
    unit: "lines",
    population: "merged",
    value: (pr) => pr.sizeLines,
    subset: "Size known",
    definition:
      "Product lines added plus deleted. Lockfiles, generated, vendored, test and docs files don't count.",
  },
  {
    key: "linesMerged",
    label: "Lines merged",
    group: "Throughput",
    kind: "sum",
    unit: "lines",
    population: "merged",
    value: (pr) => pr.addedLines,
    subset: "Size known",
    definition: "Product lines added by merged PRs.",
  },
  {
    key: "reviewed",
    label: "Reviewed",
    group: "Review",
    kind: "share",
    population: "merged",
    test: (pr) => pr.reviewed,
    definition:
      "Reviewed by someone other than the author before merge. Bots don't count unless config names them.",
  },
  {
    key: "approved",
    label: "Approved",
    group: "Review",
    kind: "share",
    population: "merged",
    test: (pr) => pr.approved,
    definition: "Approved by someone other than the author before merge.",
  },
  {
    key: "reviewsPerPr",
    label: "Reviews per PR",
    group: "Review",
    kind: "distribution",
    unit: "count",
    population: "merged",
    value: (pr) => pr.reviews,
    definition:
      "Review submissions by people other than the author: each approval, change request or comment-review.",
  },
  {
    key: "commented",
    label: "Commented",
    group: "Review",
    kind: "share",
    population: "merged",
    test: (pr) => pr.comments > 0,
    definition:
      "Had a conversation comment from someone other than the author. Inline review threads aren't counted.",
  },
  {
    key: "repushed",
    label: "Re-pushed after review",
    group: "Review",
    kind: "share",
    population: "merged",
    test: (pr) => (pr.reviewed ? pr.rounds > 0 : null),
    subset: "Reviewed",
    definition: "Of reviewed PRs: new commits arrived after a review, so it went round again.",
  },
  {
    key: "reverted",
    label: `Reverted within ${REVERT_WINDOW_DAYS} days`,
    group: "Stability",
    kind: "share",
    population: "merged",
    test: (pr, ctx) => {
      if (pr.mergedAt === null) return null;
      const merged = Date.parse(pr.mergedAt);
      const window = REVERT_WINDOW_DAYS * DAY_MS;
      if (pr.revertedAt !== null && Date.parse(pr.revertedAt) - merged <= window) return true;
      // Too recent to tell: counting it as not reverted would flatter the rate.
      return ctx.asOf.getTime() - merged >= window ? false : null;
    },
    subset: "Old enough to tell",
    lagDays: REVERT_WINDOW_DAYS,
    definition: `Of merged PRs at least ${REVERT_WINDOW_DAYS} days old: reverted by another PR within ${REVERT_WINDOW_DAYS} days of merging.`,
  },
  {
    key: "abandoned",
    label: "Abandoned",
    group: "Flow",
    kind: "share",
    population: "ended",
    test: (pr) => pr.state === "closed",
    definition: "Of PRs that ended during the period: closed without merging.",
  },
];

const BY_KEY = new Map(METRICS.map((metric) => [metric.key, metric]));

/** The registry entry for a key. Throws for an unknown key: that is a bug, not data. */
export function metricOf(key: string): Metric {
  const metric = BY_KEY.get(key);
  if (!metric) throw new Error(`No metric "${key}"`);
  return metric;
}
