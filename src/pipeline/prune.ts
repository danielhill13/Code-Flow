// Repos stored for an org that its sources no longer select, and removing their data when asked
// (decision D43). The CLI's `prune` and Setup › Repos both call these.

import type { Config } from "../config/schema.ts";
import { measuredBy } from "../config/scope.ts";
import type { Store } from "../store/store.ts";

export type Unmeasured = { id: string; fullName: string; provider: string; prs: number };

/** Stored repos no source names any more, with how many PRs each holds. */
export function unmeasuredRepos(store: Store, config: Config): Unmeasured[] {
  const counts = new Map(
    store
      .facts()
      .reduce((m, pr) => m.set(pr.repoId, (m.get(pr.repoId) ?? 0) + 1), new Map<string, number>()),
  );
  return store
    .repos()
    .filter((repo) => !measuredBy(config.sources, repo))
    .map((repo) => ({
      id: repo.id,
      fullName: repo.fullName,
      provider: repo.provider,
      prs: counts.get(repo.id) ?? 0,
    }));
}

/**
 * Removes every stored repo the sources no longer select. Waits for no sync: it holds the sync
 * lock while it works, so it refuses (with the reason) while one is running.
 */
export function pruneRepos(store: Store, config: Config): Unmeasured[] {
  store.acquireLock("sync");
  try {
    const gone = unmeasuredRepos(store, config);
    for (const repo of gone) store.removeRepo(repo.id);
    return gone;
  } finally {
    store.releaseLock("sync");
  }
}
