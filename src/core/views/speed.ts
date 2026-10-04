// Speed: which phase holds us up, how long a typical change takes, whether big PRs cost us.
import { type MetricValue, PHASES, type Phase } from "../aggregate.ts";
import type { PrFact } from "../facts.ts";
import type { Span } from "../periods.ts";
import {
  type Point,
  Slice,
  type Tile,
  type ViewContext,
  type ViewQuery,
  type WindowView,
  windowView,
} from "./context.ts";

/** PR size bands, in lines of product code: `min` inclusive, `max` exclusive. */
export type SizeBand = {
  key: "xs" | "s" | "m" | "l" | "xl";
  label: string;
  min: number;
  max: number | null;
};

export const SIZE_BANDS: readonly SizeBand[] = [
  { key: "xs", label: "XS · under 10", min: 0, max: 10 },
  { key: "s", label: "S · 10–99", min: 10, max: 100 },
  { key: "m", label: "M · 100–399", min: 100, max: 400 },
  { key: "l", label: "L · 400–999", min: 400, max: 1000 },
  { key: "xl", label: "XL · 1,000+", min: 1000, max: null },
];

export function inBand(band: SizeBand, lines: number | null): boolean {
  return lines !== null && lines >= band.min && (band.max === null || lines < band.max);
}

/** How far out the slow end of cycle time is shown: "85% merge within…". */
export const SLOW_END = 0.85;

export type SpeedModel = {
  window: WindowView;
  /** The cycle-time trend: the chosen statistic per bucket, with P85 drawn around it. */
  cycle: { point: Point; slow: MetricValue | null }[];
  /** Half of changes merge within the median; 85% within P85. Spread is P85 ÷ median. */
  predictability: {
    median: MetricValue;
    slow: MetricValue;
    spread: number | null;
    previousSpread: number | null;
  };
  /** Coding, pickup, review and merge wait, each with its share of the window's cycle hours. */
  phases: { tile: Tile; share: number | null }[];
  /** The phase holding the most cycle hours in the window. */
  largest: Phase | null;
  approval: Tile;
  sizes: { band: SizeBand; count: MetricValue; cycle: MetricValue }[];
  throughput: { merged: Tile; size: Tile; withinSize: Tile; linesMerged: Tile };
  /** The org's size target, in product lines. */
  sizeTargetLines: number;
};

export function speed(ctx: ViewContext, q: ViewQuery): SpeedModel {
  const window = windowView(ctx, q.window);
  const slice = new Slice(ctx, q.selection, q.contributors);
  const p = q.percentile;
  const shares = slice.shares(window.current);
  const largest = shares
    ? shares.reduce((top, share) => (share.share > top.share ? share : top)).phase
    : null;
  const spread = (span: Span): number | null => {
    const median = slice.value("cycle", span, 0.5).value;
    const slow = slice.value("cycle", span, SLOW_END).value;
    return median !== null && slow !== null && median > 0 ? slow / median : null;
  };

  return {
    window,
    cycle: slice.series("cycle", window, p).map((point) => ({
      point,
      slow: point.value === null ? null : slice.value("cycle", point.span, SLOW_END),
    })),
    predictability: {
      median: slice.value("cycle", window.current, 0.5),
      slow: slice.value("cycle", window.current, SLOW_END),
      spread: spread(window.current),
      previousSpread: window.previousCovered ? spread(window.previous) : null,
    },
    phases: PHASES.map((phase) => ({
      tile: slice.tile(phase, window, p),
      share: shares?.find((s) => s.phase === phase)?.share ?? null,
    })),
    largest,
    approval: slice.tile("timeToApproval", window, p),
    sizes: SIZE_BANDS.map((band) => {
      const test = (pr: PrFact) => inBand(band, pr.sizeLines);
      return {
        band,
        count: slice.valueWhere("merged", window.current, p, test),
        cycle: slice.valueWhere("cycle", window.current, p, test),
      };
    }),
    throughput: {
      merged: slice.tile("merged", window, p),
      size: slice.tile("size", window, p),
      withinSize: slice.tile("withinSize", window, p),
      linesMerged: slice.tile("linesMerged", window, p),
    },
    sizeTargetLines: ctx.sizeTargetLines,
  };
}
