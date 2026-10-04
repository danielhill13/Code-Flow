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
import type { AdoClient } from "./client.ts";
import { adoPrId } from "./normalize.ts";
import { fetchPr, listPrs, versionOf } from "./pulls.ts";
import type { AdoPayload, AdoPullRequest, AdoRepo } from "./types.ts";

export type AdoWalkName = "backfill" | "open PRs" | "closed since";

export type AdoWalk = { walk: AdoWalkName; pages: number; prs: number; newVersions: number };

export type AdoRepoOutcome = {
  repo: AdoRepo;
  walks: AdoWalk[];
  interrupted?: boolean;
  error?: string;
};

/** Seconds of overlap with the last sync, so a PR closing as it started isn't missed. */
const OVERLAP_MS = 60 * 60 * 1000;

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
    const details = async (prs: readonly AdoPullRequest[]) => {
      const payloads: AdoPayload[] = [];
      for (const pr of prs) {
        if (signal?.aborted) return null;
        payloads.push(await fetchPr(client, repo, pr));
      }
      return payloads;
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
        const payloads = await details(wanted);
        if (payloads === null) return { ...outcome, interrupted: true };
        walk.prs += payloads.length;
        const oldest = page.prs.at(-1)?.creationDate.slice(0, 10);
        const done = page.next === null || (oldest !== undefined && oldest < since);
        store_(
          walk,
          payloads,
          done
            ? { coveredSince: since, tailCursor: null }
            : { tailCursor: String(page.next ?? skip) },
        );
        if (done) break;
        skip = page.next ?? skip;
      }
    }

    // 2. Every open PR: any of them may have changed since the last sync.
    {
      const walk: AdoWalk = { walk: "open PRs", pages: 0, prs: 0, newVersions: 0 };
      walks.push(walk);
      let skip: number | null = 0;
      while (skip !== null) {
        const page = await listPrs(client, repo, { status: "active", skip });
        walk.pages += 1;
        const payloads = await details(page.prs);
        if (payloads === null) return { ...outcome, interrupted: true };
        walk.prs += payloads.length;
        store_(walk, payloads, {});
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
          const payloads = await details(page.prs.filter((pr) => (pr.closedDate ?? "") >= from));
          if (payloads === null) return { ...outcome, interrupted: true };
          walk.prs += payloads.length;
          store_(walk, payloads, {});
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
