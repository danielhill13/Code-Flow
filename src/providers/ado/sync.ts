// Syncing an Azure DevOps repo's PRs into the store (decision D40). Azure DevOps can't list PRs by
// when they last changed, so each sync walks what can have changed:
//
// - backfill: the first time (or when `since` moves earlier), every PR created since `since`,
//   newest first, resumable from the page it stopped at (`tailCursor` holds the offset);
// - open PRs: every active PR, whatever its age, since any of them may have moved;
// - closed since: PRs completed or abandoned since the last sync started (`watermark`).
//
// A PR fetched again with nothing new has the same version (pulls.ts versionOf), so the store
// keeps one copy. Every request is paced by the client (D41).
import type { Store } from "../../store/store.ts";
import { type AdoClient, AdoError } from "./client.ts";
import { adoPrId } from "./normalize.ts";
import { fetchPr, listPrs, openSignature, prThreads, versionOf } from "./pulls.ts";
import type { AdoPayload, AdoPullRequest, AdoRepo } from "./types.ts";

export type AdoWalkName = "backfill" | "open PRs" | "closed since";

export type AdoWalk = {
  walk: AdoWalkName;
  pages: number;
  prs: number;
  newVersions: number;
  /** Open PRs found unchanged by one request, and so not read again. */
  unchanged?: number;
  /** PRs Azure DevOps wouldn't give, with what it said: skipped so the rest still sync. */
  skipped?: { number: number; error: string }[];
};

export type AdoRepoOutcome = {
  repo: AdoRepo;
  walks: AdoWalk[];
  interrupted?: boolean;
  error?: string;
};

/** PRs fetched between saves: progress shows, and a stop keeps, every few PRs. */
const SAVE_EVERY = 5;

/** Seconds of overlap with the last sync, so a PR closing as it started isn't missed. */
const OVERLAP_MS = 60 * 60 * 1000;

/** Whether an error is one PR's alone: Azure DevOps answered, just not with that PR's data. */
function skippable(err: unknown): boolean {
  return err instanceof AdoError && err.status !== 401 && err.status !== 429 && err.status !== 503;
}

/** The store's id for an Azure DevOps repo: its id, which survives renames. */
export const adoRepoId = (repo: AdoRepo) => `ado:${repo.id}`;

const STATE: Record<AdoPullRequest["status"], string> = {
  active: "OPEN",
  completed: "MERGED",
  abandoned: "CLOSED",
  notSet: "OPEN",
};

