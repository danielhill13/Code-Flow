import { createHash } from "node:crypto";
import picomatch from "picomatch";
import { asRule, type Config } from "../config/schema.ts";
import { DEFAULT_PROMOTION_BRANCHES, type DeriveRules, derivePr } from "../core/derive.ts";
import { DERIVE_VERSION, type PrFact } from "../core/facts.ts";
import { attribute, type Groups, NO_GROUPS, personOf } from "../core/groups.ts";
import type { PrModel } from "../core/model.ts";
import { pathClassifier } from "../core/paths.ts";
import { linkReverts, type RevertClues, revertClues } from "../core/reverts.ts";
import { type Rule, RuleEngine } from "../core/rules.ts";
import { type GhPayload, normalizePr } from "../providers/github/normalize.ts";
import type { Store, StoredRepo } from "../store/store.ts";

export type DeriveReport = {
  repos: number;
  /** Repos whose facts were derived again because their inputs changed. */
  derived: number;
  prs: number;
  seconds: number;
};

/**
 * Brings every repo's facts up to date. A repo is derived again only when something its facts
 * depend on has changed: new raw PR versions, the relevant config, its default branch, or
 * derive's code (DERIVE_VERSION). Each repo is derived whole, because revert links cross PRs.
 */
export function deriveFacts(store: Store, config: Config): DeriveReport {
  const started = performance.now();
  const repos = store.repos();
  const groups = groupsOf(
    config,
    repos.map((repo) => repo.fullName),
  );
  const rules = rulesOf(config);
  const engine = new RuleEngine(rules, groups);
  let derived = 0;
  let prs = 0;
  for (const repo of repos) {
    const measured = measuredBranches(config, repo, engine);
    const inputs = fingerprint({
      version: DERIVE_VERSION,
      raw: store.rawFingerprint(repo.id),
      measured,
      rules,
      groups,
    });
    if (store.derivedInputs(repo.id) === inputs) continue;

    const facts = deriveRepo(
      store,
      repo,
      rulesFor(config, repo.fullName, measured, groups, engine),
    );
    store.replaceFacts(repo.id, facts, inputs);
    derived += 1;
    prs += facts.length;
  }
  return { repos: repos.length, derived, prs, seconds: (performance.now() - started) / 1000 };
}

/** One repo's facts from its stored PRs, under the given rules. Writes nothing. */
export function deriveRepo(store: Store, repo: StoredRepo, rules: DeriveRules): PrFact[] {
  const facts = new Map<string, PrFact>();
  const clues: RevertClues[] = [];
  // One PR in memory at a time: only its facts and revert clues are kept.
  for (const version of store.latestPrs(repo.id)) {
    const model = normalize(repo, version.payload);
    facts.set(model.id, derivePr(model, rules));
    clues.push(revertClues(model));
  }
  linkReverts(clues, facts);
  return [...facts.values()];
}

/**
 * Every repo's facts as a config would derive them, without storing them: to preview what a
 * change of rules would do.
 */
export function deriveWith(store: Store, config: Config): PrFact[] {
  const repos = store.repos();
  const groups = groupsOf(
    config,
    repos.map((repo) => repo.fullName),
  );
  const engine = new RuleEngine(rulesOf(config), groups);
  return repos.flatMap((repo) =>
    deriveRepo(
      store,
      repo,
      rulesFor(config, repo.fullName, measuredBranches(config, repo, engine), groups, engine),
    ),
  );
}

/** Config's people, teams and groups, with repo patterns matched against the synced repos. */
export function groupsOf(config: Config, repos: readonly string[]): Groups {
  const matching = (patterns: string[]) => {
    const owns = patterns.length > 0 ? picomatch(patterns, { nocase: true }) : () => false;
    return repos.filter((repo) => owns(repo));
  };
  return {
    people: Object.entries(config.people).map(([key, person]) => ({
      key,
      name: person.name ?? null,
      github: person.github ?? [key],
      internal: person.internal ?? null,
      bot: person.bot ?? null,
    })),
    teams: Object.entries(config.teams).map(([name, team]) => ({ name, members: team.people })),
    groups: [
      ...Object.entries(config.groups).map(([name, group]) => ({
        name,
        kind: group.kind,
        repos: matching(group.repos),
        teams: group.teams,
        people: group.people,
      })),
      ...Object.entries(config.products).map(([name, product]) => ({
        name,
        kind: "product",
        repos: matching(product.repos),
        teams: product.teams,
        people: product.people,
      })),
    ],
  };
}

/**
 * Every rule an org has: first the rules today's config keys stand for (`branches`,
 * `promotions`, `bots`, `paths`, and what `people` says), then its rules.yml, so a rule of its
 * own at the same level wins. Shorthand ids hold a `:`, which an org's own ids can't.
 */
