/**
 * The provider-neutral pull request. Each provider maps its raw payloads into this shape, and
 * everything from here on (facts, metrics, the report) knows nothing about where a PR came from.
 * Timestamps are ISO 8601 strings in UTC.
 */

export type Actor = {
  login: string;
  /** The provider says this account is an app or bot. Config can name more bots. */
  bot: boolean;
  /** The name the provider shows, where it gives one (Azure DevOps does; GitHub's isn't read). */
  name?: string | null;
};

export type PrState = "open" | "merged" | "closed";

export type ReviewState = "approved" | "changes_requested" | "commented" | "dismissed" | "pending";

export type Review = {
  /** Null when the account has been deleted. */
  author: Actor | null;
  state: ReviewState;
  /** Null for a review not yet submitted. */
  at: string | null;
  body: string;
};

export type Comment = { author: Actor | null; at: string; body: string };

export type Commit = {
  sha: string;
  authoredAt: string;
  committedAt: string;
  message: string;
  /** Lines the commit added and deleted, every file; absent where the host doesn't say. */
  additions?: number;
  deletions?: number;
  /** How many parents: more than one is a merge, such as the target branch merged in. */
  parents?: number;
};

export type ChangedFile = { path: string; additions: number; deletions: number };

/** Who a review was requested from: a person or bot (by login), or a team (by its slug). */
export type RequestedReviewer = Actor & { team: boolean };

export type PrEvent =
  | { type: "ready_for_review" | "converted_to_draft" | "force_pushed"; at: string }
  | { type: "closed" | "reopened" | "merged"; at: string }
  /** `reviewer` is null when the account or team no longer exists. */
  | { type: "review_requested"; at: string; reviewer: RequestedReviewer | null }
  | { type: "base_changed"; at: string; from: string; to: string };

/** Lists the provider returned only part of: the PR has more than it was willing to send. */
export type Truncatable = "commits" | "reviews" | "comments" | "files" | "events";

export type PrModel = {
  /** The provider's id for the PR: unique across repos. */
  id: string;
  repoId: string;
  /** owner/name */
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: PrState;
  /** Currently a draft. */
  draft: boolean;
  /** Null when the account has been deleted. */
  author: Actor | null;
  /** The author's relationship to the repo, as the provider reports it (e.g. MEMBER). */
  authorAssociation: string | null;
  /** Opened from a fork rather than a branch of the repo itself. */
  fromFork: boolean;
  baseBranch: string;
  headBranch: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  mergedBy: Actor | null;
  mergeCommitSha: string | null;
  labels: string[];
  /** Oldest first. */
  commits: Commit[];
  reviews: Review[];
  /** Conversation comments, not the comments inside reviews. */
  comments: Comment[];
  /** Inline review threads. Only their number is known (see decision D12). */
  reviewThreads: number;
  files: ChangedFile[];
  events: PrEvent[];
  /** The provider's own line totals, which count every file. */
  additions: number;
  deletions: number;
  truncated: Truncatable[];
};
