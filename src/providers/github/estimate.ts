import type { GitHubClient } from "./client.ts";
import type { Repo } from "./discover.ts";
import { PR_PAGE, PR_PAGE_SIZE, SYNC_SEARCH_COUNTS } from "./queries.ts";

/** Repos per search. GitHub ORs repeated `repo:` qualifiers; batching keeps searches few. */
const REPOS_PER_SEARCH = 20;

/** What a first sync fetches (see sync.ts): PRs updated since `since`, and older open PRs. */
export type SyncCounts = { updated: number; olderOpen: number };

export async function countPrsToSync(
  client: GitHubClient,
  repos: readonly Repo[],
  since: string,
): Promise<SyncCounts> {
  const counts: SyncCounts = { updated: 0, olderOpen: 0 };
  for (const repoFilter of repoQualifiers(repos)) {
    const data = await client.graphql<Record<keyof SyncCounts, { issueCount: number }>>(
      SYNC_SEARCH_COUNTS,
      {
        updated: `${repoFilter} is:pr updated:>=${since}`,
        olderOpen: `${repoFilter} is:pr is:open updated:<${since}`,
      },
    );
    counts.updated += data.updated.issueCount;
    counts.olderOpen += data.olderOpen.issueCount;
  }
  return counts;
}

/** `repo:` qualifiers for every repo, REPOS_PER_SEARCH to a string. */
export function repoQualifiers(repos: readonly Repo[]): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < repos.length; i += REPOS_PER_SEARCH) {
    chunks.push(
      repos
        .slice(i, i + REPOS_PER_SEARCH)
        .map((repo) => `repo:${repo.fullName}`)
        .join(" "),
    );
  }
  return chunks;
}

const pageVariables = (repo: Repo) => ({
  owner: repo.owner,
  name: repo.name,
  first: PR_PAGE_SIZE,
  after: null,
  states: null,
  direction: "DESC",
});

/** Points one page of PR_PAGE costs. A dry run: it spends nothing. */
export function prPageCost(client: GitHubClient, repo: Repo): Promise<number> {
  return client.cost(PR_PAGE, pageVariables(repo));
}

/** Fetches one real page and times it, so the estimate uses this machine's latency. */
export async function timePrPage(client: GitHubClient, repo: Repo): Promise<number> {
  const started = performance.now();
  await client.graphql(PR_PAGE, { ...pageVariables(repo), dryRun: false });
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

export function estimateBackfill(
  input: SyncCounts & {
    repos: number;
    pageCost: number;
    hourlyLimit: number;
    secondsPerPage?: number;
  },
): BackfillEstimate {
  // Per repo, the backfill ends on a partial page and the open sweep needs at least one page,
  // even when there is nothing to fetch; so add two pages per repo. PRs with more than 100
  // commits, files, reviews or comments need follow-up calls that this leaves out.
  const pages =
    Math.ceil(input.updated / PR_PAGE_SIZE) +
    Math.ceil(input.olderOpen / PR_PAGE_SIZE) +
    2 * input.repos;
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
