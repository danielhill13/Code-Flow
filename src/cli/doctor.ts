import { existsSync } from "node:fs";
import type { Org } from "../config/workspace.ts";
import { deriveFacts } from "../pipeline/derive.ts";
import {
  discoverRepos,
  type Repo,
  type Skipped,
  type SkipReason,
  type SourceResult,
  sourceName,
} from "../providers/github/discover.ts";
import {
  countPrsToSync,
  estimateBackfill,
  prPageCost,
  timePrPage,
} from "../providers/github/estimate.ts";
import { PR_PAGE_SIZE } from "../providers/github/queries.ts";
import { Store } from "../store/store.ts";
import { branchWarnings } from "./branches.ts";
import { bold, dim, durationSeconds, num, plural, status, table } from "./format.ts";
import { connect, type OrgOptions, orgHeading, orgsFor, type Print } from "./session.ts";

export type DoctorOptions = OrgOptions & { all?: boolean };

/** Repos listed per source before `--all` is needed. */
const REPO_ROWS = 25;

const SKIPPED: Record<SkipReason, (n: number) => string> = {
  excluded: (n) => `${num(n)} excluded`,
  "not included": (n) => `${num(n)} not included`,
  archived: (n) => `${num(n)} archived`,
  fork: (n) => plural(n, "fork"),
  empty: (n) => `${num(n)} empty`,
  duplicate: (n) => `${num(n)} already selected by an earlier source`,
};

/**
 * Read-only preflight: config, token, the repos each source selects, and what a first sync
 * will cost. Spends a few points (one real page is fetched to time it). Returns the exit code.
 */
export async function doctor(options: DoctorOptions): Promise<number> {
  const print: Print = (line = "") => console.log(line);
  const { workspace, orgs } = await orgsFor(options);
  let code = 0;
  for (const [i, org] of orgs.entries()) {
    if (i > 0) print();
    orgHeading(workspace, org, print);
    code = Math.max(code, await doctorOrg(org, options, print));
  }
  return code;
}

async function doctorOrg(org: Org, options: DoctorOptions, print: Print): Promise<number> {
  const session = await connect(org, print, { explainScopes: true });
  if (!session) return 1;
  const { config, client } = session;
  const hourlyLimit = session.budget.limit;
  print();

  const results = await discoverRepos(client, config.sources);
  for (const result of results) printSource(result, config.since, options.all ?? false, print);

  const repos = results.flatMap((result) => result.repos);
  if (repos.length === 0) {
    print(status("fail", "Repos", "no repos selected, so there is nothing to measure"));
    return 1;
  }

  const counts = await countPrsToSync(client, repos, config.since);
  const busiest = repos.reduce((a, b) => (totalPrs(b) > totalPrs(a) ? b : a));
  const pageCost = await prPageCost(client, busiest);
  const secondsPerPage = await timePrPage(client, busiest);
  const estimate = estimateBackfill({
    ...counts,
    repos: repos.length,
    pageCost,
    hourlyLimit,
    secondsPerPage,
  });
  const share =
    estimate.shareOfHour <= 1
      ? `${Math.max(1, Math.round(estimate.shareOfHour * 100))}% of the hourly limit`
      : `${estimate.shareOfHour.toFixed(1)}× the hourly limit, so it will wait for resets`;
  print(bold("First sync"));
  const olderOpen = counts.olderOpen > 0 ? `, plus ${num(counts.olderOpen)} older open ones,` : "";
  print(
    `  ${plural(counts.updated, "PR")} updated since ${config.since}${olderOpen} ` +
      `in ${plural(repos.length, "repo")}`,
  );
  print(
    `  about ${durationSeconds(estimate.seconds ?? 0)}: ~${plural(estimate.pages, "query", "queries")}, ` +
      `~${num(estimate.points)} points (${share})`,
  );
  print(
    dim(
      `  one page of ${PR_PAGE_SIZE} PRs from ${busiest.fullName} took ` +
        `${secondsPerPage.toFixed(1)} s and costs ${plural(pageCost, "point")}`,
    ),
  );
  const synced = alreadySynced(session.dbPath, repos);
  if (synced > 0) {
    print(dim(`  ${plural(synced, "repo")} already synced: the next sync fetches only changes`));
    const store = Store.open(session.dbPath);
    try {
      deriveFacts(store, config);
      for (const line of branchWarnings(store, org)) print(line);
    } finally {
      store.close();
    }
  }
  print();
  print(
    dim(
      `doctor used ${plural(client.stats.calls, "call")} and ` +
        `${plural(client.stats.points, "point")}`,
    ),
  );

  const failed = results.filter((result) => result.error).length;
  if (failed > 0) {
    print(status("fail", "Sources", `${plural(failed, "source")} could not be read; see above`));
    return 1;
  }
  print(status("ok", "Ready", "everything checks out"));
  return 0;
}

