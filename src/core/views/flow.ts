// Flow: what's stuck right now, and whose move it is. A snapshot as of the data; the window only
// drives the open-PR trend and the abandon rate.
import type { OpenState, PrFact } from "../facts.ts";
import { covers } from "../windows.ts";
import {
  type BucketView,
  Slice,
  type Tile,
  type ViewContext,
  type ViewQuery,
  type WindowView,
  windowView,
} from "./context.ts";

/** How long open PRs have been open, in days: `min` inclusive, `max` exclusive. */
export type AgeBand = { key: string; label: string; min: number; max: number | null };

export const AGE_BANDS: readonly AgeBand[] = [
  { key: "1d", label: "Under 1 day", min: 0, max: 1 },
  { key: "3d", label: "1–3 days", min: 1, max: 3 },
  { key: "7d", label: "3–7 days", min: 3, max: 7 },
  { key: "4w", label: "1–4 weeks", min: 7, max: 28 },
  { key: "3mo", label: "1–3 months", min: 28, max: 91 },
  { key: "old", label: "Over 3 months", min: 91, max: null },
];

export const OPEN_STATES: readonly OpenState[] = ["draft", "waiting", "in_review", "approved"];

/** Open PRs listed oldest first on the Flow tab, before "show all". */
export const OLDEST_ROWS = 8;

export type FlowModel = {
  window: WindowView;
  /** Counted PRs open as of the data, and at the start of the window (null if not covered). */
  open: {
    now: number;
    atStart: number | null;
    series: { bucket: BucketView; count: number | null }[];
  };
  waiting: { count: number; oldestSince: string | null };
  approved: { count: number; oldestSince: string | null };
  abandoned: Tile;
  ages: { band: AgeBand; total: number; states: Record<OpenState, number> }[];
  /** The longest-open PRs. */
  oldest: PrFact[];
};

const DAY_MS = 86_400_000;

export function flow(ctx: ViewContext, q: ViewQuery): FlowModel {
  const window = windowView(ctx, q.window);
  const slice = new Slice(ctx, q.selection, q.contributors);
  const open = slice.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const counted = slice.facts.filter((pr) => pr.counted);
  const openAt = (at: string) =>
    covers(ctx.coveredFrom, { start: at }) ? openCount(counted, at) : null;
  const inState = (state: OpenState) => open.filter((pr) => pr.openState === state);
  const oldestSince = (prs: readonly PrFact[]) =>
    prs.reduce<string | null>((min, pr) => {
      const since = pr.waitingSince ?? pr.createdAt;
      return min === null || since < min ? since : min;
    }, null);
  const asOf = ctx.asOf.getTime();

  return {
    window,
    open: {
      now: open.length,
      atStart: openAt(window.current.start),
      series: window.buckets.map((bucket) => ({
        bucket,
        count: bucket.covered ? openAt(bucket.end) : null,
      })),
    },
    waiting: { count: inState("waiting").length, oldestSince: oldestSince(inState("waiting")) },
    approved: { count: inState("approved").length, oldestSince: oldestSince(inState("approved")) },
    abandoned: slice.tile("abandoned", window, q.percentile),
    ages: AGE_BANDS.map((band) => {
      const prs = open.filter((pr) => inAgeBand(band, (asOf - Date.parse(pr.createdAt)) / DAY_MS));
      const states = Object.fromEntries(
        OPEN_STATES.map((state) => [state, prs.filter((pr) => pr.openState === state).length]),
      ) as Record<OpenState, number>;
      return { band, total: prs.length, states };
    }),
    oldest: open.slice(0, OLDEST_ROWS),
  };
}

export function inAgeBand(band: AgeBand, days: number): boolean {
  return days >= band.min && (band.max === null || days < band.max);
}

/**
 * Counted PRs open at an instant: opened by then, and not yet merged or closed. A PR that was
 * closed and reopened counts as open from its creation until its last close.
 */
export function openCount(facts: readonly PrFact[], at: string): number {
  let count = 0;
  for (const pr of facts) {
    const ended = pr.mergedAt ?? (pr.state === "closed" ? pr.closedAt : null);
    if (pr.createdAt <= at && (ended === null || ended > at)) count += 1;
  }
  return count;
}

/** Days an open PR has been open as of the data. */
export const ageDays = (pr: Pick<PrFact, "createdAt">, asOf: Date) =>
  (asOf.getTime() - Date.parse(pr.createdAt)) / DAY_MS;
