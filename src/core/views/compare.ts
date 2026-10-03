// Compare: did the change work? Two calendar periods (or custom dates), every metric side by
// side with its PR counts and the middle half of its PRs, so a moved median can be weighed
// against its spread.
import type { MetricValue, PhaseShare } from "../aggregate.ts";
import { METRICS } from "../metrics.ts";
import { isComplete, type Span } from "../periods.ts";
import type { Contributors, Selection } from "../selection.ts";
import { covers } from "../windows.ts";
import { Slice, type ViewContext } from "./context.ts";

export type CompareQuery = {
  selection: Selection;
  contributors: Contributors;
  percentile: number;
  a: Span;
  b: Span;
};

export type PeriodView = Span & {
  /** Ended by the data's as-of time: its counts can't grow any more. */
  complete: boolean;
  /** Starts on or after the data does. */
  covered: boolean;
};

export type CompareRow = {
  key: string;
  a: MetricValue;
  b: MetricValue;
  /** P25 to P75 of a distribution's PRs; null for other metrics or when too few PRs. */
  middleA: [number, number] | null;
  middleB: [number, number] | null;
};

export type CompareModel = {
  a: PeriodView;
  b: PeriodView;
  /** Every metric, in registry order (which groups them). */
  rows: CompareRow[];
  phasesA: PhaseShare[] | null;
  phasesB: PhaseShare[] | null;
};

export function compare(ctx: ViewContext, q: CompareQuery): CompareModel {
  const slice = new Slice(ctx, q.selection, q.contributors);
  const view = (span: Span): PeriodView => ({
    ...span,
    complete: isComplete(span, ctx.asOf),
    covered: covers(ctx.coveredFrom, span),
  });
  const middle = (key: string, span: Span): [number, number] | null => {
    const low = slice.value(key, span, 0.25).value;
    const high = slice.value(key, span, 0.75).value;
    return low !== null && high !== null ? [low, high] : null;
  };
  return {
    a: view(q.a),
    b: view(q.b),
    rows: METRICS.map((metric) => {
      const spread = metric.kind === "distribution";
      return {
        key: metric.key,
        a: slice.value(metric.key, q.a, q.percentile),
        b: slice.value(metric.key, q.b, q.percentile),
        middleA: spread ? middle(metric.key, q.a) : null,
        middleB: spread ? middle(metric.key, q.b) : null,
      };
    }),
    phasesA: slice.shares(q.a),
    phasesB: slice.shares(q.b),
  };
}
