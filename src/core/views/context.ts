// What every report tab is built from. A tab's model is a pure function of the facts, what can be
// selected and a query, and plain data, so the static report computes it in the page and a server
// can send the same thing as JSON: the numbers can't differ (decision D18).
import {
  evaluate,
  type MetricValue,
  type PhaseShare,
  phaseShares,
  populations,
} from "../aggregate.ts";
import type { PrFact } from "../facts.ts";
import type { MetricContext, Population } from "../metrics.ts";
import { DEFAULT_CHURN_DAYS, lagOf, metricOf } from "../metrics.ts";
import type { Span } from "../periods.ts";
import {
  type Breakdown,
  breakdownValues,
  byContributors,
  type Choices,
  type Contributors,
  type Selection,
  selects,
} from "../selection.ts";
import { isStale } from "../stale.ts";
import {
  type Bucket,
  bucketsOf,
  covers,
  type Grain,
  grainOf,
  shiftBack,
  type WindowKey,
  windowOf,
} from "../windows.ts";

/** Everything the views compute from. */
export type ViewContext = {
  facts: readonly PrFact[];
  choices: Choices;
  /** When the data was last known complete. */
  asOf: Date;
  /** The first day the data fully covers, YYYY-MM-DD. */
  coveredFrom: string;
  /** An open PR quiet for longer than this is stale (decision D36). */
  staleAfterDays: number;
  /** Whether views may name one person's numbers, such as reviewers by name. */
  peopleViews: boolean;
  /** The org's churn window and size target (decision D44). */
  churnDays: number;
  sizeTargetLines: number;
};

/** What the metrics see of a view's context. */
export const metricContext = (ctx: ViewContext): MetricContext => ({
  asOf: ctx.asOf,
  churnDays: ctx.churnDays,
  sizeTargetLines: ctx.sizeTargetLines,
});

/** What a tab is asked for: which PRs, broken down how, over which window, with which statistic. */
export type ViewQuery = {
  selection: Selection;
  /** What the tab's breakdown rows are: teams, groups of one kind, or repos; null for none. */
  by: Breakdown | null;
  contributors: Contributors;
  window: WindowKey;
  /** 0.5 for the median, 0.75 for P75. */
  percentile: number;
};

export type BucketView = Bucket & {
  /** False where the bucket starts before the data does: its value would only look real. */
  covered: boolean;
};

/** A window as a tab shows it. */
export type WindowView = {
  key: WindowKey;
  current: Span;
  previous: Span;
  /** False when the previous window starts before the data does: there is nothing to compare. */
  previousCovered: boolean;
  grain: Grain;
  buckets: BucketView[];
};

/** A trend point; `value` is null where the data doesn't reach. */
export type Point = { bucket: BucketView; span: Span; value: MetricValue | null };

/** One number with what it is compared with and its trend. */
export type Tile = {
  key: string;
  /** What the value covers: the window, or for a lagged metric the window shifted back. */
  span: Span;
  value: MetricValue;
  /** Null when the earlier span isn't covered by the data. */
  previous: MetricValue | null;
  series: Point[];
};

/** A value and the previous window's, for tables. */
export type Pair = { value: MetricValue; previous: MetricValue | null };

export function windowView(ctx: ViewContext, key: WindowKey): WindowView {
  const window = windowOf(key, ctx.asOf);
  return {
    key,
    current: window.current,
    previous: window.previous,
    previousCovered: covers(ctx.coveredFrom, window.previous),
    grain: grainOf(window),
    buckets: bucketsOf(window).map((bucket) => ({
      ...bucket,
      covered: covers(ctx.coveredFrom, bucket),
    })),
  };
}

/**
 * The PRs of one scope and contributor filter, with the metric values a tab asks of them.
 * Populations are cached per span, since most metrics share a few spans.
 */
export class Slice {
  readonly ctx: ViewContext;
  readonly facts: PrFact[];
  readonly #groups = new Map<string, Record<Population, PrFact[]>>();