export function rulesOf(config: Config): Rule[] {
  const rules: Rule[] = [];
  const add = (id: string, source: string, rule: Pick<Rule, "effects"> & Partial<Rule>) =>
    rules.push({ id, description: null, enabled: true, scope: {}, when: {}, source, ...rule });
  add("config:promotions", "promotions", { effects: { promotion_branches: config.promotions } });
  // In `branches`, the first matching pattern decides; among rules the last one does.
  for (const [pattern, branches] of Object.entries(config.branches).reverse()) {
    add(`config:branches:${pattern}`, "branches", {
      scope: { repos: [pattern] },
      effects: { measured_branches: branches },
    });
  }
  const { bots } = config;
  if (bots.accounts.length > 0) {
    add("config:bots.accounts", "bots", {
      scope: { people: bots.accounts },
      effects: { bot: true },
    });
  }
  if (bots.reviewers.length > 0) {
    add("config:bots.reviewers", "bots", {
      scope: { people: bots.reviewers },
      effects: { bot_reviews_count: true },
    });
  }
  if (bots.include_prs) {
    add("config:bots.include_prs", "bots", {
      when: { author_bot: true },
      effects: { count: true },
    });
  }
  if (bots.ignore_bodies.length > 0) {
    add("config:bots.ignore_bodies", "bots", { effects: { ignore_comments: bots.ignore_bodies } });
  }
  config.paths.forEach((path, i) => {
    add(`config:paths:${i + 1}`, "paths", {
      scope: path.repos ? { repos: path.repos } : {},
      effects: { paths: [{ match: path.match, bucket: path.bucket }] },
    });
  });
  for (const [key, person] of Object.entries(config.people)) {
    if (person.bot !== undefined) {
      add(`config:people:${key}:bot`, "people", {
        scope: { people: [key] },
        effects: { bot: person.bot },
      });
    }
    if (person.internal !== undefined) {
      add(`config:people:${key}:internal`, "people", {
        scope: { people: [key] },
        effects: { internal: person.internal },
      });
    }
  }
  for (const rule of config.rules) rules.push(asRule(rule, "rules.yml"));
  return rules;
}

/**
 * The branches whose PRs count for a repo: as a rule says, or else every branch that has been
 * the repo's default, so renaming `master` to `main` doesn't drop the PRs merged before it.
 */
export function measuredBranches(config: Config, repo: StoredRepo, engine?: RuleEngine): string[] {
  const rules = engine ?? new RuleEngine(rulesOf(config), NO_GROUPS);
  const configured = rules.repo(repo.fullName).measuredBranches;
  if (configured) return configured;
  const history = [...repo.defaultBranches, repo.defaultBranch];
  return [...new Set(history.filter((branch): branch is string => branch !== null))];
}

/** Derive's questions about one repo's PRs, answered from the org's rules. */
export function rulesFor(
  config: Config,
  repo: string,
  measured: readonly string[],
  groups: Groups = NO_GROUPS,
  engine = new RuleEngine(rulesOf(config), groups),
): DeriveRules {
  const own = engine.repo(repo);
  // Git branch names are case-sensitive; logins are not.
  const isMeasured = measured.length > 0 ? picomatch([...measured], { dot: true }) : () => false;
  const isPromotion = picomatch(own.promotionBranches ?? [...DEFAULT_PROMOTION_BRANCHES], {
    dot: true,
  });
  const people = new Map<string, ReturnType<RuleEngine["person"]>>();
  const person = (login: string) => {
    let outcome = people.get(login);
    if (!outcome) {
      outcome = engine.person(login);
      people.set(login, outcome);
    }
    return outcome;
  };
  const classify = pathClassifier(own.paths);
  return {
    isMeasuredBranch: (_repo, branch) => isMeasured(branch),
    isPromotionBranch: (branch) => isPromotion(branch),
    classify,
    isBot: (actor) => person(actor.login).bot ?? actor.bot,
    isBotReviewer: (actor) => person(actor.login).botReviewsCount ?? false,
    prRules: (pr) => engine.pr(pr),
    attribute: (pr) => attribute(groups, pr),
    personOf: (login) => personOf(groups, login),
  };
}

function normalize(repo: StoredRepo, payload: unknown): PrModel {
  switch (repo.provider) {
    case "github":
      return normalizePr(payload as GhPayload, { id: repo.id, fullName: repo.fullName });
    default:
      throw new Error(`No way to read ${repo.provider} pull requests (repo ${repo.fullName}).`);
  }
}

function fingerprint(inputs: unknown): string {
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex").slice(0, 32);
}
