// AI insights: how much of the work shows an AI tool's traces, who uses them, which traces, where,
// and how AI-assisted PRs compare with the rest (decision D57). The share is a registry metric
// (aiAssisted); the rest are counts of the same merged, counted PRs every metric uses.

import type { MetricValue } from "../aggregate.ts";
import { AI_MARKERS, type AiMarker, type AiTool, toolsOf } from "../ai.ts";
import type { PrFact } from "../facts.ts";
import { isComplete, type Span } from "../periods.ts";
import { type Bucket, bucketsOf, covers, type WindowKey, windowOf } from "../windows.ts";
import type { PeriodView } from "./compare.ts";
import {
  Slice,
  type Tile,
  type ViewContext,
  type ViewQuery,
  type WindowView,
  windowView,
} from "./context.ts";

export type AiQuery = ViewQuery & {
  /** The periods the impact table compares; empty: the window and the one before it. */
  periods?: WindowKey[];
};

/** People with a counted PR merged in a span, and those of them with an AI-assisted one. */
export type PeopleShare = { people: number; using: number; share: number | null };

export type AdoptionCell = { merged: number; ai: number; share: number | null };

export type AdoptionRow = {
  repo: string;
  /** One per month; null where the data doesn't reach. */
  cells: (AdoptionCell | null)[];
};

/** A metric over AI-assisted PRs and over the rest, in one period. */
export type ImpactCell = { ai: MetricValue; none: MetricValue };

export type AiModel = {
  window: WindowView;
  /** The share of merged PRs that are AI-assisted, with its trend. */
  share: Tile;
  /** AI-assisted PRs merged in the window, and in the one before (null if not covered). */
  assisted: { value: number; previous: number | null };
  people: PeopleShare & {
    previous: PeopleShare | null;
    series: { bucket: WindowView["buckets"][number]; value: PeopleShare | null }[];
  };
  /** Merged PRs AI-assisted and not, for each point of the trend; null before the data. */
  trend: {
    bucket: WindowView["buckets"][number];
    counts: { ai: number; none: number } | null;
  }[];
  /** Each marker: merged PRs that show it, and those it alone marks. */
  markers: { marker: AiMarker; prs: number; only: number }[];
  tools: { tool: AiTool; prs: number }[];
  /** Merged PRs by how many markers they show: 0, 1, 2, 3 or more. */
  depth: { markers: number; prs: number }[];
  adoption: {
    months: (Bucket & { covered: boolean })[];
    rows: AdoptionRow[];
    total: (AdoptionCell | null)[];
    /** Repos left out of the table: those with the fewest merged PRs. */
    more: number;
  };
  impact: { periods: PeriodView[]; rows: { key: string; cells: ImpactCell[] }[] };
  /** Merged PRs in the window whose markers can't all be seen: lists the host cut short. */
  partial: number;
};

/** The metrics the impact table weighs, in order. */
export const IMPACT_METRICS = [
  "merged",
  "cycle",
  "pickup",
  "review",
  "size",
  "reviewed",
  "repushed",
  "reverted",
  "touchedAgain",
  "followUp",
  "rewritten",
] as const;

/** The adoption table shows at least this many months, and at most this many repos. */
export const ADOPTION_MONTHS = 6;
export const ADOPTION_REPOS = 30;

const assisted = (pr: PrFact) => pr.ai.length > 0;

