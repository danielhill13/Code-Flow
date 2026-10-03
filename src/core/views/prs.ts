// The PRs behind a number. Every number in the report opens this list already filtered, and the
// filters test PRs with the same functions the metrics use (prValue, inPeriod, the bands), so a
// list holds exactly the PRs its number rests on. Filtering and sorting are not aggregation.
import { prValue } from "../aggregate.ts";
import type { OpenState, PrFact } from "../facts.ts";
import { metricOf } from "../metrics.ts";
import { inPeriod } from "../periods.ts";
import { byContributors, type Contributors, type Selection, selects } from "../selection.ts";
import type { ViewContext } from "./context.ts";
import { AGE_BANDS, ageDays, inAgeBand, OPEN_STATES } from "./flow.ts";
import { inBand, SIZE_BANDS, type SizeBand } from "./speed.ts";

/** Which PRs a list holds: merged, still open, or closed without merging. */
export type PrSet = "merged" | "open" | "abandoned";

export const PR_SETS: readonly PrSet[] = ["merged", "open", "abandoned"];

/** One narrowing of a list. Each is shown as a chip the reader can remove. */
export type PrFilter =
  /** Merged (or closed, or opened, by the list's set) within a span. */
  | { kind: "span"; start: string; end: string; label: string }
  /** PRs a metric has a value for, such as reviewed PRs for pickup. */
  | { kind: "applies"; metric: string }
  /** PRs a share metric says yes (or no) to, such as reverted ones. */
  | { kind: "is"; metric: string; value: boolean }
  | { kind: "size"; band: SizeBand["key"] }
  | { kind: "age"; band: string }
  | { kind: "state"; state: OpenState }
  /** Open PRs nobody has reviewed yet that ask this person for a review. */
  | { kind: "waiting"; reviewer: string };

export type PrColumn =
  | "number"
  | "title"
  | "author"
  | "merged"
  | "closed"
  | "age"
  | "cycle"
  | "coding"
  | "pickup"
  | "review"
  | "mergeWait"
  | "timeToApproval"
  | "size"
  | "reviews"
  | "state";

export type PrSort = { key: PrColumn; dir: "asc" | "desc" };

export type PrQuery = {
  selection: Selection;
  contributors: Contributors;
  set: PrSet;
  filters: PrFilter[];
  sort: PrSort;
  /** Rows to return, from the top. */
  limit: number;
};

export type PrListModel = { total: number; rows: PrFact[] };

/** The columns each set shows, in order. */
export const COLUMNS: Record<PrSet, readonly PrColumn[]> = {
  merged: [
    "number",
    "title",
    "author",
    "merged",
    "cycle",
    "coding",
    "pickup",
    "review",
    "mergeWait",
    "size",
    "reviews",
  ],
  open: ["number", "title", "author", "age", "state", "size", "reviews"],
  abandoned: ["number", "title", "author", "closed", "age", "size", "reviews"],
};

/** The order a set opens in when nothing else is asked for. */
export const DEFAULT_SORT: Record<PrSet, PrSort> = {
  merged: { key: "merged", dir: "desc" },
  open: { key: "age", dir: "desc" },
  abandoned: { key: "closed", dir: "desc" },
};

export function prList(ctx: ViewContext, q: PrQuery): PrListModel {
  const test = prTest(ctx, q);
  const value = (pr: PrFact) => sortValue(q.sort.key, pr, ctx.asOf);
  const dir = q.sort.dir === "asc" ? 1 : -1;
  const rows = ctx.facts.filter(test).sort((a, b) => {
    const x = value(a);
    const y = value(b);
    // Missing values go last whichever way the list is sorted (rule 4).
    if (x === null || y === null) return x === y ? b.number - a.number : x === null ? 1 : -1;
    const order = typeof x === "string" ? x.localeCompare(String(y)) : x - Number(y);
    return order * dir || b.number - a.number;
  });
  return { total: rows.length, rows: rows.slice(0, q.limit) };
}

