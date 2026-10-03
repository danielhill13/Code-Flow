/**
 * How sync walks a repo's pull requests.
 *
 * GitHub lists a repo's PRs ordered by last update and pages through them with keyset cursors: a
 * cursor encodes the (updatedAt, id) of the last PR on its page. A cursor therefore stays valid
 * however long it is kept, and a PR that changes mid-walk jumps to the top of the order instead
 * of shifting the pages below it. Three walks build on that:
 *
 * - **backfill**: newest first, down to `since`. Its cursor (`tailCursor`) is kept, so an
 *   interrupted backfill resumes where it stopped, and moving `since` earlier extends it.
 * - **updates**: newest first, down to the watermark, the newest `updatedAt` up to which the
 *   store holds every PR's current version. Skipped when the repo's latest PR activity is not
 *   past the watermark, so an idle repo costs nothing.
 * - **open sweep**: once per repo, oldest first, the open PRs last updated before `since`. The
 *   backfill never reaches them, but they are still work in progress.
 *
 * Each page is stored together with its walk's progress in one transaction, so a run can stop at
 * any point and the next one carries on without fetching anything twice. A PR that changes after
 * its page was fetched gets an `updatedAt` past the watermark, so the next update walk finds it.
 */
import type { PrVersion, RepoRecord, Store, SyncState } from "../../store/store.ts";
import { type GitHubClient, graphqlErrors } from "./client.ts";
import type { Repo } from "./discover.ts";
import {
  fetchPrPage,
  type GhPullRequest,
  type Page,
  type PageRequest,
  type PrState,
} from "./pulls.ts";

export type WalkName = "updates" | "backfill" | "open sweep";

export type WalkProgress = {
  walk: WalkName;
  pages: number;
  prs: number;
  /** PR versions the store did not have yet. */
  newVersions: number;
};

export type RepoSyncResult = { walks: WalkProgress[]; interrupted: boolean };

export type RepoSyncOptions = {
  since: string;
  /** The repo's most recent PR update, as discovery saw it at the start of the run. */
  lastPrActivity: string | null;
  state: SyncState;
  fetchPage: (request: PageRequest) => Promise<Page>;
  /** Stores a page and a sync-state patch in one transaction; returns how many versions were new. */
  savePage: (prs: GhPullRequest[], patch: Partial<SyncState>) => number;
  signal?: AbortSignal;
  onProgress?: (progress: WalkProgress) => void;
};

type WalkSpec = {
  name: WalkName;
  after: string | null;
  states: PrState[] | null;
  direction: "ASC" | "DESC";
  /** True for a PR beyond the walk's range. The walk ends with the page that reaches one. */
  pastEnd: (pr: GhPullRequest) => boolean;
  /** The sync-state patch to store with a page. */
  patch: (page: Page, done: boolean) => Partial<SyncState>;
};

/** Brings one repo up to date. Stops between pages when `signal` aborts. */
export async function syncRepo(options: RepoSyncOptions): Promise<RepoSyncResult> {
  const { since, state } = options;
  const walks: WalkProgress[] = [];
  const run = async (spec: WalkSpec) => {
    const { progress, interrupted } = await walk(options, spec);
    walks.push(progress);
    return interrupted;
  };

  // Updates first: they are what a regular run is for, and they never depend on the others.
  const { watermark, headCursor } = state;
  const activity = options.lastPrActivity;
  if (watermark !== null && (headCursor !== null || (activity !== null && activity > watermark))) {
    let newest = state.headNewest; // set when resuming an interrupted update walk
    const interrupted = await run({
      name: "updates",
      after: headCursor,
      states: null,
      direction: "DESC",
      pastEnd: (pr) => pr.updatedAt < watermark,
      patch: (page, done) => {
        newest ??= page.prs[0]?.updatedAt ?? watermark;
        return done
          ? {
              watermark: newest > watermark ? newest : watermark,
              headCursor: null,
              headNewest: null,
            }
          : { headCursor: page.endCursor, headNewest: newest };
      },
    });
    if (interrupted) return { walks, interrupted };
  }

  if (state.coveredSince === null || since < state.coveredSince) {
    let after = state.tailCursor;
    let needsWatermark = state.watermark === null;
    const interrupted = await run({
      name: "backfill",
      after,
      states: null,
      direction: "DESC",
      pastEnd: (pr) => pr.updatedAt < since,
      patch: (page, done) => {
        after = page.endCursor ?? after;
        const patch: Partial<SyncState> = { tailCursor: after };
        if (needsWatermark) {
          // Everything the backfill finds is at least this old; anything newer is the update
          // walk's job, from the next run on.
          patch.watermark = page.prs[0]?.updatedAt ?? since;
          needsWatermark = false;
        }
        if (done) patch.coveredSince = since;
        return patch;
      },
    });
    if (interrupted) return { walks, interrupted };
  }

  if (!state.openSwept) {
    const interrupted = await run({
      name: "open sweep",
      after: state.sweepCursor,
      states: ["OPEN"],
      direction: "ASC",
      pastEnd: (pr) => pr.updatedAt >= since,
      patch: (page, done) =>
        done ? { openSwept: true, sweepCursor: null } : { sweepCursor: page.endCursor },
    });
    if (interrupted) return { walks, interrupted };
  }

  return { walks, interrupted: false };
}

