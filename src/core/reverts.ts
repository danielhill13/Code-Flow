import type { PrFact } from "./facts.ts";
import type { PrModel } from "./model.ts";

/** GitHub's Revert button writes "Reverts owner/name#123" as the PR's body. */
const REVERTS_PR = /^Reverts\s+([\w.-]+\/[\w.-]+)#(\d+)/gm;
/** `git revert` writes "This reverts commit <sha>." into the commit message. */
const REVERTS_COMMIT = /This reverts commit ([0-9a-f]{7,40})/g;

/**
 * What revert linking needs from one PR: a few ids instead of the whole PR, so a repo's PRs can
 * be linked without holding them all in memory.
 */
export type RevertClues = {
  id: string;
  number: number;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  commitShas: string[];
  /** PRs in the same repo that its body says it reverts. */
  namesPrs: number[];
  /** Commits its commit messages say they revert. */
  revertsShas: string[];
};

export function revertClues(pr: PrModel): RevertClues {
  const merged = pr.state === "merged" && pr.mergedAt !== null;
  const namesPrs: number[] = [];
  for (const [, repo, number] of pr.body.matchAll(REVERTS_PR)) {
    if (repo?.toLowerCase() === pr.repo.toLowerCase()) namesPrs.push(Number(number));
  }
  return {
    id: pr.id,
    number: pr.number,
    mergedAt: merged ? pr.mergedAt : null,
    mergeCommitSha: pr.mergeCommitSha,
    commitShas: merged ? pr.commits.map((commit) => commit.sha) : [],
    namesPrs,
    revertsShas: pr.commits.flatMap((commit) =>
      [...commit.message.matchAll(REVERTS_COMMIT)].flatMap(([, sha]) => (sha ? [sha] : [])),
    ),
  };
}

/**
 * Links each merged PR to the merged PRs it reverts, by the PR it names or by the commits it
 * reverts. A revert title alone proves nothing, and neither does a commit that reverts another
 * commit of the same PR: that is ordinary work in progress. Sets `reverts` on the reverting PR,
 * and `revertedBy`/`revertedAt` (the earliest revert) on each reverted one. All PRs must be from
 * one repo.
 */
export function linkReverts(prs: readonly RevertClues[], facts: ReadonlyMap<string, PrFact>): void {
  const merged = prs.filter((pr) => pr.mergedAt !== null);
  const byNumber = new Map(merged.map((pr) => [pr.number, pr]));
  // A merge commit belongs to exactly one PR; a commit can sit in several (stacked PRs), so
  // merge commits are indexed first and win.
  const bySha = new Map<string, RevertClues>();
  for (const pr of merged) if (pr.mergeCommitSha) bySha.set(pr.mergeCommitSha, pr);
  for (const pr of merged) {
    for (const sha of pr.commitShas) if (!bySha.has(sha)) bySha.set(sha, pr);
  }
  const shas = [...bySha.keys()];
  const findSha = (sha: string) =>
    bySha.get(sha) ?? bySha.get(shas.find((full) => full.startsWith(sha)) ?? "");

  for (const revert of merged) {
    const targets = new Set<RevertClues>();
    for (const number of revert.namesPrs) {
      const target = byNumber.get(number);
      if (target) targets.add(target);
    }
    for (const sha of revert.revertsShas) {
      const target = findSha(sha);
      if (target) targets.add(target);
    }
    targets.delete(revert);
    if (targets.size === 0) continue;

    const revertFact = facts.get(revert.id);
    if (revertFact) revertFact.reverts = [...targets].map((pr) => pr.number).sort((a, b) => a - b);
    for (const target of targets) {
      const fact = facts.get(target.id);
      const at = revert.mergedAt;
      if (!fact || at === null) continue;
      if (fact.revertedAt === null || at < fact.revertedAt) {
        fact.revertedAt = at;
        fact.revertedBy = revert.number;
      }
    }
  }
}
