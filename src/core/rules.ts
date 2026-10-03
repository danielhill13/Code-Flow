// The rule engine (decision D31). An org's rules say what counts, how its repos are read and
// how its people are treated, each scoped to the whole org, some repos, teams, groups or people,
// and optionally only for PRs matching conditions. Rules are data: typed, validated, safe to
// share, and part of the fingerprint facts are derived from, so changing one re-derives.
//
// Each effect is resolved on its own. Rules apply from the least specific scope to the most
// (org, then group, team, repo, person), and within one level in order, so the more specific
// or the later rule wins.
import picomatch from "picomatch";
import { type Groups, personOf } from "./groups.ts";
import type { Bucket, PathRule } from "./paths.ts";

/** Where a rule applies. Every field given must match; within a field, any value. */
export type RuleScope = {
  repos?: string[];
  teams?: string[];
  groups?: string[];
  people?: string[];
};

/** Which PRs a rule applies to, within its scope. Every field given must match. */
export type RuleWhen = {
  /** Any of these labels. */
  labels?: string[];
  /** A regular expression the title matches, ignoring case. */
  title?: string;
  /** Base and head branch globs. */
  base?: string[];
  head?: string[];
  /** GitHub's author association: MEMBER, CONTRIBUTOR, NONE… */
  author_association?: string[];
  from_fork?: boolean;
  draft?: boolean;
  /** Opened by a bot. */
  author_bot?: boolean;
};

export type RuleEffects = {
  // What counts (PR effects).
  /** false: not counted, whatever else is true of it. true: counted, overriding a default exclusion. */
  count?: boolean;
  /** Count the author as internal (or external) for these PRs. */
  internal?: boolean;
  /** Regular expressions: comments and review bodies matching any are ignored. */
  ignore_comments?: string[];
  // Repo rules (repo effects).
  /** The branches whose PRs count. Default: the repo's default branch. */
  measured_branches?: string[];
  /** Same-repo head branches that make a PR a promotion between long-lived branches. */
  promotion_branches?: string[];
  /** What counts as product code: checked before the built-in path rules. */
  paths?: { match: string[]; bucket: Bucket }[];
  // People rules (person effects).
  /** Treat as a bot: PRs not counted, reviews not review. */
  bot?: boolean;
  /** A bot whose reviews count as review anyway. */
  bot_reviews_count?: boolean;
};

export type Rule = {
  id: string;
  description: string | null;
  enabled: boolean;
  scope: RuleScope;
  when: RuleWhen;
  /** What the rule does. Written `then:` in rules.yml, beside `when:`. */
  effects: RuleEffects;
  /** Where it came from: "rules.yml", or the shorthand key that made it ("branches"). */
  source: string;
};

/** What an effect applies to, and so which scopes and conditions it can have. */
export type EffectContext = "pr" | "repo" | "person";

export const EFFECTS: Record<keyof RuleEffects, { context: EffectContext; label: string }> = {
  count: { context: "pr", label: "Count PRs" },
  internal: { context: "pr", label: "Internal" },
  ignore_comments: { context: "pr", label: "Ignore comments" },
  measured_branches: { context: "repo", label: "Measured branches" },
  promotion_branches: { context: "repo", label: "Promotion branches" },
  paths: { context: "repo", label: "Product code paths" },
  bot: { context: "person", label: "Bot" },
  bot_reviews_count: { context: "person", label: "Bot reviews count" },
};

/** The one context all of a rule's effects share; null when they mix, which isn't allowed. */
export function contextOf(rule: Pick<Rule, "effects">): EffectContext | null {
  const contexts = new Set(
    (Object.keys(rule.effects) as (keyof RuleEffects)[]).map((key) => EFFECTS[key].context),
  );
  return contexts.size === 1 ? ([...contexts][0] ?? null) : null;
}

/**
 * Problems with a set of rules, each a sentence saying how to fix it: a repeated id, a rule with
 * no effect or with effects of different kinds, a scope or condition its effects can't use, a
 * team or group that doesn't exist, a regular expression that doesn't parse.
 */
