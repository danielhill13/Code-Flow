// What a change of rules would do: the same PRs derived twice, compared. Used by
// `codeflow rules test` and, in the web app, by the rule editor's live preview.
import type { Exclusion, PrFact } from "./facts.ts";
import { isInternal } from "./selection.ts";

export type PrChange = {
  id: string;
  repo: string;
  number: number;
  title: string;
  /** Why it isn't counted, before and after; null where it is counted. */
  before: Exclusion | null;
  after: Exclusion | null;
  /** The rule that now leaves it out, when one does. */
  rule: string | null;
};

export type RuleImpact = {
  /** PRs counted before and not after, and the other way round. */
  leftOut: PrChange[];
  broughtIn: PrChange[];
  /** PRs whose author would now count as internal, or as external, where they didn't. */
  internal: PrChange[];
  external: PrChange[];
  /** Every PR a rule applies to after the change, by rule id. */
  applied: Record<string, number>;
};

export function ruleImpact(before: readonly PrFact[], after: readonly PrFact[]): RuleImpact {
  const old = new Map(before.map((pr) => [pr.id, pr]));
  const impact: RuleImpact = {
    leftOut: [],
    broughtIn: [],
    internal: [],
    external: [],
    applied: {},
  };
  for (const pr of after) {
    for (const id of pr.rules) impact.applied[id] = (impact.applied[id] ?? 0) + 1;
    const was = old.get(pr.id);
    if (!was) continue;
    const change: PrChange = {
      id: pr.id,
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      before: was.exclusion,
      after: pr.exclusion,
      rule: pr.excludedBy,
    };
    if (was.counted && !pr.counted) impact.leftOut.push(change);
    if (!was.counted && pr.counted) impact.broughtIn.push(change);
    // What a reader sees changes only when the answer does, not when a rule repeats GitHub's.
    const now = isInternal(pr);
    if (now !== isInternal(was)) (now ? impact.internal : impact.external).push(change);
  }
  return impact;
}
