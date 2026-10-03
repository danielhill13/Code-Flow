import { relative } from "node:path";
import { CodeflowError } from "../errors.ts";
import { discoverRepos, type SourceResult, sourceName } from "../providers/github/discover.ts";
import { fetchFrom, type RepoOutcome, syncRepos, type WalkName } from "../providers/github/sync.ts";
import { Store } from "../store/store.ts";
import { dim, duration, marked, num, plural, status } from "./format.ts";
import { Progress } from "./progress.ts";
import { connect, type Print } from "./session.ts";

export type SyncOptions = { config: string };

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
  const session = await connect(options.config, print);
  if (!session) return 1;
  const { config, client, dbPath } = session;

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
    const started = performance.now();
    const elapsed = () => duration((performance.now() - started) / 1000);

    // First Ctrl-C: store the page in flight, then stop. Second: quit now. Either way nothing
    // stored is lost, and the next sync carries on from the last stored page.
    const abort = new AbortController();
    const onInterrupt = () => {
      if (abort.signal.aborted) process.exit(130);
      print(status("warn", "Stopping", "after the current page (Ctrl-C again to quit now)"));
      abort.abort();
    };
    process.on("SIGINT", onInterrupt);

    let sources: SourceResult[] = [];
    let outcomes: RepoOutcome[] = [];
    let interrupted = false;
    let failure: unknown;
    try {
      sources = await discoverRepos(client, config.sources);
      for (const source of sources) {
        if (source.error) {
          print(status("fail", "Source", `${sourceName(source.source)}: ${source.error}`));
        }
      }
      const repos = sources.flatMap((source) => source.repos);
      if (repos.length === 0) {
        throw new CodeflowError(
          "No repos selected, so there is nothing to sync. See: codeflow doctor",
        );
      }
      print(status("ok", "Repos", `${plural(repos.length, "repo")} selected`));
      print();
      ({ outcomes, interrupted } = await syncRepos({
        fetchPage: fetchFrom(client),
        store,
        runId,
        repos,
        since: config.since,
        signal: abort.signal,
        onStart: (repo) => progress.update(`${repo.fullName}: checking`),
        onProgress: (repo, walk) =>
          progress.update(
            `${repo.fullName}: ${WALKS[walk.walk]}, ${plural(walk.prs, "PR")} in ` +
              `${plural(walk.pages, "page")} · ${elapsed()}`,
          ),
        onDone: (outcome) => printOutcome(outcome, print),
      }));
    } catch (err) {
      failure = err;
    } finally {
      process.off("SIGINT", onInterrupt);
      progress.clear();
    }

    const failed =
      failure !== undefined ||
      sources.some((source) => source.error) ||
      outcomes.some((outcome) => outcome.error);
    const runStatus = interrupted ? "interrupted" : failed ? "failed" : "ok";
    store.finishRun(runId, {
      status: runStatus,
      calls: client.stats.calls,
      points: client.stats.points,
      detail: runDetail(sources, outcomes, failure),
    });
    if (failure !== undefined) throw failure;

    const changed = outcomes.reduce(
      (sum, outcome) => sum + outcome.walks.reduce((n, walk) => n + walk.newVersions, 0),
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
    const left = client.remaining === null ? "" : `, ${num(client.remaining)} left`;
    print(
      status(
        "info",
        "",
        dim(
          `${plural(client.stats.calls, "call")}, ${plural(client.stats.points, "point")}${left}` +
            ` · data in ${relative(process.cwd(), dbPath)}`,
        ),
      ),
    );
    return runStatus === "ok" ? 0 : runStatus === "interrupted" ? 130 : 1;
  } finally {
    store.releaseLock("sync");
    store.close();
  }
}

function printOutcome(outcome: RepoOutcome, print: Print): void {
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
  const walks = outcome.walks
    .map((walk) => `${WALKS[walk.walk]}: ${plural(walk.pages, "page")}`)
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
      `${name}: ${plural(prs, "PR")} fetched, ${num(added)} new or changed ${dim(`(${walks})`)}`,
    ),
  );
}

/** What the run record keeps about this run. */
function runDetail(sources: SourceResult[], outcomes: RepoOutcome[], failure: unknown) {
  return {
    sourceErrors: sources
      .filter((source) => source.error)
      .map((source) => ({ source: sourceName(source.source), error: source.error })),
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