export function ruleProblems(
  rules: readonly Rule[],
  known: { teams: readonly string[]; groups: readonly string[] },
): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const rule of rules) {
    const name = `Rule ${rule.id}`;
    if (ids.has(rule.id)) problems.push(`${name}: another rule has this id.`);
    ids.add(rule.id);
    const keys = Object.keys(rule.effects) as (keyof RuleEffects)[];
    if (keys.length === 0) {
      problems.push(`${name}: give it an effect under \`then\`.`);
      continue;
    }
    const context = contextOf(rule);
    if (context === null) {
      problems.push(
        `${name}: mixes ${keys.join(", ")}. Split it: repo rules, people rules and rules about ` +
          "what counts each go in rules of their own.",
      );
      continue;
    }
    const scoped = Object.keys(rule.scope).filter(
      (key) => (rule.scope[key as keyof RuleScope]?.length ?? 0) > 0,
    );
    const conditions = Object.keys(rule.when);
    if (context === "repo" && (scoped.some((k) => k !== "repos") || conditions.length > 0)) {
      problems.push(`${name}: ${keys.join(", ")} apply to repos, so scope it by \`repos\` only.`);
    }
    if (context === "person" && (scoped.some((k) => k !== "people") || conditions.length > 0)) {
      problems.push(`${name}: ${keys.join(", ")} apply to people, so scope it by \`people\` only.`);
    }
    for (const team of rule.scope.teams ?? []) {
      if (!known.teams.includes(team)) problems.push(`${name}: no team is called "${team}".`);
    }
    for (const group of rule.scope.groups ?? []) {
      if (!known.groups.includes(group)) problems.push(`${name}: no group is called "${group}".`);
    }
    for (const source of [rule.when.title, ...(rule.effects.ignore_comments ?? [])]) {
      if (source === undefined) continue;
      try {
        new RegExp(source, "i");
      } catch {
        problems.push(`${name}: /${source}/ isn't a valid regular expression.`);
      }
    }
  }
  return problems;
}

/** Everything about a PR its rules can test. */
export type PrContext = {
  repo: string;
  person: string;
  team: string | null;
  groups: readonly string[];
  labels: readonly string[];
  title: string;
  base: string;
  head: string;
  authorAssociation: string | null;
  fromFork: boolean;
  draft: boolean;
  authorBot: boolean;
};

export type PrOutcome = {
  count: boolean | null;
  /** The rule that decided `count`, to say why a PR isn't counted. */
  countRule: string | null;
  internal: boolean | null;
  ignore: RegExp[];
  /** Every rule that applied to the PR, in the order they applied. */
  applied: string[];
};

export type RepoOutcome = {
  measuredBranches: string[] | null;
  promotionBranches: string[] | null;
  /** Path rules, most specific first. */
  paths: PathRule[];
  applied: string[];
};

export type PersonOutcome = {
  bot: boolean | null;
  botReviewsCount: boolean | null;
  applied: string[];
};

type Compiled = Rule & {
  level: number;
  order: number;
  repo: (name: string) => boolean;
  people: Set<string> | null;
  title: RegExp | null;
  base: (branch: string) => boolean;
  head: (branch: string) => boolean;
};

const LEVEL = { org: 0, groups: 1, teams: 2, repos: 3, people: 4 } as const;

/** A rule's scope level: the most specific field it uses. */
function levelOf(scope: RuleScope): number {
  let level: number = LEVEL.org;
  for (const key of ["groups", "teams", "repos", "people"] as const) {
    if ((scope[key]?.length ?? 0) > 0) level = Math.max(level, LEVEL[key]);
  }
  return level;
}

/** Answers what an org's rules say about a repo, a person or a PR. */
export class RuleEngine {
  readonly #rules: Compiled[];
  readonly #groups: Groups;

