import type { Exclusion, OpenState, PrFact, ReviewEntry, WaitingOn } from "./facts.ts";
import type { Attribution } from "./groups.ts";
import type { Actor, Comment, PrModel, Review } from "./model.ts";
import { BUCKETS, type Bucket } from "./paths.ts";
import type { PrContext, PrOutcome } from "./rules.ts";

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
  /** What the org's rules say about this PR (core/rules.ts): what counts, comments to ignore. */
  prRules: (pr: PrContext) => PrOutcome;
  /** Who opened a PR and the team and groups it belongs to (core/groups.ts, attribute). */
  attribute: (pr: { repo: string; author: string; createdAt: string }) => Attribution;
  /** The person a login belongs to (core/groups.ts, personOf): reviews count by person. */
  personOf: (login: string) => string;
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
  const where = rules.attribute({ repo: pr.repo, author: author.login, createdAt: pr.createdAt });
  const ruled = rules.prRules({
    repo: pr.repo,
    person: where.person,
    team: where.team,
    groups: where.groups,
    labels: pr.labels,
    title: pr.title,
    base: pr.baseBranch,
    head: pr.headBranch,
    authorAssociation: pr.authorAssociation,
    fromFork: pr.fromFork,
    draft: pr.draft,
    authorBot: authorIsBot,
  });
  // Boilerplate a bot or template posts: such comments and review bodies don't count.
  const ignored = (body: string) =>
    body !== "" && ruled.ignore.some((pattern) => pattern.test(body));
  // People can have several accounts: a review from the author's other account is still theirs.
  const me = rules.personOf(author.login).toLowerCase();
  const sameAsAuthor = (actor: Actor) => rules.personOf(actor.login).toLowerCase() === me;

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
        !ignored(review.body),
    )
    .sort((a, b) => a.at.localeCompare(b.at));
  const approvals = reviews.filter((review) => review.state === "approved");
  const comments = pr.comments.filter(
    (comment: Comment) => inTime(comment.at) && byOthers(comment.author) && !ignored(comment.body),
  );

  const log: ReviewEntry[] = reviews.map((review) => ({
    by: rules.personOf(review.author.login),
    at: review.at,
    state: review.state as ReviewEntry["state"],
  }));
  // Review requests to people who count as reviewers, and to teams.
  const requests = pr.events.flatMap((event) =>
    event.type === "review_requested" &&
    event.reviewer !== null &&
    (event.reviewer.team || byOthers(event.reviewer))
      ? [
          {
            name: event.reviewer.team ? event.reviewer.login : rules.personOf(event.reviewer.login),
            team: event.reviewer.team,
            at: event.at,
          },
        ]
      : [],
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
    ...belongs(where),
    internal: ruled.internal,
    ...inclusion(pr, authorIsBot, rules, ruled),
    rules: ruled.applied,
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
    reviewers: [...new Set(reviews.map((review) => rules.personOf(review.author.login)))].sort(),
    reviews: reviews.length,
    approvals: approvals.length,
    changesRequested: reviews.filter((review) => review.state === "changes_requested").length,
    reviewed: reviews.length > 0,
    approved: approvals.length > 0,
    selfMerged: pr.mergedBy !== null && sameAsAuthor(pr.mergedBy),
    comments: comments.length,
    reviewThreads: pr.reviewThreads,
    rounds: rounds(pr, reviews),
    reviewLog: log,
    responses: responses(log, requests, readyAt ?? pr.createdAt),
    ...standing(pr, log, requests, readyAt),
    lastActivityAt: lastActivity(pr, rules.isBot),
    reverts: [],
    revertedBy: null,
    revertedAt: null,
    touchedAgainBy: null,
    touchedAgainAt: null,
    followUpBy: null,
    followUpAt: null,
    reworkLines: rework(pr, firstReviewAt),
    truncated: pr.truncated,
    identities: identities(pr),
  };
}

