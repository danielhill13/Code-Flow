// An Azure DevOps PR as codeflow's provider-neutral PR model (decision D40), so every metric reads
// it exactly as it reads a GitHub PR. Azure DevOps has no review submissions: a vote is a review
// (approve, or wait for the author / reject as a change request), and a comment thread someone
// other than the author starts is a commented review. Each push after the first is new commits.
import type {
  Actor,
  Comment,
  Commit,
  PrEvent,
  PrModel,
  PrState,
  Review,
  Truncatable,
} from "../../core/model.ts";
import { branchName } from "./discover.ts";
import type { AdoIdentity, AdoPayload, AdoThread } from "./types.ts";

const STATES: Record<AdoPayload["pr"]["status"], PrState> = {
  active: "open",
  completed: "merged",
  abandoned: "closed",
  notSet: "open",
};

/** The id a PR has in codeflow: Azure DevOps's PR ids are unique within an organization. */
export const adoPrId = (organization: string, pullRequestId: number) =>
  `ado:${organization.toLowerCase()}:${pullRequestId}`;

export function normalizeAdoPr(
  raw: AdoPayload,
  repo: { id: string; fullName: string },
  updatedAt: string,
): PrModel {
  const { pr } = raw;
  const organization = repo.fullName.split("/")[0] ?? "";
  const state = STATES[pr.status];
  const closedAt = state === "open" ? null : iso(pr.closedDate);
  const author = actor(pr.createdBy);
  const sameAsAuthor = (identity: AdoIdentity) =>
    author !== null && login(identity) === author.login;

  const reviews: Review[] = [];
  const comments: Comment[] = [];
  const events: PrEvent[] = [];
  let inlineThreads = 0;
  for (const thread of raw.threads) {
    const kind = property(thread, "CodeReviewThreadType");
    const text = thread.comments.filter((c) => c.commentType === "text" && !c.isDeleted);
    if (kind === "VoteUpdate") {
      const voter = thread.comments[0]?.author;
      const vote = Number(property(thread, "CodeReviewVoteResult"));
      const at = iso(thread.publishedDate);
      if (voter && at && vote !== 0 && Number.isFinite(vote)) {
        reviews.push({
          author: actor(voter),
          state: vote > 0 ? "approved" : "changes_requested",
          at,
          body: "",
        });
      }
    } else if (kind === "ReviewersUpdate") {
      const at = iso(thread.publishedDate);
      for (const [key, value] of Object.entries(thread.properties ?? {})) {
        if (!key.startsWith("CodeReviewReviewersUpdatedAddedIdentity") || !at) continue;
        const identity = thread.identities?.[String(value.$value)];
        events.push({
          type: "review_requested",
          at,
          reviewer: identity
            ? {
                login: identity.isContainer ? identity.displayName : login(identity),
                bot: isBot(identity),
                team: identity.isContainer ?? false,
              }
            : null,
        });
      }
    } else if (kind === "IsDraftUpdated" || property(thread, "CodeReviewIsDraft") !== undefined) {
      const at = iso(thread.publishedDate);
      const draft = String(property(thread, "CodeReviewIsDraft")).toLowerCase() === "true";
      if (at) events.push({ type: draft ? "converted_to_draft" : "ready_for_review", at });
    } else if (kind === "StatusUpdate") {
      const at = iso(thread.publishedDate);
      const status = String(property(thread, "CodeReviewStatus")).toLowerCase();
      if (at && status === "active") events.push({ type: "reopened", at });
    } else if (text.length > 0) {
      // A conversation. Started by someone other than the author, it is their review; every
      // other comment in it is a comment.
      if (thread.threadContext?.filePath) inlineThreads += 1;
      const [first, ...replies] = text;
      if (first && !sameAsAuthor(first.author)) {
        reviews.push({
          author: actor(first.author),
          state: "commented",
          at: iso(first.publishedDate) ?? first.publishedDate,
          body: first.content ?? "",
        });
      } else if (first) {
        comments.push(commentOf(first));
      }
      comments.push(...replies.map(commentOf));
    }
  }

  // Each push after the one that opened the PR brings new commits: what GitHub calls a push to
  // the branch, and what starts another round of review.
  for (const iteration of raw.iterations.slice(1)) {
    const at = iso(iteration.createdDate);
    if (at) events.push({ type: "force_pushed", at });
  }
  if (state === "merged" && closedAt) events.push({ type: "merged", at: closedAt });
  if (state === "closed" && closedAt) events.push({ type: "closed", at: closedAt });

  const truncated: Truncatable[] = [];
  if (raw.truncated.includes("commits")) truncated.push("commits");
  if (raw.files === null) truncated.push("files");
  const files = raw.files ?? [];
  return {
    id: adoPrId(organization, pr.pullRequestId),
    repoId: repo.id,
    repo: repo.fullName,
    number: pr.pullRequestId,
    url: raw.webUrl,
    title: pr.title,
    body: pr.description ?? "",
    state,
    draft: pr.isDraft ?? false,
    author,
    // Everyone who can open a PR in an Azure DevOps organization belongs to it.
    authorAssociation: "MEMBER",
    fromFork: pr.forkSource !== undefined && pr.forkSource !== null,
    baseBranch: branchName(pr.targetRefName) ?? "",
    headBranch: branchName(pr.sourceRefName) ?? "",
    createdAt: iso(pr.creationDate) ?? pr.creationDate,
    updatedAt,
    mergedAt: state === "merged" ? closedAt : null,
    closedAt,
    mergedBy: state === "merged" && pr.closedBy ? actor(pr.closedBy) : null,
    mergeCommitSha: pr.lastMergeCommit?.commitId ?? null,
    labels: (pr.labels ?? []).filter((l) => l.active !== false).map((l) => l.name),
    commits: raw.commits
      .map(
        (commit): Commit => ({
          sha: commit.commitId,
          authoredAt: iso(commit.author?.date) ?? "",
          committedAt: iso(commit.committer?.date ?? commit.author?.date) ?? "",
          message: commit.comment ?? "",
        }),
      )
      .filter((commit) => commit.authoredAt !== "")
      // Azure DevOps lists a PR's commits newest first; the model wants them oldest first.
      .sort((a, b) => a.committedAt.localeCompare(b.committedAt)),
    reviews: reviews.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "")),
    comments: comments.sort((a, b) => a.at.localeCompare(b.at)),
    reviewThreads: inlineThreads,
    files,
    events: events.sort((a, b) => a.at.localeCompare(b.at)),
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    truncated,
  };
}

