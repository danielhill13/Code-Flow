import { existsSync } from "node:fs";
import { relative } from "node:path";
import { type AdoSource, isGitHub } from "../config/schema.ts";
import type { Org } from "../config/workspace.ts";
import { CodeflowError } from "../errors.ts";
import { deriveFacts } from "../pipeline/derive.ts";
import { forgetRepos } from "../pipeline/prune.ts";
import { type AdoSourceResult, discoverAdo } from "../providers/ado/discover.ts";
import { type AdoRepoOutcome, syncAdoRepo } from "../providers/ado/sync.ts";
import { discoverRepos, sourceName } from "../providers/github/discover.ts";
import { fetchFrom, type RepoOutcome, syncRepos, type WalkName } from "../providers/github/sync.ts";
import { Store } from "../store/store.ts";
import { dim, durationSeconds, marked, num, plural, status } from "./format.ts";
import { Progress } from "./progress.ts";
import {
  type AdoConnection,
  connect,
  connectAdo,
  type OrgOptions,
  orgHeading,
  orgsFor,
  type Print,
  type Session,
} from "./session.ts";

export type SyncOptions = OrgOptions & {
  /** Repos (full names, * matches anything) whose stored data is cleared and fetched again. */
  refetch?: string[];
};

const WALKS: Record<WalkName, string> = {
  updates: "updates",
  backfill: "backfill",
  "open sweep": "older open PRs",
};

/**
 * Fetches every PR changed since the last sync; the first time, every PR updated since `since`.
 * Returns the exit code: 0 when everything synced, 130 when stopped, 1 otherwise.
 */
export async function sync(options: SyncOptions): Promise<number> {
  const progress = new Progress();
  // Anything printed, such as a rate-limit wait mid-page, first clears the progress line.
  const print: Print = (line = "") => {
    progress.clear();
    console.log(line);
  };
  const { workspace, orgs } = await orgsFor(options);
  let code = 0;
  for (const [i, org] of orgs.entries()) {
    if (i > 0) print();
    orgHeading(workspace, org, print);
    if (options.refetch?.length) refetch(org, options.refetch, print);
    const result = await syncOrg(org, progress, print);
    code = Math.max(code, result);
    if (result === 130) break; // stopped by the reader: don't start the next org
  }
  return code;
}

/** Clears the stored PRs of the repos matching the patterns, so this sync fetches them anew. */
function refetch(org: Org, patterns: readonly string[], print: Print): void {
  if (!existsSync(org.dbPath)) return;
  const store = Store.open(org.dbPath);
  try {
    const cleared = forgetRepos(store, patterns);
    if (cleared.length === 0) {
      print(status("warn", "Refetch", `no stored repo matches ${patterns.join(", ")}`));
    }
    for (const repo of cleared) {
      print(
        status(
          "info",
          "Refetch",
          `${repo.fullName}: ${plural(repo.prs, "PR")} cleared, fetching again`,
        ),
      );
    }
  } finally {
    store.close();
  }
}

/**
 * Syncs one org into its own database: its GitHub sources, then its Azure DevOps sources, under
 * one lock and one run record. Run from the command line, Ctrl-C stops it after the page in
 * flight; run by `serve`'s scheduler, `signal` does instead.
 */