async function walk(
  options: RepoSyncOptions,
  spec: WalkSpec,
): Promise<{ progress: WalkProgress; interrupted: boolean }> {
  const progress: WalkProgress = { walk: spec.name, pages: 0, prs: 0, newVersions: 0 };
  let after = spec.after;
  for (;;) {
    if (options.signal?.aborted) return { progress, interrupted: true };
    const page = await options.fetchPage({
      after,
      states: spec.states,
      direction: spec.direction,
    });
    const done = !page.hasNextPage || page.prs.some(spec.pastEnd);
    progress.newVersions += options.savePage(page.prs, spec.patch(page, done));
    progress.pages += 1;
    progress.prs += page.prs.length;
    options.onProgress?.({ ...progress });
    if (done) return { progress, interrupted: false };
    after = page.endCursor;
  }
}

export type RepoOutcome = {
  repo: Repo;
  walks: WalkProgress[];
  /** The run was stopped partway through this repo; the next run resumes it. */
  interrupted?: boolean;
  /** Why this repo failed. Other repos carry on regardless. */
  error?: string;
};

/** Fetches one page of a repo's PRs: fetchPrPage in practice, a fake in tests. */
export type RepoPageFetcher = (repo: Repo, request: PageRequest) => Promise<Page>;

/** A page fetcher that reads from GitHub through `client`. */
export const fetchFrom =
  (client: Pick<GitHubClient, "graphql">): RepoPageFetcher =>
  (repo, request) =>
    fetchPrPage(client, repo, request);

/** Syncs each repo in turn. A failing repo is recorded and skipped; an abort stops the run. */
export async function syncRepos(options: {
  fetchPage: RepoPageFetcher;
  store: Store;
  runId: number;
  repos: readonly Repo[];
  since: string;
  signal?: AbortSignal;
  onStart?: (repo: Repo) => void;
  onProgress?: (repo: Repo, progress: WalkProgress) => void;
  onDone?: (outcome: RepoOutcome) => void;
}): Promise<{ outcomes: RepoOutcome[]; interrupted: boolean }> {
  const { store, runId, since, signal } = options;
  const outcomes: RepoOutcome[] = [];
  for (const repo of options.repos) {
    if (signal?.aborted) return { outcomes, interrupted: true };
    options.onStart?.(repo);
    const state = store.upsertRepo(toRepoRecord(repo));
    // Kept per walk as pages land, so a repo that fails partway still reports what it stored.
    const progress = new Map<WalkName, WalkProgress>();
    let outcome: RepoOutcome;
    let interrupted = false;
    try {
      const result = await syncRepo({
        since,
        lastPrActivity: repo.lastPrActivity,
        state,
        fetchPage: (request) => options.fetchPage(repo, request),
        savePage: (prs, patch) => store.savePage(repo.id, prs.map(toPrVersion), runId, patch),
        ...(signal && { signal }),
        onProgress: (walk) => {
          progress.set(walk.walk, walk);
          options.onProgress?.(repo, walk);
        },
      });
      outcome = { repo, walks: result.walks, ...(result.interrupted && { interrupted: true }) };
      interrupted = result.interrupted;
    } catch (err) {
      outcome = { repo, walks: [...progress.values()], error: describeError(err) };
    }
    outcomes.push(outcome);
    options.onDone?.(outcome);
    if (interrupted) return { outcomes, interrupted };
  }
  return { outcomes, interrupted: false };
}

function toRepoRecord(repo: Repo): RepoRecord {
  return {
    id: repo.id,
    provider: "github",
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
    archived: repo.archived,
    fork: repo.fork,
    private: repo.private,
  };
}

export function toPrVersion(pr: GhPullRequest): PrVersion {
  return { id: pr.id, number: pr.number, state: pr.state, updatedAt: pr.updatedAt, payload: pr };
}

function describeError(err: unknown): string {
  const errors = graphqlErrors(err);
  if (errors) return errors.map((e) => e.message).join("; ");
  return err instanceof Error ? err.message : String(err);
}