export async function syncAdoRepo(options: {
  client: AdoClient;
  store: Store;
  runId: number;
  repo: AdoRepo;
  since: string;
  /** When this sync started: the next sync's `watermark`. */
  startedAt: string;
  signal?: AbortSignal;
  onProgress?: (walk: AdoWalk) => void;
  /** The repo's local copy, if it has one (D46): line counts are read there. */
  copy?: string;
}): Promise<AdoRepoOutcome> {
  const { client, store, runId, repo, since, signal } = options;
  const id = adoRepoId(repo);
  const walks: AdoWalk[] = [];
  const outcome: AdoRepoOutcome = { repo, walks };
  try {
    const state = store.upsertRepo({
      id,
      provider: "ado",
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      archived: repo.disabled,
      fork: repo.fork,
      private: true,
    });

    /** Fetches each PR's details and stores them with the state given, page by page. */
    const store_ = (
      walk: AdoWalk,
      payloads: AdoPayload[],
      next: Parameters<Store["savePage"]>[3],
    ) => {
      walk.newVersions += store.savePage(
        id,
        payloads.map((payload) => ({
          id: adoPrId(client.organization, payload.pr.pullRequestId),
          number: payload.pr.pullRequestId,
          state: STATE[payload.pr.status],
          updatedAt: versionOf(payload),
          payload,
        })),
        runId,
        next,
      );
      options.onProgress?.(walk);
    };
    /** Threads just read while checking open PRs: not asked for twice. */
    let reuse = new Map<number, AdoPayload["threads"]>();

    /**
     * Fetches each PR's details, storing them every few PRs so progress shows (and survives a
     * stop) long before a page of 100 is done; the page's cursor is saved with its last batch.
     * Returns how many were fetched, or null when stopped.
     */
    const details = async (
      walk: AdoWalk,
      prs: readonly AdoPullRequest[],
      next: Parameters<Store["savePage"]>[3],
    ): Promise<number | null> => {
      let batch: AdoPayload[] = [];
      for (const pr of prs) {
        if (signal?.aborted) {
          if (batch.length > 0) store_(walk, batch, {});
          return null;
        }
        try {
          batch.push(await fetchPr(client, repo, pr, reuse.get(pr.pullRequestId), options.copy));
        } catch (err) {
          // A refused token, or no network, stops the repo: nothing else would read either.
          // One PR Azure DevOps won't give is skipped and reported, so it can't hold back every
          // PR after it, sync after sync.
          if (!skippable(err)) throw err;
          walk.skipped = [
            ...(walk.skipped ?? []),
            { number: pr.pullRequestId, error: (err as Error).message },
          ];
          continue;
        }
        walk.prs += 1;
        if (batch.length === SAVE_EVERY) {
          store_(walk, batch, {});
          batch = [];
        }
      }
      store_(walk, batch, next);
      return prs.length;
    };

    // 1. Backfill to `since`: PRs newest-created first, so it stops at the first one older.
    const extending = state.coveredSince !== null && since < state.coveredSince;
    if (state.coveredSince === null || extending) {
      const walk: AdoWalk = { walk: "backfill", pages: 0, prs: 0, newVersions: 0 };
      walks.push(walk);
      let skip = Number(state.tailCursor ?? 0);
      for (;;) {
        const page = await listPrs(client, repo, { status: "all", skip });
        walk.pages += 1;
        const wanted = page.prs.filter(
          (pr) =>
            pr.creationDate.slice(0, 10) >= since &&
            // Extending further back: what's newer is stored already.
            (!extending || pr.creationDate.slice(0, 10) < (state.coveredSince ?? "")),
        );
        const oldest = page.prs.at(-1)?.creationDate.slice(0, 10);
        const done = page.next === null || (oldest !== undefined && oldest < since);
        const fetched = await details(
          walk,
          wanted,
          done
            ? { coveredSince: since, tailCursor: null }
            : { tailCursor: String(page.next ?? skip) },
        );
        if (fetched === null) return { ...outcome, interrupted: true };
        if (done) break;
        skip = page.next ?? skip;
      }
    }

    // 2. Every open PR: any of them may have changed since the last sync. Azure DevOps can't say
    // which, so each is checked with one request (its threads) against what is stored, and only
    // one that moved is read whole again.
    {
      const walk: AdoWalk = { walk: "open PRs", pages: 0, prs: 0, newVersions: 0, unchanged: 0 };
      walks.push(walk);
      const stored = new Map<number, string>();
      for (const version of store.latestPrs(id)) {
        const payload = version.payload as AdoPayload;
        if (payload.pr?.status === "active") {
          stored.set(payload.pr.pullRequestId, openSignature(payload.pr, payload.threads));
        }
      }
      let skip: number | null = 0;
      while (skip !== null) {
        const page = await listPrs(client, repo, { status: "active", skip });
        walk.pages += 1;
        const moved: AdoPullRequest[] = [];
        const threadsOf = new Map<number, AdoPayload["threads"]>();
        for (const pr of page.prs) {
          if (signal?.aborted) return { ...outcome, interrupted: true };
          const before = stored.get(pr.pullRequestId);
          if (before === undefined) {
            moved.push(pr);
            continue;
          }
          const threads = (await prThreads(client, repo, pr)).value.filter((t) => !t.isDeleted);
          if (openSignature(pr, threads) === before) {
            walk.unchanged = (walk.unchanged ?? 0) + 1;
            options.onProgress?.(walk);
          } else {
            threadsOf.set(pr.pullRequestId, threads);
            moved.push(pr);
          }
        }
        reuse = threadsOf;
        if ((await details(walk, moved, {})) === null) return { ...outcome, interrupted: true };
        reuse = new Map();
        skip = page.next;
      }
    }

    // 3. What closed since the last sync started.
    if (state.watermark !== null) {
      const walk: AdoWalk = { walk: "closed since", pages: 0, prs: 0, newVersions: 0 };
      walks.push(walk);
      const from = new Date(Date.parse(state.watermark) - OVERLAP_MS).toISOString();
      for (const status of ["completed", "abandoned"] as const) {
        let skip: number | null = 0;
        while (skip !== null) {
          const page = await listPrs(client, repo, { status, skip, closedSince: from });
          walk.pages += 1;
          // Checked here too: a server that ignores the date filter mustn't cost every PR's details.
          const closed = page.prs.filter((pr) => (pr.closedDate ?? "") >= from);
          if ((await details(walk, closed, {})) === null) return { ...outcome, interrupted: true };
          skip = page.next;
        }
      }
    }

    store.savePage(id, [], runId, { watermark: options.startedAt });
    return outcome;
  } catch (err) {
    return { ...outcome, error: err instanceof Error ? err.message : String(err) };
  }
}
