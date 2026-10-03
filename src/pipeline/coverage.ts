import type { Period } from "../core/periods.ts";
import { CodeflowError } from "../errors.ts";
import type { Store } from "../store/store.ts";

/**
 * The first day the synced data fully covers for these repos: sync stores every PR updated since
 * `since`, so any period from then on is complete. Throws while a repo's first sync is
 * unfinished, since nothing can be said about its coverage yet.
 */
export function coveredFrom(store: Store, repos: readonly string[]): string {
  const selected = store.repoSummaries().filter((repo) => repos.includes(repo.fullName));
  const unfinished = selected.filter((repo) => repo.coveredSince === null);
  if (unfinished.length > 0) {
    const names = unfinished.map((repo) => repo.fullName).join(", ");
    throw new CodeflowError(
      `The first sync of ${names} hasn't finished. Run codeflow sync to finish it.`,
    );
  }
  return selected.reduce((latest, repo) => {
    const since = repo.coveredSince ?? "";
    return since > latest ? since : latest;
  }, "");
}

/**
 * Refuses a period that starts before the data does: it would hold only the PRs that happened
 * to be updated later, and its numbers would look real without being real.
 */
export function assertCovered(period: Period, from: string): void {
  if (period.start < from) {
    throw new CodeflowError(
      `${period.label} starts before ${from}, where the synced data begins, so PRs would be missing. ` +
        "Pick a later period, or move `since` earlier in codeflow.yml and sync again.",
    );
  }
}
