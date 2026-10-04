// Churn (decision D44): code changed again soon after it merged. For each merged PR, the first
// later PR merged into the same branch that changed one of its product files, and the first of
// those by the same person. Read from the files each PR changed, which both hosts give, so it
// needs nothing new from them. All PRs must be from one repo.
import type { PrFact } from "./facts.ts";
import type { PrModel } from "./model.ts";

/** What churn needs of a PR: when and where it merged, by whom, and its product files. */
export type ChurnClues = {
  id: string;
  number: number;
  person: string;
  baseBranch: string;
  mergedAt: string | null;
  /** Its product files' paths; null when the host didn't list every file. */
  files: string[] | null;
  /** A bot's PR: it can be touched again, but doesn't touch others. */
  bot: boolean;
};

export function churnClues(
  pr: PrModel,
  fact: PrFact,
  classify: (repo: string, path: string) => string,
): ChurnClues {
  return {
    id: pr.id,
    number: pr.number,
    person: fact.person.toLowerCase(),
    baseBranch: pr.baseBranch,
    mergedAt: pr.mergedAt,
    files:
      fact.productFiles === null
        ? null
        : pr.files
            .filter((file) => classify(pr.repo, file.path) === "product")
            .map((file) => file.path),
    bot: fact.authorIsBot,
  };
}

/**
 * Sets `touchedAgainBy`/`touchedAgainAt` and `followUpBy`/`followUpAt` on each merged PR whose
 * product files a later merged PR (into the same branch, not a bot's) changed.
 */
export function linkChurn(prs: readonly ChurnClues[], facts: ReadonlyMap<string, PrFact>): void {
  const merged = prs
    .filter((pr): pr is ChurnClues & { mergedAt: string } => pr.mergedAt !== null)
    .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.number - b.number);
  // Each branch's file → the PRs that changed it, in merge order.
  const touches = new Map<string, (typeof merged)[number][]>();
  for (const pr of merged) {
    if (pr.bot || pr.files === null) continue;
    for (const path of pr.files) {
      const key = `${pr.baseBranch}\u0000${path}`;
      const list = touches.get(key) ?? [];
      list.push(pr);
      touches.set(key, list);
    }
  }
  for (const pr of merged) {
    const fact = facts.get(pr.id);
    if (!fact || pr.files === null) continue;
    let first: (typeof merged)[number] | null = null;
    let own: (typeof merged)[number] | null = null;
    for (const path of pr.files) {
      // This file's PRs merged after this one, earliest first: the first is the earliest touch
      // through this file, and the first by the same person the earliest follow-up through it.
      let seenFirst = false;
      for (const later of touches.get(`${pr.baseBranch}\u0000${path}`) ?? []) {
        if (later === pr || later.mergedAt <= pr.mergedAt) continue;
        if (!seenFirst) {
          seenFirst = true;
          if (first === null || later.mergedAt < first.mergedAt) first = later;
        }
        if (later.person === pr.person) {
          if (own === null || later.mergedAt < own.mergedAt) own = later;
          break;
        }
      }
    }
    if (first) {
      fact.touchedAgainBy = first.number;
      fact.touchedAgainAt = first.mergedAt;
    }
    if (own) {
      fact.followUpBy = own.number;
      fact.followUpAt = own.mergedAt;
    }
  }
}