  constructor(ctx: ViewContext, selection: Selection, contributors: Contributors) {
    this.ctx = ctx;
    const selected = selects(selection, ctx.choices);
    const kept = byContributors(contributors);
    this.facts = ctx.facts.filter((pr) => selected(pr) && kept(pr));
  }

  /** The values a breakdown lists: those the slice's counted PRs have, A–Z, catch-alls last. */
  values(by: Breakdown): string[] {
    return breakdownValues(
      this.ctx.choices,
      by,
      this.facts.filter((pr) => pr.counted),
    );
  }

  /** The counted PRs each population holds for a span. */
  groups(span: Pick<Span, "start" | "end">): Record<Population, PrFact[]> {
    const key = `${span.start}|${span.end}`;
    let groups = this.#groups.get(key);
    if (!groups) {
      groups = populations(this.facts, span);
      this.#groups.set(key, groups);
    }
    return groups;
  }

  /** A metric over a span: null-valued, with the reason, where the data doesn't cover it. */
  value(key: string, span: Span, p: number): MetricValue {
    if (!covers(this.ctx.coveredFrom, span)) return uncovered(key, this.ctx.coveredFrom);
    const metric = metricOf(key);
    return evaluate(metric, this.groups(span)[metric.population], p, metricContext(this.ctx));
  }

  /** Each phase's share of the cycle hours of PRs merged in the span; null if not covered. */
  shares(span: Span): PhaseShare[] | null {
    return covers(this.ctx.coveredFrom, span) ? phaseShares(this.groups(span).merged) : null;
  }

  /** A metric over those of the span's PRs that pass a test, such as one size band. */
  valueWhere(key: string, span: Span, p: number, test: (pr: PrFact) => boolean): MetricValue {
    if (!covers(this.ctx.coveredFrom, span)) return uncovered(key, this.ctx.coveredFrom);
    const metric = metricOf(key);
    const prs = this.groups(span)[metric.population].filter(test);
    return evaluate(metric, prs, p, metricContext(this.ctx));
  }

  /** The value and the previous window's, each over the metric's own (possibly lagged) span. */
  pair(key: string, window: WindowView, p: number): Pair {
    const current = lagged(key, window.current, this.ctx);
    const previous = lagged(key, window.previous, this.ctx);
    return {
      value: this.value(key, current, p),
      previous: covers(this.ctx.coveredFrom, previous) ? this.value(key, previous, p) : null,
    };
  }

  /** The metric for each bucket of the window, shifted back too for a lagged metric. */
  series(key: string, window: WindowView, p: number): Point[] {
    return window.buckets.map((bucket) => {
      const span = lagged(key, bucket, this.ctx);
      return {
        bucket,
        span,
        value: covers(this.ctx.coveredFrom, span) ? this.value(key, span, p) : null,
      };
    });
  }

  tile(key: string, window: WindowView, p: number): Tile {
    const { value, previous } = this.pair(key, window, p);
    return {
      key,
      span: lagged(key, window.current, this.ctx),
      value,
      previous,
      series: this.series(key, window, p),
    };
  }

  /** Counted PRs open now: open, and not stale. */
  open(): PrFact[] {
    return this.facts.filter(
      (pr) =>
        pr.counted && pr.state === "open" && !isStale(pr, this.ctx.asOf, this.ctx.staleAfterDays),
    );
  }

  /** Counted PRs open but stale: nobody has touched them for longer than the org allows. */
  stale(): PrFact[] {
    return this.facts.filter(
      (pr) => pr.counted && isStale(pr, this.ctx.asOf, this.ctx.staleAfterDays),
    );
  }
}

/** A metric's span in a rolling window: shifted back by its lag, if it has one. */
export function lagged(
  key: string,
  span: Span,
  ctx: Pick<ViewContext, "churnDays"> = { churnDays: DEFAULT_CHURN_DAYS },
): Span {
  const lag = lagOf(metricOf(key), ctx);
  return lag ? shiftBack(span, lag) : span;
}

function uncovered(key: string, from: string): MetricValue {
  return { key, value: null, n: 0, notApplicable: 0, hidden: `the data starts ${from}` };
}
