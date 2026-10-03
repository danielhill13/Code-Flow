import type { PrState, Truncatable } from "./model.ts";
import type { Bucket } from "./paths.ts";

/**
 * Bump whenever derive's logic changes what a fact holds: every repo's facts are then derived
 * again on the next run, without fetching anything.
 */
export const DERIVE_VERSION = 1;

/**
 * Why a PR is not counted in flow metrics:
 * - `bot`: a bot opened it (config can include bot PRs);
 * - `base`: it targets a branch that is not measured, such as a feature branch (stacked work);
 * - `promotion`: its head is a long-lived branch of the same repo, so it moves work that was
 *   already counted when it first landed (a promotion or back-merge).
 */
export type Exclusion = "bot" | "base" | "promotion";

/**
 * Everything the metrics need about one PR, derived from its newest raw version alone (plus
 * revert links, which look across the repo). Times are ISO 8601 in UTC; durations are hours.
 * Null always means "does not apply" or "unknown", never zero.
 */
export type PrFact = {
  id: string;
  repoId: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  /** "ghost" when the account has been deleted. */
  author: string;
  authorIsBot: boolean;
  authorAssociation: string | null;
  fromFork: boolean;
  state: PrState;
  draft: boolean;
  baseBranch: string;
  headBranch: string;
  labels: string[];

  /** Counted in flow metrics. When false, `exclusion` says why. */
  counted: boolean;
  exclusion: Exclusion | null;

  // The timeline. Reviews and comments after a PR merged or closed do not count toward it.
  createdAt: string;
  /** The first commit, or the PR's creation if that is earlier. */
  startAt: string;
  firstCommitAt: string | null;
  /** Creation, or the first ready-for-review event if it opened as a draft. Null while a draft. */
  readyAt: string | null;
  firstReviewAt: string | null;
  firstApprovalAt: string | null;
  /** When review concluded: the last approval, or else the last review. */
  reviewEndAt: string | null;
  mergedAt: string | null;
  closedAt: string | null;

  // Phases of a merged PR. They add up exactly to cycleHours (counting null as 0); pickup and
  // review are null when nobody reviewed it.
  cycleHours: number | null;
  codingHours: number | null;
  pickupHours: number | null;
  reviewHours: number | null;
  mergeWaitHours: number | null;
  /** From ready to the first approval. */
  timeToApprovalHours: number | null;

  // Size, from the changed files. Null when the provider did not list every file.
  /** Product lines added plus deleted. */
  sizeLines: number | null;
  /** Product lines added. */
  addedLines: number | null;
  productFiles: number | null;
  linesByBucket: Record<Bucket, number> | null;

  // Review by people other than the author (bots only when config names them as reviewers).
  reviewers: string[];
  /** Review submissions: each approval, change request or comment-review counts once. */
  reviews: number;
  approvals: number;
  changesRequested: number;
  reviewed: boolean;
  approved: boolean;
  /** The author merged it. */
  selfMerged: boolean;
  /** Conversation comments by people other than the author. */
  comments: number;
  /** Inline review threads, by anyone, bots included. For display only (decision D13). */
  reviewThreads: number;
  /** Times new commits arrived after a review: each one starts another round. */
  rounds: number;

  // Reverts, linked across the repo. Only merged PRs revert, and only merged PRs are reverted.
  /** Numbers of the PRs this one reverts. */
  reverts: number[];
  revertedBy: number | null;
  revertedAt: string | null;

  /** Lists the provider cut short; values that depend on them are less certain. */
  truncated: Truncatable[];
};
