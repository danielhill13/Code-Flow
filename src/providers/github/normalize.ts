import type {
  Actor,
  Comment,
  Commit,
  PrEvent,
  PrModel,
  PrState,
  Review,
  ReviewState,
  Truncatable,
} from "../../core/model.ts";

type GhActor = { __typename: string; login: string } | null;

type GhConnection<T> = {
  totalCount: number;
  /** Timeline only: the count after the itemTypes filter, which totalCount ignores. */
  filteredCount?: number;
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
};

type GhTimelineItem = {
  __typename: string;
  createdAt?: string;
  requestedReviewer?: { __typename: string; login?: string; slug?: string } | null;
  previousRefName?: string;
  currentRefName?: string;
};

/** A pull request exactly as PR_PAGE returns it and the store keeps it. */
export type GhPayload = {
  id: string;
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  isCrossRepository: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  author: GhActor;
  authorAssociation: string | null;
  mergedBy: GhActor;
  mergeCommit: { oid: string } | null;
  labels: { nodes: { name: string }[] } | null;
  reviewThreads: { totalCount: number } | null;
  commits: GhConnection<{
    commit: { oid: string; authoredDate: string; committedDate: string; message: string };
  }>;
  reviews: GhConnection<{
    author: GhActor;
    state: string;
    submittedAt: string | null;
    body: string | null;
  }>;
  comments: GhConnection<{ author: GhActor; createdAt: string; body: string | null }>;
  /** Null when GitHub declines to list a diff's files. */
  files: GhConnection<{ path: string; additions: number; deletions: number }> | null;
  timelineItems: GhConnection<GhTimelineItem>;
};

const STATES: Record<GhPayload["state"], PrState> = {
  OPEN: "open",
  MERGED: "merged",
  CLOSED: "closed",
};

const REVIEW_STATES: Record<string, ReviewState> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
  PENDING: "pending",
};

/** Maps a stored GitHub payload to the neutral model. */
export function normalizePr(raw: GhPayload, repo: { id: string; fullName: string }): PrModel {
  const truncated: Truncatable[] = [];
  const check = (name: Truncatable, connection: GhConnection<unknown> | null) => {
    if (connection === null) return truncated.push(name);
    const expected =
      name === "events"
        ? (connection.filteredCount ?? connection.nodes.length)
        : connection.totalCount;
    if (connection.nodes.length < expected) truncated.push(name);
  };
  check("commits", raw.commits);
  check("reviews", raw.reviews);
  check("comments", raw.comments);
  check("files", raw.files);
  check("events", raw.timelineItems);

  return {
    id: raw.id,
    repoId: repo.id,
    repo: repo.fullName,
    number: raw.number,
    url: raw.url,
    title: raw.title,
    body: raw.body ?? "",
    state: STATES[raw.state],
    draft: raw.isDraft,
    author: actor(raw.author),
    authorAssociation: raw.authorAssociation,
    fromFork: raw.isCrossRepository,
    baseBranch: raw.baseRefName,
    headBranch: raw.headRefName,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    mergedAt: raw.mergedAt,
    closedAt: raw.closedAt,
    mergedBy: actor(raw.mergedBy),
    mergeCommitSha: raw.mergeCommit?.oid ?? null,
    labels: raw.labels?.nodes.map((label) => label.name) ?? [],
    commits: raw.commits.nodes.map(
      ({ commit }): Commit => ({
        sha: commit.oid,
        authoredAt: commit.authoredDate,
        committedAt: commit.committedDate,
        message: commit.message,
      }),
    ),
    reviews: raw.reviews.nodes.map(
      (review): Review => ({
        author: actor(review.author),
        state: REVIEW_STATES[review.state] ?? "commented",
        at: review.submittedAt,
        body: review.body ?? "",
      }),
    ),
    comments: raw.comments.nodes.map(
      (comment): Comment => ({
        author: actor(comment.author),
        at: comment.createdAt,
        body: comment.body ?? "",
      }),
    ),
    reviewThreads: raw.reviewThreads?.totalCount ?? 0,
    files: (raw.files?.nodes ?? []).map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
    })),
    events: raw.timelineItems.nodes.flatMap((item) => event(item)),
    additions: raw.additions,
    deletions: raw.deletions,
    truncated,
  };
}

function actor(raw: GhActor): Actor | null {
  return raw ? { login: raw.login, bot: raw.__typename === "Bot" } : null;
}

function event(item: GhTimelineItem): PrEvent[] {
  const at = item.createdAt;
  if (!at) return [];
  switch (item.__typename) {
    case "ReadyForReviewEvent":
      return [{ type: "ready_for_review", at }];
    case "ConvertToDraftEvent":
      return [{ type: "converted_to_draft", at }];
    case "HeadRefForcePushedEvent":
      return [{ type: "force_pushed", at }];
    case "ClosedEvent":
      return [{ type: "closed", at }];
    case "ReopenedEvent":
      return [{ type: "reopened", at }];
    case "MergedEvent":
      return [{ type: "merged", at }];
    case "ReviewRequestedEvent": {
      const reviewer = item.requestedReviewer;
      return [
        { type: "review_requested", at, reviewer: reviewer?.login ?? reviewer?.slug ?? null },
      ];
    }
    case "BaseRefChangedEvent":
      return [
        {
          type: "base_changed",
          at,
          from: item.previousRefName ?? "",
          to: item.currentRefName ?? "",
        },
      ];
    default:
      return [];
  }
}