/** A test for the PRs a query keeps. */
export function prTest(
  ctx: ViewContext,
  q: Omit<PrQuery, "sort" | "limit">,
): (pr: PrFact) => boolean {
  const scoped = selects(q.selection);
  const kept = byContributors(q.contributors);
  const tests = q.filters.map((filter) => filterTest(ctx, q.set, filter));
  return (pr) =>
    pr.counted && pr.state === STATE[q.set] && scoped(pr) && kept(pr) && tests.every((t) => t(pr));
}

const STATE = { merged: "merged", open: "open", abandoned: "closed" } as const;

function filterTest(ctx: ViewContext, set: PrSet, filter: PrFilter): (pr: PrFact) => boolean {
  const metricCtx = { asOf: ctx.asOf };
  switch (filter.kind) {
    case "span":
      return (pr) =>
        inPeriod(
          filter,
          set === "merged" ? pr.mergedAt : set === "open" ? pr.createdAt : pr.closedAt,
        );
    case "applies": {
      const metric = metricOf(filter.metric);
      return (pr) => prValue(metric, pr, metricCtx) !== null;
    }
    case "is": {
      const metric = metricOf(filter.metric);
      return (pr) => prValue(metric, pr, metricCtx) === filter.value;
    }
    case "size": {
      const band = SIZE_BANDS.find((b) => b.key === filter.band);
      return (pr) => band !== undefined && inBand(band, pr.sizeLines);
    }
    case "age": {
      const band = AGE_BANDS.find((b) => b.key === filter.band);
      return (pr) => band !== undefined && inAgeBand(band, ageDays(pr, ctx.asOf));
    }
    case "state":
      return (pr) => pr.openState === filter.state;
    case "waiting":
      return (pr) =>
        pr.openState === "waiting" &&
        pr.waitingOn?.on === "reviewers" &&
        pr.waitingOn.people.some((login) => login.toLowerCase() === filter.reviewer.toLowerCase());
  }
}

function sortValue(key: PrColumn, pr: PrFact, asOf: Date): number | string | null {
  switch (key) {
    case "number":
      return pr.number;
    case "title":
      return pr.title;
    case "author":
      return pr.author;
    case "merged":
      return pr.mergedAt;
    case "closed":
      return pr.closedAt;
    case "age":
      return pr.state === "open"
        ? ageDays(pr, asOf)
        : pr.closedAt
          ? (Date.parse(pr.closedAt) - Date.parse(pr.createdAt)) / 86_400_000
          : null;
    case "cycle":
      return pr.cycleHours;
    case "coding":
      return pr.codingHours;
    case "pickup":
      return pr.pickupHours;
    case "review":
      return pr.reviewHours;
    case "mergeWait":
      return pr.mergeWaitHours;
    case "timeToApproval":
      return pr.timeToApprovalHours;
    case "size":
      return pr.sizeLines;
    case "reviews":
      return pr.reviews;
    case "state":
      return pr.openState === null ? null : OPEN_STATES.indexOf(pr.openState);
  }
}

/** How a filter reads on its chip. */
export function filterLabel(filter: PrFilter, set: PrSet): string {
  switch (filter.kind) {
    case "span":
      return `${set === "merged" ? "Merged" : set === "open" ? "Opened" : "Closed"} · ${filter.label}`;
    case "applies": {
      const metric = metricOf(filter.metric);
      return metric.subset ?? metric.label;
    }
    case "is": {
      const label = metricOf(filter.metric).label;
      return filter.value ? label : `Not ${label.toLowerCase()}`;
    }
    case "size":
      return `Size ${SIZE_BANDS.find((b) => b.key === filter.band)?.label ?? filter.band}`;
    case "age":
      return `Open ${AGE_BANDS.find((b) => b.key === filter.band)?.label.toLowerCase() ?? filter.band}`;
    case "state":
      return OPEN_STATE_LABELS[filter.state];
    case "waiting":
      return `Waiting on ${filter.reviewer}`;
  }
}

export const OPEN_STATE_LABELS: Record<OpenState, string> = {
  draft: "Draft",
  waiting: "Waiting for review",
  in_review: "In review",
  approved: "Approved",
};

/** A PR for the side panel. */
export function prDetail(ctx: ViewContext, id: string): PrFact | null {
  return ctx.facts.find((fact) => fact.id === id) ?? null;
}