export async function syncOrg(
  org: Org,
  progress: Progress,
  print: Print,
  options: { signal?: AbortSignal } = {},
): Promise<number> {
  const { config } = org;
  const githubSources = config.sources.filter(isGitHub);
  const adoSources = config.sources.filter((s): s is AdoSource => s.kind === "ado");
  // Each provider is connected only when the org has sources there.
  let session: Session | null = null;
  if (githubSources.length > 0) {
    session = await connect(org, print);
    if (!session) return 1;
  } else {
    print(
      status(
        "ok",
        "Config",
        `${relative(process.cwd(), org.files.org) || org.files.org}: ` +
          `${plural(config.sources.length, "source")}, since ${config.since}`,
      ),
    );
  }
  const ado = adoSources.length > 0 ? await connectAdo(config, print) : null;
  const dbPath = org.dbPath;

  const store = Store.open(dbPath);
  try {
    store.acquireLock("sync");
  } catch (err) {
    store.close();
    throw err;
  }

  try {
    store.closeAbandonedRuns("sync");
    const runId = store.startRun("sync");
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const elapsed = () => durationSeconds((performance.now() - started) / 1000);

    // First Ctrl-C: store the page in flight, then stop. Second: quit now. Either way nothing
    // stored is lost, and the next sync carries on from the last stored page.
    const abort = new AbortController();
    const onInterrupt = () => {
      if (abort.signal.aborted) process.exit(130);
      print(status("warn", "Stopping", "after the current page (Ctrl-C again to quit now)"));
      abort.abort();
    };
    const external = options.signal;
    const onStop = () => abort.abort();
    if (external) external.addEventListener("abort", onStop);
    else process.on("SIGINT", onInterrupt);

    const sourceErrors: { source: string; error: string }[] = [];
    const outcomes: Outcome[] = [];
    let interrupted = false;
    let failure: unknown;
    try {
      // Every source, before any PR: a source that can't be read says so up front.
      const githubResults = session ? await discoverRepos(session.client, githubSources) : [];
      const adoResults: AdoSourceResult[] = [];
      for (const source of adoSources) {
        if (ado) adoResults.push(await discoverAdo(ado.client(source.organization), source));
      }
      for (const result of [...githubResults, ...adoResults]) {
        if (result.error) {
          sourceErrors.push({ source: sourceName(result.source), error: result.error });
          print(status("fail", "Source", `${sourceName(result.source)}: ${result.error}`));
        }
      }
      const githubRepos = githubResults.flatMap((result) => result.repos);
      const adoRepos = adoResults.flatMap((result) =>
        result.repos.map((repo) => ({ repo, organization: result.source.organization })),
      );
      const count = githubRepos.length + adoRepos.length;
      if (count === 0) {
        throw new CodeflowError(
          "No repos selected, so there is nothing to sync. See: codeflow doctor",
        );
      }
      print(status("ok", "Repos", `${plural(count, "repo")} selected`));
      print();

      if (session && githubRepos.length > 0) {
        const result = await syncRepos({
          fetchPage: fetchFrom(session.client),
          store,
          runId,
          repos: githubRepos,
          since: config.since,
          signal: abort.signal,
          onStart: (repo) => progress.update(`${repo.fullName}: checking`),
          onProgress: (repo, walk) =>
            progress.update(
              `${repo.fullName}: ${WALKS[walk.walk]}, ${plural(walk.prs, "PR")} in ` +
                `${plural(walk.pages, "page")} · ${elapsed()}`,
            ),
          onDone: (outcome) => printOutcome(outcome, print),
        });
        outcomes.push(...result.outcomes);
        interrupted = result.interrupted;
      }
      for (const { repo, organization } of adoRepos) {
        if (interrupted || abort.signal.aborted) {
          interrupted = true;
          break;
        }
        if (!ado) break;
        progress.update(`${repo.fullName}: checking`);
        const outcome = await syncAdoRepo({
          client: ado.client(organization),
          store,
          runId,
          repo,
          since: config.since,
          startedAt,
          signal: abort.signal,
          onProgress: (walk) =>
            progress.update(
              `${repo.fullName}: ${walk.walk}, ${plural(walk.prs, "PR")} in ` +
                `${plural(walk.pages, "page")}` +
                (walk.unchanged ? `, ${num(walk.unchanged)} unchanged` : "") +
                ` · ${elapsed()}`,
            ),
        });
        progress.clear();
        printOutcome(outcome, print);
        outcomes.push(outcome);
        if (outcome.interrupted) interrupted = true;
      }
    } catch (err) {
      failure = err;
    } finally {
      if (external) external.removeEventListener("abort", onStop);
      else process.off("SIGINT", onInterrupt);
      progress.clear();
    }

    const failed =
      failure !== undefined || sourceErrors.length > 0 || outcomes.some((outcome) => outcome.error);
    const runStatus = interrupted ? "interrupted" : failed ? "failed" : "ok";
    const calls = (session?.client.stats.calls ?? 0) + (ado ? adoCalls(ado, adoSources) : 0);
    store.finishRun(runId, {
      status: runStatus,
      calls,
      points: session?.client.stats.points ?? 0,
      detail: runDetail(sourceErrors, outcomes, failure),
    });
    if (failure !== undefined) throw failure;

    // Facts follow whatever was stored, even by a run that stopped partway.
    const derived = deriveFacts(store, config);

    const changed = outcomes.reduce(
      (sum, outcome) =>
        sum + outcome.walks.reduce((n, walk: { newVersions: number }) => n + walk.newVersions, 0),
      0,
    );
    const upToDate = outcomes.filter((o) => !o.error && o.walks.length === 0).length;
    print();
    if (interrupted) {
      print(status("warn", "Stopped", `after ${elapsed()}. The next sync carries on from here.`));
    } else {
      print(
        status(
          failed ? "fail" : "ok",
          "Synced",
          `${plural(outcomes.length, "repo")} in ${elapsed()}: ${num(changed)} new or changed ` +
            `PR versions${upToDate > 0 ? `; ${num(upToDate)} already up to date` : ""}`,
        ),
      );
    }
    const left = session?.client.remaining == null ? "" : `, ${num(session.client.remaining)} left`;
    const points = session ? `, ${plural(session.client.stats.points, "point")}${left}` : "";
    print(
      status(
        "info",
        "",
        dim(`${plural(calls, "call")}${points} · data in ${relative(process.cwd(), dbPath)}`),
      ),
    );
    if (derived.derived > 0) {
      print(
        status(
          "info",
          "",
          dim(
            `metrics recomputed for ${plural(derived.prs, "PR")} in ${derived.seconds.toFixed(1)} s`,
          ),
        ),
      );
    }
    return runStatus === "ok" ? 0 : runStatus === "interrupted" ? 130 : 1;
  } finally {
    store.releaseLock("sync");
    store.close();
  }
}

