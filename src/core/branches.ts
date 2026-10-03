// Rule 2, watch the measured branch: a repo whose work lands somewhere codeflow doesn't measure
// (features into `develop` while the default branch is `main`) would otherwise just look quiet.
import type { PrFact } from "./facts.ts";

export type BranchAdvice = {
  repo: string;
  /** The unmeasured branch most of the repo's recent PRs merged into. */
  branch: string;
  /** Recent merged PRs into it, and into all of the repo's branches. Bot PRs aren't counted. */
  into: number;
  merged: number;
  /** Recent merged PRs that are counted. */
  counted: number;
};

/** How far back the check looks, and how many merges it needs before saying anything. */
export const ADVICE_DAYS = 90;
export const ADVICE_MIN_PRS = 10;

/**
 * Repos where, over the last 90 days, more PRs merged into one branch that isn't measured than
 * were counted at all. Such work isn't counted anywhere, so the repo's numbers understate it.
 */
export function unmeasuredBranches(facts: readonly PrFact[], asOf: Date): BranchAdvice[] {
  const since = new Date(asOf.getTime() - ADVICE_DAYS * 86_400_000).toISOString();
  const repos = new Map<string, { merged: number; counted: number; into: Map<string, number> }>();
  for (const pr of facts) {
    if (pr.state !== "merged" || pr.mergedAt === null || pr.mergedAt < since) continue;
    if (pr.exclusion === "bot") continue;
    let repo = repos.get(pr.repo);
    if (!repo) {
      repo = { merged: 0, counted: 0, into: new Map() };
      repos.set(pr.repo, repo);
    }
    repo.merged += 1;
    if (pr.counted) repo.counted += 1;
    if (pr.exclusion === "base")
      repo.into.set(pr.baseBranch, (repo.into.get(pr.baseBranch) ?? 0) + 1);
  }
  const advice: BranchAdvice[] = [];
  for (const [name, repo] of repos) {
    const [branch, into] = [...repo.into].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    if (into >= ADVICE_MIN_PRS && into > repo.counted) {
      advice.push({ repo: name, branch, into, merged: repo.merged, counted: repo.counted });
    }
  }
  return advice.sort((a, b) => a.repo.localeCompare(b.repo));
}

/** The `branches:` lines that would measure those branches, alongside the repos' own. */
export function branchesSnippet(
  advice: readonly BranchAdvice[],
  current: (repo: string) => string[],
): string {
  return [
    "branches:",
    ...advice.map(
      (a) => `  ${a.repo}: [${[...new Set([...current(a.repo), a.branch])].join(", ")}]`,
    ),
  ].join("\n");
}