/** A person by their sign-in, lowercased, so the same address always matches. */
function login(identity: AdoIdentity): string {
  return (identity.uniqueName || identity.displayName).toLowerCase();
}

/**
 * Service identities: build services, the system, and anything Azure DevOps describes as a
 * service. Config can name more (bots.accounts).
 */
export function isBot(identity: AdoIdentity): boolean {
  return (
    /^build\\/i.test(identity.uniqueName ?? "") ||
    /build service|^microsoft\.visualstudio\.services/i.test(identity.displayName) ||
    (identity.descriptor ?? "").startsWith("svc.")
  );
}

function actor(identity: AdoIdentity | undefined): Actor | null {
  return identity
    ? { login: login(identity), bot: isBot(identity), name: identity.displayName }
    : null;
}

function commentOf(comment: AdoThread["comments"][number]): Comment {
  return {
    author: actor(comment.author),
    at: iso(comment.publishedDate) ?? comment.publishedDate,
    body: comment.content ?? "",
  };
}

function property(thread: AdoThread, name: string): string | number | undefined {
  return thread.properties?.[name]?.$value;
}

/** Azure DevOps times as ISO 8601 in UTC, as the rest of codeflow writes them; null for none. */
export function iso(time: string | undefined | null): string | null {
  if (!time || time.startsWith("0001")) return null;
  const parsed = Date.parse(time);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().replace(".000Z", "Z");
}