/** The accounts on a PR, once each: its author, reviewers and commenters. */
function identities(pr: PrModel): PrFact["identities"] {
  const seen = new Map<string, string | null>();
  const add = (actor: Actor | null) => {
    if (!actor) return;
    const login = actor.login.toLowerCase();
    if (!seen.has(login) || (seen.get(login) === null && actor.name)) {
      seen.set(login, actor.name ?? null);
    }
  };
  add(pr.author);
  for (const review of pr.reviews) add(review.author);
  for (const comment of pr.comments) add(comment.author);
  return [...seen].map(([login, name]) => ({ login, name }));
}

/** The parts of an attribution a fact keeps. */
function belongs(a: Attribution): Pick<PrFact, "person" | "team" | "alsoTeams" | "groups"> {
  return { person: a.person, team: a.team, alsoTeams: a.alsoTeams, groups: a.groups };
}

function inclusion(
  pr: PrModel,
  authorIsBot: boolean,
  rules: DeriveRules,
  ruled: PrOutcome,
): Pick<PrFact, "counted" | "exclusion" | "excludedBy"> {
  // Branches decide first, and no rule overrides them: measured_branches and promotion_branches
  // change them, so one change is never counted twice. Then bots, unless a rule counts the PR,
  // then a rule's `count: false`.
  let exclusion: Exclusion | null = null;
  if (!rules.isMeasuredBranch(pr.repo, pr.baseBranch)) {
    exclusion = "base";
  } else if (
    // A fork's own `main` is just where a contributor worked: only the repo's own long-lived
    // branches make a promotion.
    !pr.fromFork &&
    (rules.isPromotionBranch(pr.headBranch) || rules.isMeasuredBranch(pr.repo, pr.headBranch))
  ) {
    exclusion = "promotion";
  } else if (ruled.count === false) {
    exclusion = "rule";
  } else if (authorIsBot && ruled.count !== true) {
    exclusion = "bot";
  }
  return {
    counted: exclusion === null,
    exclusion,
    excludedBy: exclusion === "rule" ? ruled.countRule : null,
  };
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

/**
 * Lines changed by the commits pushed after the first review: how much the PR changed once
 * someone had looked at it. Merges of the target branch aren't the author's change, so they're
 * left out. Null when nobody reviewed it, or any such commit's lines aren't known.
 */
function rework(pr: PrModel, firstReviewAt: string | null): number | null {
  if (firstReviewAt === null || pr.truncated.includes("commits")) return null;
  let lines = 0;
  for (const commit of pr.commits) {
    if (commit.committedAt <= firstReviewAt || (commit.parents ?? 1) > 1) continue;
    if (commit.additions === undefined || commit.deletions === undefined) return null;
    lines += commit.additions + commit.deletions;
  }
  return lines;
}

type Request = { name: string; team: boolean; at: string };

/**
 * Each reviewer's first response: from ready, or from their own review request if that came
 * later (and before they reviewed), to their first review. A review during the draft counts as
 * an immediate response.
 */
function responses(
  log: readonly ReviewEntry[],
  requests: readonly Request[],
  readyAt: string,
): PrFact["responses"] {
  const first = new Map<string, string>();
  for (const review of log) if (!first.has(review.by)) first.set(review.by, review.at);
  return [...first].map(([by, at]) => {
    const asked = latest(
      requests
        .filter((r) => !r.team && r.name.toLowerCase() === by.toLowerCase() && r.at <= at)
        .map((r) => r.at),
    );
    const from = asked !== null && asked > readyAt ? asked : readyAt;
    return { by, hours: Math.max(0, hours(from, at)) };
  });
}

/**
 * Where an open PR stands and whose move it is, from its draft flag, reviews, pushes and review
 * requests. Without review-request removals in the data, a reviewer whose request was withdrawn
 * still counts as asked.
 */
function standing(
  pr: PrModel,
  log: readonly ReviewEntry[],
  requests: readonly Request[],
  readyAt: string | null,
): Pick<PrFact, "openState" | "waitingOn" | "waitingSince"> {
  const state = (now: OpenState, waitingOn: WaitingOn, waitingSince: string) => ({
    openState: now,
    waitingOn,
    waitingSince,
  });
  if (pr.state !== "open") return { openState: null, waitingOn: null, waitingSince: null };
  if (pr.draft) {
    const drafted = latest(
      pr.events.filter((event) => event.type === "converted_to_draft").map((event) => event.at),
    );
    return state("draft", { on: "author", why: "draft" }, drafted ?? pr.createdAt);
  }

  // A request is still open while the reviewer hasn't reviewed since; a team's, while nobody has.
  const lastReview = log.at(-1)?.at ?? null;
  const reviewedSince = (request: Request) =>
    log.some(
      (review) => review.at >= request.at && (request.team || same(review.by, request.name)),
    );
  const pending = new Map<string, Request>();
  for (const request of requests) pending.set(`${request.team}:${request.name}`, request);
  const asked = [...pending.values()].filter((request) => !reviewedSince(request));
  const people = asked.filter((r) => !r.team).map((r) => r.name);
  const teams = asked.filter((r) => r.team).map((r) => r.name);
  const ready = readyAt ?? pr.createdAt;

  if (lastReview === null) {
    return people.length + teams.length > 0
      ? state("waiting", { on: "reviewers", why: "requested", people, teams }, ready)
      : state("waiting", { on: "reviewers", why: "unassigned", people: [], teams: [] }, ready);
  }

  const lastPush = latest([
    ...pr.commits.map((commit) => commit.committedAt),
    ...pr.events.filter((event) => event.type === "force_pushed").map((event) => event.at),
  ]);
  // Each reviewer's standing verdict: their latest approval, change request or dismissal.
  const verdicts = new Map<string, ReviewEntry>();
  for (const review of log) if (review.state !== "commented") verdicts.set(review.by, review);
  const changes = [...verdicts.values()].filter((v) => v.state === "changes_requested");
  const approvals = [...verdicts.values()].filter((v) => v.state === "approved");
  const reReview = (since: string, reviewers: string[]) =>
    state(
      "in_review",
      { on: "reviewers", why: "re_review", people: unique([...reviewers, ...people]), teams },
      since,
    );

  if (changes.length > 0) {
    const requested = latest(changes.map((v) => v.at)) ?? lastReview;
    return lastPush !== null && lastPush > requested
      ? reReview(
          lastPush,
          changes.map((v) => v.by),
        )
      : state("in_review", { on: "author", why: "changes_requested" }, requested);
  }
  if (approvals.length > 0) {
    return state(
      "approved",
      { on: "merge", why: "approved" },
      latest(approvals.map((v) => v.at)) ?? lastReview,
    );
  }
  return lastPush !== null && lastPush > lastReview
    ? reReview(lastPush, unique(log.map((review) => review.by)))
    : state("in_review", { on: "author", why: "review_comments" }, lastReview);
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function unique(names: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const name of names) if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  return [...seen.values()];
}

/**
 * An open PR's newest sign of life from a person: a push, a review, a comment, a request, a
 * draft flip. Bots don't count: a stale-bot's nudge doesn't make a PR active. Null once ended.
 */
function lastActivity(pr: PrModel, isBot: (actor: Actor) => boolean): string | null {
  if (pr.state !== "open") return null;
  const person = (actor: Actor | null) => actor !== null && !isBot(actor);
  return latest([
    pr.createdAt,
    ...pr.commits.map((commit) => commit.committedAt),
    ...pr.reviews.flatMap((review) => (person(review.author) && review.at ? [review.at] : [])),
    ...pr.comments.flatMap((comment) => (person(comment.author) ? [comment.at] : [])),
    ...pr.events.map((event) => event.at),
  ]);
}

function latest(times: readonly string[]): string | null {
  let max: string | null = null;
  for (const time of times) if (max === null || time > max) max = time;
  return max;
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