/** A repo's sync, from either provider. */
type Outcome = RepoOutcome | AdoRepoOutcome;

function adoCalls(ado: AdoConnection, sources: readonly AdoSource[]): number {
  const organizations = new Set(sources.map((s) => s.organization));
  return [...organizations].reduce(
    (n, organization) => n + ado.client(organization).stats.calls,
    0,
  );
}

function printOutcome(outcome: Outcome, print: Print): void {
  const name = outcome.repo.fullName;
  const prs = outcome.walks.reduce((sum, walk) => sum + walk.prs, 0);
  if (outcome.error) {
    const kept =
      prs > 0 ? ` ${plural(prs, "PR")} were stored first; the next sync resumes from there.` : "";
    print(marked("fail", `${name}: ${outcome.error}.${kept}`));
    return;
  }
  if (outcome.walks.length === 0) return; // up to date: counted in the summary instead
  const added = outcome.walks.reduce((sum, walk) => sum + walk.newVersions, 0);
  const unchanged = (outcome.walks as { unchanged?: number }[]).reduce(
    (sum, walk) => sum + (walk.unchanged ?? 0),
    0,
  );
  const checked =
    unchanged > 0 ? `; ${plural(unchanged, "open PR")} unchanged, not read again` : "";
  const walks = (outcome.walks as { walk: string; pages: number }[])
    .map((walk) => `${WALKS[walk.walk as WalkName] ?? walk.walk}: ${plural(walk.pages, "page")}`)
    .join(", ");
  if (outcome.interrupted) {
    print(
      marked("warn", `${name}: stopped after ${plural(prs, "PR")}; the next sync resumes here`),
    );
    return;
  }
  print(
    marked(
      "ok",
      `${name}: ${plural(prs, "PR")} fetched, ${num(added)} new or changed${checked} ${dim(`(${walks})`)}`,
    ),
  );
}

/** What the run record keeps about this run. */
function runDetail(
  sourceErrors: { source: string; error: string }[],
  outcomes: Outcome[],
  failure: unknown,
) {
  return {
    sourceErrors,
    repos: outcomes.map((outcome) => ({
      repo: outcome.repo.fullName,
      walks: outcome.walks,
      ...(outcome.interrupted && { interrupted: true }),
      ...(outcome.error && { error: outcome.error }),
    })),
    ...(failure !== undefined && {
      error: failure instanceof Error ? failure.message : String(failure),
    }),
  };
}
