// Where things lead. Every number opens the list of PRs behind it (rule 8), built from the same
// filters the core uses, so the list's count is the number's n.
import { metricOf } from "../core/metrics.ts";
import type { Span } from "../core/periods.ts";
import type { Selection } from "../core/selection.ts";
import type { PrColumn, PrFilter, PrSet } from "../core/views/prs.ts";
import { DEFAULT_SORT } from "../core/views/prs.ts";
import { type ListState, type ReportState, type Tab, writeState } from "./state.ts";

/** The column a metric's PRs are sorted by, largest first. */
const SORT_BY: Record<string, PrColumn> = {
  cycle: "cycle",
  coding: "coding",
  pickup: "pickup",
  review: "review",
  mergeWait: "mergeWait",
  timeToApproval: "timeToApproval",
  merged: "merged",
  size: "size",
  linesMerged: "size",
  reviewed: "reviews",
  approved: "reviews",
  reviewsPerPr: "reviews",
  commented: "merged",
  repushed: "merged",
  reverted: "merged",
  abandoned: "closed",
};

/** Shares whose interesting PRs are the ones it says yes to: the reverted, the re-pushed. */
const YES_FIRST = new Set(["commented", "repushed", "reverted"]);

/**
 * The PRs behind a metric's value over a span: its population, narrowed to the PRs it has a
 * value for, and for a share like reverts, to the PRs it counts.
 */
export function metricList(
  key: string,
  span: Span,
  from: string,
  extra: PrFilter[] = [],
): ListState {
  const metric = metricOf(key);
  const set: PrSet = key === "abandoned" ? "abandoned" : "merged";
  const filters: PrFilter[] = [{ kind: "span", ...span }];
  if (metric.subset) filters.push({ kind: "applies", metric: key });
  if (YES_FIRST.has(key)) filters.push({ kind: "is", metric: key, value: true });
  return {
    from,
    set,
    filters: [...filters, ...extra],
    sort: { key: SORT_BY[key] ?? "merged", dir: "desc" },
  };
}

/** A list of PRs by set, with any filters. */
export function setList(set: PrSet, from: string, filters: PrFilter[] = []): ListState {
  return { from, set, filters, sort: DEFAULT_SORT[set] };
}

export const listHref = (state: ReportState, list: ListState) =>
  writeState({ ...state, tab: "prs", list, pr: null });

export const tabHref = (state: ReportState, tab: Tab) => writeState({ ...state, tab, pr: null });

/** Another selection: its breakdown starts from its own default. */
export const selectionHref = (state: ReportState, selection: Selection) =>
  writeState({ ...state, selection, by: null, pr: null });

export const prHref = (state: ReportState, id: string) => writeState({ ...state, pr: id });
