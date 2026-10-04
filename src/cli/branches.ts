import { relative } from "node:path";
import type { Org } from "../config/workspace.ts";
import { branchesSnippet, unmeasuredBranches } from "../core/branches.ts";
import { measuredBranches } from "../pipeline/derive.ts";
import type { Store } from "../store/store.ts";
import { dim, num, status } from "./format.ts";

/**
 * A warning for each repo whose recent work lands on a branch that isn't measured, with the
 * config that would measure it (rule 2). Empty when every repo looks right. Reads facts only.
 */
export function branchWarnings(store: Store, org: Org, asOf = new Date()): string[] {
  const { config } = org;
  const advice = unmeasuredBranches(store.facts(), asOf);
  if (advice.length === 0) return [];
  const repos = new Map(store.repos().map((repo) => [repo.fullName, repo]));
  const lines = advice.map((a) =>
    status(
      "warn",
      "Branch",
      `${a.repo}: ${num(a.into)} of ${num(a.merged)} PRs merged in the last 90 days went into ` +
        `${a.branch}, which isn't measured, and only ${num(a.counted)} were counted.`,
    ),
  );
  const current = (name: string) => {
    const repo = repos.get(name);
    return repo ? measuredBranches(config, repo) : [];
  };
  const snippet = branchesSnippet(advice, current)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  // The file `branches:` belongs in: the org's org.yml, or a single-file config itself.
  const file = relative(process.cwd(), org.files.org) || org.files.org;
  lines.push(dim(`  If that is where work lands, measure it in ${file}:\n${snippet}`));
  return lines;
}
