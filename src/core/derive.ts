import type { Exclusion, PrFact } from "./facts.ts";
import type { Actor, Comment, PrModel, Review } from "./model.ts";
import { BUCKETS, type Bucket } from "./paths.ts";

/** The configurable judgments derive needs, already resolved for the repo at hand. */
export type DeriveRules = {
  /** PRs into this branch count (normally just the repo's default branch). */
  isMeasuredBranch: (repo: string, branch: string) => boolean;
  /** A long-lived branch name: a same-repo PR from it is a promotion or back-merge. */
  isPromotionBranch: (branch: string) => boolean;
  classify: (repo: string, path: string) => Bucket;
  /** A bot, as the provider reports it or as config names it. */
  isBot: (actor: Actor) => boolean;
  /** A bot whose reviews count as review anyway. */
  isBotReviewer: (actor: Actor) => boolean;
  /** Boilerplate a bot or template posts: such comments and review bodies are ignored. */
  isIgnoredBody: (body: string) => boolean;
  /** Count bot-authored PRs in flow metrics. */
  includeBotPrs: boolean;
};

/**
 * Branch names that are long-lived by convention. A PR whose head is one of these, in the same
 * repo, moves work between environments rather than adding new work. Patterns are globs.
 */
export const DEFAULT_PROMOTION_BRANCHES = [
  "main",
  "master",
  "trunk",
  "develop",
  "development",
  "dev",
  "staging",
  "stage",
  "production",
  "prod",
  "release",
  "release/*",
  "releases/*",
] as const;

const GHOST: Actor = { login: "ghost", bot: false };
const HOUR_MS = 3_600_000;

/** One PR's facts. Revert links are added afterwards by linkReverts, across the repo. */
export function derivePr(pr: PrModel, rules: DeriveRules): PrFact {
  const author = pr.author ?? GHOST;
  const authorIsBot = rules.isBot(author);
  const sameAsAuthor = (actor: Actor) => actor.login.toLowerCase() === author.login.toLowerCase();

  // Review is what happened while the PR was open: later reviews and comments don't count.
  const end = pr.mergedAt ?? pr.closedAt;
  const inTime = (at: string | null): at is string => at !== null && (end === null || at <= end);
  const byOthers = (actor: Actor | null): actor is Actor =>
    actor !== null && !sameAsAuthor(actor) && (!rules.isBot(actor) || rules.isBotReviewer(actor));

  const reviews = pr.reviews
    .filter(
      (review): review is Review & { at: string; author: Actor } =>
        review.state !== "pending" &&
        inTime(review.at) &&
        byOthers(review.author) &&
        !rules.isIgnoredBody(review.body),
    )
    .sort((a, b) => a.at.localeCompare(b.at));
  const approvals = reviews.filter((review) => review.state === "approved");
  const comments = pr.comments.filter(
    (comment: Comment) =>
      inTime(comment.at) && byOthers(comment.author) && !rules.isIgnoredBody(comment.body),
  );

  const firstCommitAt = earliest(pr.commits.map((commit) => commit.authoredAt));
  const startAt =
    firstCommitAt !== null && firstCommitAt < pr.createdAt ? firstCommitAt : pr.createdAt;
  const readyAt = readyTime(pr);
  const firstReviewAt = reviews[0]?.at ?? null;
  const firstApprovalAt = approvals[0]?.at ?? null;
  const reviewEndAt = approvals.at(-1)?.at ?? reviews.at(-1)?.at ?? null;

  return {
    id: pr.id,
    repoId: pr.repoId,
    repo: pr.repo,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    author: author.login,
    authorIsBot,
    authorAssociation: pr.authorAssociation,
    fromFork: pr.fromFork,
    state: pr.state,
    draft: pr.draft,
    baseBranch: pr.baseBranch,
    headBranch: pr.headBranch,
    labels: pr.labels,
    ...inclusion(pr, authorIsBot, rules),
    createdAt: pr.createdAt,
    startAt,
    firstCommitAt,
    readyAt,
    firstReviewAt,
    firstApprovalAt,
    reviewEndAt,
    mergedAt: pr.mergedAt,
    closedAt: pr.closedAt,
    ...phases({
      startAt,
      readyAt,
      firstReviewAt,
      reviewEndAt,
      mergedAt: pr.mergedAt,
      createdAt: pr.createdAt,
    }),
    timeToApprovalHours:
      firstApprovalAt !== null && readyAt !== null
        ? Math.max(0, hours(readyAt, firstApprovalAt))
        : null,
    ...size(pr, rules),
    reviewers: [...new Set(reviews.map((review) => review.author.login))].sort(),
    reviews: reviews.length,
    approvals: approvals.length,
    changesRequested: reviews.filter((review) => review.state === "changes_requested").length,
    reviewed: reviews.length > 0,
    approved: approvals.length > 0,
    selfMerged: pr.mergedBy !== null && sameAsAuthor(pr.mergedBy),
    comments: comments.length,
    reviewThreads: pr.reviewThreads,
    rounds: rounds(pr, reviews),
    reverts: [],
    revertedBy: null,
    revertedAt: null,
    truncated: pr.truncated,
  };
}

