import type { GitHubClient } from "./client.ts";
import type { Repo } from "./discover.ts";
import { PR_PAGE, PR_PAGE_SIZE, SEARCH_COUNT } from "./queries.ts";

/** Repos per search. GitHub ORs repeated `repo:` qualifiers; batching keeps searches few. */
const REPOS_PER_SEARCH = 20;

/** PRs in `repos` updated on or after `since`: what a first sync has to fetch. */
export async function countPrsUpdatedSince(
  client: GitHubClient,
  repos: readonly Repo[],
  since: string,
): Promise<number> {
  let total = 0;
  for (const query of searchQueries(repos, since)) {
    const data = await client.graphql<{ search: { issueCount: number } }>(SEARCH_COUNT, {
      q: query,
    });
    total += data.search.issueCount;
  }
  return total;
}

export function searchQueries(repos: readonly Repo[], since: string): string[] {
  const queries: string[] = [];
  for (let i = 0; i < repos.length; i += REPOS_PER_SEARCH) {
    const qualifiers = repos.slice(i, i + REPOS_PER_SEARCH).map((r) => `repo:${r.fullName}`);
    queries.push(`${qualifiers.join(" ")} is:pr updated:>=${since}`);
  }
  return queries;
}

/** Points one page of PR_PAGE costs. A dry run: it spends nothing. */
export function prPageCost(client: GitHubClient, repo: Repo): Promise<number> {
  return client.cost(PR_PAGE, { owner: repo.owner, name: repo.name, first: PR_PAGE_SIZE });
}

/** Fetches one real page and times it, so the estimate uses this machine's latency. */
export async function timePrPage(client: GitHubClient, repo: Repo): Promise<number> {
  const started = performance.now();
  await client.graphql(PR_PAGE, {
    owner: repo.owner,
    name: repo.name,
    first: PR_PAGE_SIZE,
    dryRun: false,
  });
  return (performance.now() - started) / 1000;
}

export type BackfillEstimate = {
  pages: number;
  points: number;
  /** Points as a share of the hourly limit; above 1, the sync waits for the limit to reset. */
  shareOfHour: number;
  /** Wall-clock seconds, if a page was timed. */
  seconds?: number;
};

export function estimateBackfill(input: {
  prs: number;
  repos: number;
  pageCost: number;
  hourlyLimit: number;
  secondsPerPage?: number;
}): BackfillEstimate {
  // Every repo ends on a partial page, and a repo with nothing to fetch still costs one page
  // to find that out, so add a page per repo. PRs with more than 100 commits, files, reviews
  // or comments need follow-up calls that this leaves out.
  const pages = Math.ceil(input.prs / PR_PAGE_SIZE) + input.repos;
  const points = pages * input.pageCost;
  const estimate: BackfillEstimate = { pages, points, shareOfHour: points / input.hourlyLimit };
  if (input.secondsPerPage !== undefined) {
    // Either latency or the rate limit is the bottleneck. The limit refills hourly, so every
    // full hour of points costs an hour of wall clock however fast the pages come back.
    const fullHours = Math.floor(points / input.hourlyLimit);
    const pagesAfterLastWait = (points - fullHours * input.hourlyLimit) / input.pageCost;
    estimate.seconds = Math.max(
      pages * input.secondsPerPage,
      fullHours * 3600 + pagesAfterLastWait * input.secondsPerPage,
    );
  }
  return estimate;
}