export function ai(ctx: ViewContext, q: AiQuery): AiModel {
  const window = windowView(ctx, q.window);
  const slice = new Slice(ctx, q.selection, q.contributors);
  const p = q.percentile;
  const merged = slice.groups(window.current).merged;

  const people = (span: Span): PeopleShare | null => {
    if (!covers(ctx.coveredFrom, span)) return null;
    const humans = slice.groups(span).merged.filter((pr) => !pr.authorIsBot);
    const all = new Set(humans.map((pr) => pr.person));
    const using = new Set(humans.filter(assisted).map((pr) => pr.person));
    return { people: all.size, using: using.size, share: all.size ? using.size / all.size : null };
  };
  const count = (span: Span) =>
    covers(ctx.coveredFrom, span) ? slice.groups(span).merged.filter(assisted).length : null;

  const markers = AI_MARKERS.map((marker) => {
    const showing = merged.filter((pr) => pr.ai.some((sign) => sign.marker === marker));
    return { marker, prs: showing.length, only: showing.filter((pr) => pr.ai.length === 1).length };
  }).filter((row) => row.prs > 0 || row.marker !== "custom");

  const tools = new Map<AiTool, number>();
  for (const pr of merged) {
    for (const tool of toolsOf(pr.ai)) tools.set(tool, (tools.get(tool) ?? 0) + 1);
  }

  const depth = [0, 1, 2, 3].map((markers) => ({
    markers,
    prs: merged.filter((pr) => (markers === 3 ? pr.ai.length >= 3 : pr.ai.length === markers))
      .length,
  }));

  return {
    window,
    share: slice.tile("aiAssisted", window, p),
    assisted: { value: count(window.current) ?? 0, previous: count(window.previous) },
    people: {
      ...(people(window.current) ?? { people: 0, using: 0, share: null }),
      previous: people(window.previous),
      series: window.buckets.map((bucket) => ({ bucket, value: people(bucket) })),
    },
    trend: window.buckets.map((bucket) => {
      if (!bucket.covered) return { bucket, counts: null };
      const prs = slice.groups(bucket).merged;
      const n = prs.filter(assisted).length;
      return { bucket, counts: { ai: n, none: prs.length - n } };
    }),
    markers,
    tools: [...tools]
      .map(([tool, prs]) => ({ tool, prs }))
      .sort((a, b) => b.prs - a.prs || a.tool.localeCompare(b.tool)),
    depth,
    adoption: adoption(ctx, slice, window),
    impact: impact(ctx, slice, q, window, p),
    partial: merged.filter(
      (pr) => pr.truncated.includes("files") || pr.truncated.includes("commits"),
    ).length,
  };
}

/** Each repo's AI-assisted share, month by month, over at least the last six months. */
function adoption(ctx: ViewContext, slice: Slice, window: WindowView): AiModel["adoption"] {
  const end = new Date(window.current.end);
  const sixBack = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (ADOPTION_MONTHS - 1), 1),
  ).toISOString();
  const start = window.current.start < sixBack ? window.current.start : sixBack;
  // Six months or more is always cut by calendar month (windows.ts, grainOf).
  const months = bucketsOf({
    key: "months",
    current: { start, end: window.current.end, label: "" },
    previous: { start, end: start, label: "" },
  });
  const covered = months.map((month) => ({ ...month, covered: covers(ctx.coveredFrom, month) }));

  const cell = (prs: readonly PrFact[]): AdoptionCell => {
    const ai = prs.filter(assisted).length;
    return { merged: prs.length, ai, share: prs.length ? ai / prs.length : null };
  };
  const repos = new Map<string, { total: number; cells: (AdoptionCell | null)[] }>();
  const total = covered.map((month, i) => {
    if (!month.covered) return null;
    const prs = slice.groups(month).merged;
    const byRepo = new Map<string, PrFact[]>();
    for (const pr of prs) byRepo.set(pr.repo, [...(byRepo.get(pr.repo) ?? []), pr]);
    for (const [repo, its] of byRepo) {
      let row = repos.get(repo);
      if (!row) {
        row = { total: 0, cells: covered.map((m) => (m.covered ? cell([]) : null)) };
        repos.set(repo, row);
      }
      row.total += its.length;
      row.cells[i] = cell(its);
    }
    return cell(prs);
  });
  const rows = [...repos]
    .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
    .map(([repo, row]) => ({ repo, cells: row.cells }));
  return {
    months: covered,
    rows: rows.slice(0, ADOPTION_REPOS),
    total,
    more: Math.max(0, rows.length - ADOPTION_REPOS),
  };
}

/** Each impact metric over AI-assisted PRs and the rest, for each period compared. */
function impact(
  ctx: ViewContext,
  slice: Slice,
  q: AiQuery,
  window: WindowView,
  p: number,
): AiModel["impact"] {
  const spans: Span[] =
    q.periods && q.periods.length > 0
      ? q.periods
          .map((key) => windowOf(key, ctx.asOf).current)
          .sort((a, b) => a.start.localeCompare(b.start))
      : [window.previous, window.current];
  return {
    periods: spans.map((span) => ({
      ...span,
      complete: isComplete(span, ctx.asOf),
      covered: covers(ctx.coveredFrom, span),
    })),
    rows: IMPACT_METRICS.map((key) => ({
      key,
      cells: spans.map((span) => ({
        ai: slice.valueWhere(key, span, p, assisted),
        none: slice.valueWhere(key, span, p, (pr) => !assisted(pr)),
      })),
    })),
  };
}