function inclusion(
  pr: PrModel,
  authorIsBot: boolean,
  rules: DeriveRules,
): { counted: boolean; exclusion: Exclusion | null } {
  let exclusion: Exclusion | null = null;
  if (authorIsBot && !rules.includeBotPrs) {
    exclusion = "bot";
  } else if (!rules.isMeasuredBranch(pr.repo, pr.baseBranch)) {
    exclusion = "base";
  } else if (
    // A fork's own `main` is just where a contributor worked: only the repo's own long-lived
    // branches make a promotion.
    !pr.fromFork &&
    (rules.isPromotionBranch(pr.headBranch) || rules.isMeasuredBranch(pr.repo, pr.headBranch))
  ) {
    exclusion = "promotion";
  }
  return { counted: exclusion === null, exclusion };
}

/**
 * When the PR became ready for review. A PR that opened as a draft shows a ready-for-review
 * event before any convert-to-draft event; one that opened ready, then went back to draft,
 * shows convert-to-draft first and was ready at creation.
 */
function readyTime(pr: PrModel): string | null {
  const toggles = pr.events
    .filter((event) => event.type === "ready_for_review" || event.type === "converted_to_draft")
    .sort((a, b) => a.at.localeCompare(b.at));
  const first = toggles[0];
  if (!first) return pr.draft ? null : pr.createdAt;
  return first.type === "ready_for_review" ? first.at : pr.createdAt;
}

/**
 * Splits a merged PR's cycle time at ready, first review and review end. Each boundary is held
 * between its neighbours (a review during the draft makes pickup 0, not negative), so the
 * phases always add up to the cycle time.
 */
function phases(t: {
  startAt: string;
  readyAt: string | null;
  firstReviewAt: string | null;
  reviewEndAt: string | null;
  mergedAt: string | null;
  createdAt: string;
}): Pick<PrFact, "cycleHours" | "codingHours" | "pickupHours" | "reviewHours" | "mergeWaitHours"> {
  if (t.mergedAt === null) {
    return {
      cycleHours: null,
      codingHours: null,
      pickupHours: null,
      reviewHours: null,
      mergeWaitHours: null,
    };
  }
  const merged = t.mergedAt;
  const ready = clamp(t.readyAt ?? t.createdAt, t.startAt, merged);
  const reviewed = t.firstReviewAt !== null;
  const firstReview = reviewed ? clamp(t.firstReviewAt ?? ready, ready, merged) : ready;
  const reviewEnd =
    t.reviewEndAt !== null ? clamp(t.reviewEndAt, firstReview, merged) : firstReview;
  return {
    cycleHours: hours(t.startAt, merged),
    codingHours: hours(t.startAt, ready),
    pickupHours: reviewed ? hours(ready, firstReview) : null,
    reviewHours: reviewed ? hours(firstReview, reviewEnd) : null,
    mergeWaitHours: hours(reviewEnd, merged),
  };
}

function size(
  pr: PrModel,
  rules: DeriveRules,
): Pick<PrFact, "sizeLines" | "addedLines" | "productFiles" | "linesByBucket"> {
  // A partial file list would understate size: flag it rather than estimate (rule 4).
  if (pr.truncated.includes("files")) {
    return { sizeLines: null, addedLines: null, productFiles: null, linesByBucket: null };
  }
  const linesByBucket = Object.fromEntries(BUCKETS.map((bucket) => [bucket, 0])) as Record<
    Bucket,
    number
  >;
  let addedLines = 0;
  let productFiles = 0;
  for (const file of pr.files) {
    const bucket = rules.classify(pr.repo, file.path);
    linesByBucket[bucket] += file.additions + file.deletions;
    if (bucket === "product") {
      addedLines += file.additions;
      productFiles += 1;
    }
  }
  return { sizeLines: linesByBucket.product, addedLines, productFiles, linesByBucket };
}

/**
 * Counts the times new commits arrived after a review. A push is a commit's committed time
 * (rebases and amends refresh it) or a force-push event; several commits pushed together after
 * one review count once.
 */
function rounds(pr: PrModel, reviews: readonly { at: string }[]): number {
  const timeline = [
    ...reviews.map((review) => ({ at: review.at, push: false })),
    ...pr.commits.map((commit) => ({ at: commit.committedAt, push: true })),
    ...pr.events
      .filter((event) => event.type === "force_pushed")
      .map((event) => ({ at: event.at, push: true })),
  ].sort((a, b) => a.at.localeCompare(b.at) || Number(a.push) - Number(b.push));
  let count = 0;
  let reviewedSincePush = false;
  for (const item of timeline) {
    if (!item.push) reviewedSincePush = true;
    else if (reviewedSincePush) {
      count += 1;
      reviewedSincePush = false;
    }
  }
  return count;
}

function earliest(times: readonly string[]): string | null {
  let min: string | null = null;
  for (const time of times) if (min === null || time < min) min = time;
  return min;
}

function clamp(time: string, low: string, high: string): string {
  return time < low ? low : time > high ? high : time;
}

function hours(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / HOUR_MS;
}