function printSource(result: SourceResult, since: string, all: boolean, print: Print): void {
  const { source } = result;
  const ownerType = result.ownerType ? ` (${result.ownerType.toLowerCase()})` : "";
  const name = `${sourceName(source)}${ownerType}`;
  if (result.error) {
    print(status("fail", "Source", `${name}: ${result.error}`));
    print();
    return;
  }

  if (source.kind === "repo") {
    // One repo: say what happened to it rather than counting to one.
    const [skip] = result.skipped;
    const detail = !skip
      ? "selected"
      : skip.reason === "duplicate"
        ? "already selected by an earlier source"
        : `skipped (${skip.reason})`;
    print(status(skip ? "warn" : "ok", "Source", `${name}: ${detail}`));
  } else {
    const parts = [`${plural(result.repos.length, "repo")} selected`];
    if (result.skipped.length > 0) parts.push(`skipped ${describeSkipped(result.skipped)}`);
    print(
      status(result.repos.length > 0 ? "ok" : "warn", "Source", `${name}: ${parts.join("; ")}`),
    );
  }

  const sorted = [...result.repos].sort(
    (a, b) => totalPrs(b) - totalPrs(a) || a.fullName.localeCompare(b.fullName),
  );
  const shown = all ? sorted : sorted.slice(0, REPO_ROWS);
  if (shown.length > 0) {
    print(
      table(
        ["repo", "branch", "open", "merged", "closed", "last PR activity"],
        shown.map((repo) => [
          repo.fullName,
          repo.defaultBranch ?? "-",
          num(repo.prs.open),
          num(repo.prs.merged),
          num(repo.prs.closed),
          repo.lastPrActivity?.slice(0, 10) ?? "never",
        ]),
        { rightAlign: [2, 3, 4], indent: "  " },
      ),
    );
  }
  if (shown.length < sorted.length) {
    print(dim(`  and ${num(sorted.length - shown.length)} more (--all lists them)`));
  }
  const quiet = result.repos.filter(
    (repo) => !repo.lastPrActivity || repo.lastPrActivity.slice(0, 10) < since,
  );
  if (quiet.length > 0 && quiet.length < result.repos.length) {
    print(dim(`  ${plural(quiet.length, "repo")} had no PR activity since ${since}`));
  }
  if (all && result.skipped.length > 0) {
    print(
      table(
        ["skipped", "why"],
        result.skipped.map((s) => [s.repo, s.reason]),
        { indent: "  " },
      ),
    );
  }
  print();
}

function describeSkipped(skipped: readonly Skipped[]): string {
  const counts = new Map<SkipReason, number>();
  for (const { reason } of skipped) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts].map(([reason, n]) => SKIPPED[reason](n)).join(", ");
}

const totalPrs = (repo: Repo) => repo.prs.open + repo.prs.merged + repo.prs.closed;

/** How many of `repos` have finished their backfill in the local database. */
function alreadySynced(dbPath: string, repos: readonly Repo[]): number {
  if (!existsSync(dbPath)) return 0;
  const store = Store.open(dbPath);
  try {
    const backfilled = new Set(
      store
        .repoSummaries()
        .filter((repo) => repo.coveredSince !== null)
        .map((repo) => repo.fullName),
    );
    return repos.filter((repo) => backfilled.has(repo.fullName)).length;
  } finally {
    store.close();
  }
}