  constructor(rules: readonly Rule[], groups: Groups) {
    this.#groups = groups;
    const glob = (patterns: string[] | undefined, nocase: boolean) =>
      patterns && patterns.length > 0 ? picomatch(patterns, { nocase, dot: true }) : () => true;
    this.#rules = rules
      .map((rule, order) => ({
        ...rule,
        level: levelOf(rule.scope),
        order,
        repo: glob(rule.scope.repos, true),
        people:
          rule.scope.people && rule.scope.people.length > 0
            ? new Set(rule.scope.people.map((p) => personOf(groups, p).toLowerCase()))
            : null,
        title: rule.when.title ? new RegExp(rule.when.title, "i") : null,
        base: glob(rule.when.base, false),
        head: glob(rule.when.head, false),
      }))
      .filter((rule) => rule.enabled)
      .sort((a, b) => a.level - b.level || a.order - b.order);
  }

  repo(name: string): RepoOutcome {
    const outcome: RepoOutcome = {
      measuredBranches: null,
      promotionBranches: null,
      paths: [],
      applied: [],
    };
    const paths: { level: number; order: number; rules: PathRule[] }[] = [];
    for (const rule of this.#rules) {
      if (contextOf(rule) !== "repo" || !rule.repo(name)) continue;
      const { effects } = rule;
      if (effects.measured_branches) outcome.measuredBranches = effects.measured_branches;
      if (effects.promotion_branches) outcome.promotionBranches = effects.promotion_branches;
      if (effects.paths) {
        paths.push({
          level: rule.level,
          order: rule.order,
          rules: effects.paths.map((p) => ({ ...p })),
        });
      }
      outcome.applied.push(rule.id);
    }
    // Path rules don't replace each other: they all apply, the most specific checked first.
    outcome.paths = paths
      .sort((a, b) => b.level - a.level || a.order - b.order)
      .flatMap((p) => p.rules);
    return outcome;
  }

  person(login: string): PersonOutcome {
    const key = personOf(this.#groups, login).toLowerCase();
    const outcome: PersonOutcome = { bot: null, botReviewsCount: null, applied: [] };
    for (const rule of this.#rules) {
      if (contextOf(rule) !== "person") continue;
      if (rule.people && !rule.people.has(key)) continue;
      if (rule.effects.bot !== undefined) outcome.bot = rule.effects.bot;
      if (rule.effects.bot_reviews_count !== undefined) {
        outcome.botReviewsCount = rule.effects.bot_reviews_count;
      }
      outcome.applied.push(rule.id);
    }
    return outcome;
  }

  pr(ctx: PrContext): PrOutcome {
    const outcome: PrOutcome = {
      count: null,
      countRule: null,
      internal: null,
      ignore: [],
      applied: [],
    };
    for (const rule of this.#rules) {
      if (contextOf(rule) !== "pr" || !this.#matches(rule, ctx)) continue;
      const { effects } = rule;
      if (effects.count !== undefined) {
        outcome.count = effects.count;
        outcome.countRule = rule.id;
      }
      if (effects.internal !== undefined) outcome.internal = effects.internal;
      for (const source of effects.ignore_comments ?? [])
        outcome.ignore.push(new RegExp(source, "i"));
      outcome.applied.push(rule.id);
    }
    return outcome;
  }

  #matches(rule: Compiled, ctx: PrContext): boolean {
    const { scope, when } = rule;
    const lower = (values: readonly string[]) => values.map((v) => v.toLowerCase());
    if (!rule.repo(ctx.repo)) return false;
    if (rule.people && !rule.people.has(ctx.person.toLowerCase())) return false;
    if (scope.teams?.length && (ctx.team === null || !scope.teams.includes(ctx.team))) return false;
    if (scope.groups?.length && !scope.groups.some((g) => ctx.groups.includes(g))) return false;
    if (when.labels?.length && !lower(when.labels).some((l) => lower(ctx.labels).includes(l))) {
      return false;
    }
    if (rule.title && !rule.title.test(ctx.title)) return false;
    if (when.base?.length && !rule.base(ctx.base)) return false;
    if (when.head?.length && !rule.head(ctx.head)) return false;
    if (
      when.author_association?.length &&
      !when.author_association.includes(ctx.authorAssociation ?? "")
    ) {
      return false;
    }
    if (when.from_fork !== undefined && when.from_fork !== ctx.fromFork) return false;
    if (when.draft !== undefined && when.draft !== ctx.draft) return false;
    if (when.author_bot !== undefined && when.author_bot !== ctx.authorBot) return false;
    return true;
  }
}
