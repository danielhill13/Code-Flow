import { loadConfig } from "../config/load.ts";
import { hostFromApiUrl, resolveToken, type TokenKind } from "../providers/github/auth.ts";
import { GitHubClient, httpStatus } from "../providers/github/client.ts";
import {
  discoverRepos,
  type Repo,
  type Skipped,
  type SkipReason,
  type SourceResult,
} from "../providers/github/discover.ts";
import {
  countPrsUpdatedSince,
  estimateBackfill,
  prPageCost,
  timePrPage,
} from "../providers/github/estimate.ts";
import { PR_PAGE_SIZE, VIEWER } from "../providers/github/queries.ts";
import { VERSION } from "../version.ts";
import { bold, dim, duration, num, plural, status, table } from "./format.ts";

export type DoctorOptions = { config: string; all?: boolean };

/** Repos listed per source before `--all` is needed. */
const REPO_ROWS = 25;

/** GitHub's GraphQL limit for a personal token, if `GET /rate_limit` doesn't say. */
const DEFAULT_HOURLY_POINTS = 5000;

const TOKEN_KINDS: Record<TokenKind, string> = {
  classic: "classic personal access token",
  "fine-grained": "fine-grained personal access token",
  oauth: "OAuth token",
  "app-installation": "GitHub App installation token",
  "app-user": "GitHub App user token",
  unknown: "token",
};

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
  const print = (line = "") => console.log(line);

  const config = await loadConfig(options.config);
  print(
    status(
      "ok",
      "Config",
      `${options.config}: ${plural(config.sources.length, "source")}, since ${config.since}`,
    ),
  );

  const token = await resolveToken({
    tokenEnv: config.github.token_env,
    host: hostFromApiUrl(config.github.api_url),
  });
  const client = new GitHubClient({
    token: token.value,
    apiUrl: config.github.api_url,
    userAgent: `codeflow/${VERSION}`,
    onWait: (message) => print(status("warn", "Waiting", message)),
  });

  let login: string;
  try {
    ({
      viewer: { login },
    } = await client.graphql<{ viewer: { login: string } }>(VIEWER));
  } catch (err) {
    if (httpStatus(err) !== 401) throw err;
    print(
      status(
        "fail",
        "Token",
        `GitHub rejected the token from ${token.source}: expired or revoked?`,
      ),
    );
    return 1;
  }
  const budget = await client.budget();
  print(status("ok", "Token", `${login} via ${token.source} (${TOKEN_KINDS[token.kind]})`));
  const writeScopes = budget.scopes?.filter((scope) => !scope.startsWith("read:")) ?? [];
  if (writeScopes.length > 0) {
    print(
      status(
        "info",
        "",
        dim(
          `it can also write (${writeScopes.join(", ")}); codeflow only reads, ` +
            "so a read-only fine-grained token is enough",
        ),
      ),
    );
  }
  const hourlyLimit = budget.graphql?.limit ?? DEFAULT_HOURLY_POINTS;
  if (budget.graphql) {
    const { remaining, limit, resetAt } = budget.graphql;
    print(
      status(
        remaining > 0 ? "ok" : "warn",
        "Rate limit",
        `${num(remaining)} of ${num(limit)} GraphQL points left, resets ${clock(resetAt)}`,
      ),
    );
  }
  print();

  const results = await discoverRepos(client, config.sources);
  for (const result of results) printSource(result, config.since, options.all ?? false, print);

  const repos = results.flatMap((result) => result.repos);
  if (repos.length === 0) {
    print(status("fail", "Repos", "no repos selected, so there is nothing to measure"));
    return 1;
  }

  const prs = await countPrsUpdatedSince(client, repos, config.since);
  const busiest = repos.reduce((a, b) => (totalPrs(b) > totalPrs(a) ? b : a));
  const pageCost = await prPageCost(client, busiest);
  const secondsPerPage = await timePrPage(client, busiest);
  const estimate = estimateBackfill({
    prs,
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
  print(`  ${plural(prs, "PR")} updated since ${config.since} in ${plural(repos.length, "repo")}`);
  print(
    `  about ${duration(estimate.seconds ?? 0)}: ~${plural(estimate.pages, "query", "queries")}, ` +
      `~${num(estimate.points)} points (${share})`,
  );
  print(
    dim(
      `  one page of ${PR_PAGE_SIZE} PRs from ${busiest.fullName} took ` +
        `${secondsPerPage.toFixed(1)} s and costs ${plural(pageCost, "point")}`,
    ),
  );
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

function printSource(
  result: SourceResult,
  since: string,
  all: boolean,
  print: (line?: string) => void,
): void {
  const { source } = result;
  const name =
    source.kind === "repo"
      ? `${source.owner}/${source.name}`
      : `${source.owner}${result.ownerType ? ` (${result.ownerType.toLowerCase()})` : ""}`;
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

const clock = (date: Date) => date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
