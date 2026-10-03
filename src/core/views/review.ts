// Review: is review the bottleneck, is its load on a few people, how often does work go round
// again. Names appear only inside a team or repo, and only as capacity: who carries review and
// who is waited on. There is no author output anywhere (rule 10, decision D21).
import type { MetricValue } from "../aggregate.ts";
import type { PrFact } from "../facts.ts";
import { inPeriod, type Span } from "../periods.ts";
import { type Dimension, isEverything, narrow, type Selection } from "../selection.ts";
import { percentileStat, type Stat } from "../stats.ts";
import {
  type Pair,
  Slice,
  type Tile,
  type ViewContext,
  type ViewQuery,
  type WindowView,
  windowView,
} from "./context.ts";

/** One reviewer's share of the window's review work. */
export type ReviewerLoad = {
  login: string;
  /** Review submissions in the window. */
  reviews: number;
  share: number;
  /** Open PRs nobody has reviewed yet that ask this person for a review. */
  waiting: number;
  /** Their first response to the PRs they first reviewed in the window (see PrFact.responses). */
  response: Stat;
};

export type ReviewLoad = {
  /** Review submissions in the window, on the selection's PRs. */
  reviews: number;
  /** People who submitted at least one. */
  reviewers: number;
  /** The share of reviews by the two busiest reviewers; null with fewer than three reviewers. */
  topTwo: number | null;
};

export type ReviewTeamRow = ReviewLoad & {
  selection: Selection;
  dimension: Dimension;
  name: string;
  pickup: Pair;
  reviewsPerPr: Pair;
};

export type ReviewModel = {
  window: WindowView;
  /** Pickup, review time, reviews per PR, re-pushed after review, reviewed before merge. */
  tiles: Tile[];
  approved: MetricValue;
  /** Merged in the window without any review. */
  unreviewed: number;
  load: ReviewLoad;
  /** At the top level: one row per team (or repo), with no names. */
  teams: ReviewTeamRow[];
  /** Inside a team or repo: the reviewers, busiest first; the rest grouped as `others`. */
  reviewers: ReviewerLoad[];
  others: { count: number; reviews: number; share: number; waiting: number } | null;
  /** Re-pushed after review, commented, reverted: what happened after review. */
  after: Tile[];
};

/** Reviewers listed by name before the rest are grouped. */
export const REVIEWER_ROWS = 7;

export const REVIEW_TILES = ["pickup", "review", "reviewsPerPr", "repushed", "reviewed"] as const;
export const AFTER_TILES = ["repushed", "commented", "reverted"] as const;

export function review(ctx: ViewContext, q: ViewQuery): ReviewModel {
  const window = windowView(ctx, q.window);
  const slice = new Slice(ctx, q.selection, q.contributors);
  const p = q.percentile;
  const merged = slice.groups(window.current).merged;
  const counts = reviewCounts(slice.facts, window.current);
  // With nothing selected, review load reads one row per team (or product, or repo); once the
  // selection narrows, it names the reviewers (decision D21).
  const by = isEverything(q.selection) ? q.by : null;
  const values = by ? slice.values(by) : [];
  const breakdown = by !== null && values.length > 1;

  let reviewers: ReviewerLoad[] = [];
  let others: ReviewModel["others"] = null;
  if (!breakdown) {
    const total = sum(counts.values());
    const waiting = waitingCounts(slice.open());
    const responses = firstResponses(slice.facts, window.current);
    const people = new Set([...counts.keys(), ...waiting.keys()]);
    const rows = [...people]
      .map((login) => ({
        login,
        reviews: counts.get(login) ?? 0,
        share: total > 0 ? (counts.get(login) ?? 0) / total : 0,
        waiting: waiting.get(login)?.size ?? 0,
        response: percentileStat(responses.get(login) ?? [], p),
      }))
      .sort(
        (a, b) => b.reviews - a.reviews || b.waiting - a.waiting || a.login.localeCompare(b.login),
      );
    reviewers = rows.slice(0, REVIEWER_ROWS);
    const rest = rows.slice(REVIEWER_ROWS);
    if (rest.length > 0) {
      const reviews = sum(rest.map((r) => r.reviews));
      others = {
        count: rest.length,
        reviews,
        share: total > 0 ? reviews / total : 0,
        // A PR can ask several of them: count it once.
        waiting: new Set(rest.flatMap((r) => [...(waiting.get(r.login) ?? [])])).size,
      };
    }
  }

  return {
    window,
    tiles: REVIEW_TILES.map((key) => slice.tile(key, window, p)),
    approved: slice.value("approved", window.current, p),
    unreviewed: merged.filter((pr) => !pr.reviewed).length,
    load: load(counts),
    teams: breakdown
      ? values.map((value) => {
          const selection = narrow(q.selection, by, value);
          const child = new Slice(ctx, selection, q.contributors);
          return {
            selection,
            dimension: by,
            name: value,
            ...load(reviewCounts(child.facts, window.current)),
            pickup: child.pair("pickup", window, p),
            reviewsPerPr: child.pair("reviewsPerPr", window, p),
          };
        })
      : [],
    reviewers,
    others,
    after: AFTER_TILES.map((key) => slice.tile(key, window, p)),
  };
}

/** Review submissions in the span, per reviewer, on counted PRs of any state. */
export function reviewCounts(facts: readonly PrFact[], span: Span): Map<string, number> {
  const counts = new Map<string, number>();
  for (const pr of facts) {
    if (!pr.counted) continue;
    for (const entry of pr.reviewLog) {
      if (inPeriod(span, entry.at)) counts.set(entry.by, (counts.get(entry.by) ?? 0) + 1);
    }
  }
  return counts;
}

export function load(counts: ReadonlyMap<string, number>): ReviewLoad {
  const sorted = [...counts.values()].sort((a, b) => b - a);
  const reviews = sum(sorted);
  return {
    reviews,
    reviewers: sorted.length,
    topTwo:
      sorted.length >= 3 && reviews > 0 ? ((sorted[0] ?? 0) + (sorted[1] ?? 0)) / reviews : null,
  };
}

/** Open PRs no one has reviewed yet, by id, per person they ask for a review. */
function waitingCounts(open: readonly PrFact[]): Map<string, Set<string>> {
  const waiting = new Map<string, Set<string>>();
  for (const pr of open) {
    if (pr.openState !== "waiting" || pr.waitingOn?.on !== "reviewers") continue;
    for (const login of pr.waitingOn.people) {
      const ids = waiting.get(login);
      if (ids) ids.add(pr.id);
      else waiting.set(login, new Set([pr.id]));
    }
  }
  return waiting;
}

/** Each reviewer's first-response hours, on the PRs whose first review by them fell in the span. */
function firstResponses(facts: readonly PrFact[], span: Span): Map<string, number[]> {
  const hours = new Map<string, number[]>();
  for (const pr of facts) {
    if (!pr.counted) continue;
    for (const response of pr.responses) {
      const first = pr.reviewLog.find((entry) => entry.by === response.by);
      if (!first || !inPeriod(span, first.at)) continue;
      const list = hours.get(response.by);
      if (list) list.push(response.hours);
      else hours.set(response.by, [response.hours]);
    }
  }
  return hours;
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
