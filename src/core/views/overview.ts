// Overview: are we getting faster or slower, where is the time going, which team to look at.
import { CONCENTRATION_SHARE, excluded, type MetricValue, type Phase } from "../aggregate.ts";
import { REVERT_WINDOW_DAYS } from "../metrics.ts";
import type { Span } from "../periods.ts";
import { type Breakdown, isInternal, kindOf, narrow, type Selection } from "../selection.ts";
import { shiftBack } from "../windows.ts";
import {
  type Pair,
  type Point,
  Slice,
  type Tile,
  type ViewContext,
  type ViewQuery,
  type WindowView,
  windowView,
} from "./context.ts";

/** Each phase's share of the window's cycle hours, with the phase's own statistic. */
export type PhaseSplit = {
  phase: Phase;
  share: number;
  value: MetricValue;
};

/** A row of the teams (or repos) table. */
export type ScopeRow = {
  selection: Selection;
  by: Breakdown;
  name: string;
  merged: Pair;
  cycle: Pair;
  pickup: Pair;
  review: Pair;
  repushed: MetricValue;
  /** Counted PRs open now. */
  open: number;
  cycleSeries: Point[];
};

/** A fact a reader should know before trusting the numbers. Never a judgment. */
export type Note =
  | { kind: "excluded"; base: number; promotion: number; bot: number; rule: number }
  | { kind: "concentration"; phase: Phase; pr: { id: string; number: number }; share: number }
  | { kind: "outside"; external: number; open: number }
  | { kind: "tooFew"; rows: { name: string; merged: number }[] }
  /** PRs merged in the window that count in more than one row: products may overlap. */
  | { kind: "overlap"; by: Breakdown; prs: number }
  | { kind: "revertLag"; span: Span }
  | { kind: "truncated"; prs: { id: string; number: number }[] };

export type OverviewModel = {
  window: WindowView;
  /** Cycle time, PRs merged, pickup and the revert rate. */
  tiles: Tile[];
  /** Null when no PR merged in the window. */
  phases: PhaseSplit[] | null;
  /** The breakdown by the query's `by`: empty without one, or when it would be one row. */
  rows: ScopeRow[];
  notes: Note[];
};

/** Open PRs from outside the project, past this share of all open PRs, earn a note. */
export const OUTSIDE_NOTE_SHARE = 0.3;

export const OVERVIEW_TILES = ["cycle", "merged", "pickup", "reverted"] as const;

export function overview(ctx: ViewContext, q: ViewQuery): OverviewModel {
  const window = windowView(ctx, q.window);
  const slice = new Slice(ctx, q.selection, q.contributors);
  const p = q.percentile;
  const merged = slice.groups(window.current).merged;
  const shares = slice.shares(window.current);

  const by = q.by;
  const values = by ? slice.values(by) : [];
  const rows = by && values.length > 1 ? values.map((value) => row(ctx, q, by, value, window)) : [];

  const notes: Note[] = [];
  const out = excluded(slice.facts, window.current);
  if (out.base + out.promotion + out.bot + out.rule > 0) notes.push({ kind: "excluded", ...out });
  for (const share of shares ?? []) {
    if (share.largestShare >= CONCENTRATION_SHARE) {
      const pr = merged.find((m) => m.number === share.largestPr);
      notes.push({
        kind: "concentration",
        phase: share.phase,
        pr: { id: pr?.id ?? "", number: share.largestPr },
        share: share.largestShare,
      });
    }
  }
  if (q.contributors === "all") {
    const open = slice.open();
    const external = open.filter((pr) => !isInternal(pr)).length;
    if (open.length > 0 && external / open.length > OUTSIDE_NOTE_SHARE) {
      notes.push({ kind: "outside", external, open: open.length });
    }
  }
  const few = rows.filter((r) => r.cycle.value.hidden !== undefined);
  if (few.length > 0) {
    notes.push({
      kind: "tooFew",
      rows: few.map((r) => ({ name: r.name, merged: r.merged.value.value ?? 0 })),
    });
  }
  if (rows.length > 0 && by?.startsWith("group:")) {
    const kind = by.slice("group:".length);
    const ofKind = (pr: (typeof merged)[number]) =>
      pr.groups.filter((g) => kindOf(ctx.choices, g) === kind).length;
    const shared = merged.filter((pr) => ofKind(pr) > 1).length;
    if (shared > 0) notes.push({ kind: "overlap", by, prs: shared });
  }
  notes.push({ kind: "revertLag", span: shiftBack(window.current, REVERT_WINDOW_DAYS) });
  const truncated = merged.filter((pr) => pr.truncated.length > 0);
  if (truncated.length > 0) {
    notes.push({ kind: "truncated", prs: truncated.map(({ id, number }) => ({ id, number })) });
  }

  return {
    window,
    tiles: OVERVIEW_TILES.map((key) => slice.tile(key, window, p)),
    phases:
      shares?.map(({ phase, share }) => ({
        phase,
        share,
        value: slice.value(phase, window.current, p),
      })) ?? null,
    rows,
    notes,
  };
}

function row(
  ctx: ViewContext,
  q: ViewQuery,
  by: Breakdown,
  value: string,
  window: WindowView,
): ScopeRow {
  const selection = narrow(ctx.choices, q.selection, by, value);
  const slice = new Slice(ctx, selection, q.contributors);
  const p = q.percentile;
  return {
    selection,
    by,
    name: value,
    merged: slice.pair("merged", window, p),
    cycle: slice.pair("cycle", window, p),
    pickup: slice.pair("pickup", window, p),
    review: slice.pair("review", window, p),
    repushed: slice.value("repushed", window.current, p),
    open: slice.open().length,
    cycleSeries: slice.series("cycle", window, p),
  };
}
