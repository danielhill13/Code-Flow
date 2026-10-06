// The same fix landing twice (decision D48): a ticket's PR merged into one measured branch (a
// defect fix into prod), then the same change brought to another from a differently named branch
// (into develop). The org names its ticket IDs (`ticket_pattern`, such as ADO-\d+); a PR carries
// the IDs in its head branch, title or description. Within a repo, a counted merged PR is a duplicate when an
// earlier counted PR with one of its tickets merged into a different branch. PRs for one ticket
// into the same branch all count: a story split into parts is separate work.
import type { PrFact } from "./facts.ts";

/** The ticket IDs a PR names, upper-cased, in its head branch, title or description. */
export function ticketsOf(
  pr: { headBranch: string; title: string; body?: string },
  pattern: RegExp | null,
): string[] {
  if (!pattern) return [];
  const found = new Set<string>();
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  for (const text of [pr.headBranch, pr.title, pr.body ?? ""]) {
    // With a capture group, the group is the ID: "ADO-12340" and "12340" are one ticket.
    for (const match of text.matchAll(global)) found.add((match[1] ?? match[0]).toUpperCase());
  }
  return [...found].sort();
}

/**
 * Marks each counted merged PR whose ticket an earlier counted PR already landed on another
 * branch: not counted, `exclusion: "duplicate"`, `duplicateOf` the earlier PR. All PRs are one
 * repo's.
 */
export function linkDuplicates(facts: Iterable<PrFact>): void {
  const merged = [...facts]
    .filter((pr) => pr.counted && pr.mergedAt !== null && pr.tickets.length > 0)
    .sort((a, b) => (a.mergedAt ?? "").localeCompare(b.mergedAt ?? "") || a.number - b.number);
  // Each ticket: the first counted PR to land it on each branch.
  const landed = new Map<string, Map<string, PrFact>>();
  for (const pr of merged) {
    let original: PrFact | null = null;
    for (const ticket of pr.tickets) {
      for (const [branch, first] of landed.get(ticket) ?? []) {
        if (
          branch !== pr.baseBranch &&
          (original === null || (first.mergedAt ?? "") < (original.mergedAt ?? ""))
        ) {
          original = first;
        }
      }
    }
    if (original) {
      pr.counted = false;
      pr.exclusion = "duplicate";
      pr.duplicateOf = original.number;
      continue;
    }
    for (const ticket of pr.tickets) {
      const branches = landed.get(ticket) ?? new Map<string, PrFact>();
      if (!branches.has(pr.baseBranch)) branches.set(pr.baseBranch, pr);
      landed.set(ticket, branches);
    }
  }
}
