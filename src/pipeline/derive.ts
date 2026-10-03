import { createHash } from "node:crypto";
import picomatch from "picomatch";
import type { Config } from "../config/schema.ts";
import { type DeriveRules, derivePr } from "../core/derive.ts";
import { DERIVE_VERSION, type PrFact } from "../core/facts.ts";
import { attribute, type Groups, NO_GROUPS } from "../core/groups.ts";
import type { PrModel } from "../core/model.ts";
import { pathClassifier } from "../core/paths.ts";
import { linkReverts, type RevertClues, revertClues } from "../core/reverts.ts";
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
  let derived = 0;
  let prs = 0;
  for (const repo of repos) {
    const measured = measuredBranches(config, repo);
    const inputs = fingerprint({
      version: DERIVE_VERSION,
      raw: store.rawFingerprint(repo.id),
      measured,
      promotions: config.promotions,
      bots: config.bots,
      paths: config.paths,
      groups,
    });
    if (store.derivedInputs(repo.id) === inputs) continue;

    const rules = rulesFor(config, measured, groups);
    const facts = new Map<string, PrFact>();
    const clues: RevertClues[] = [];
    // One PR in memory at a time: only its facts and revert clues are kept.
    for (const version of store.latestPrs(repo.id)) {
      const model = normalize(repo, version.payload);
      facts.set(model.id, derivePr(model, rules));
      clues.push(revertClues(model));
    }
    linkReverts(clues, facts);
    store.replaceFacts(repo.id, [...facts.values()], inputs);
    derived += 1;
    prs += facts.size;
  }
  return { repos: repos.length, derived, prs, seconds: (performance.now() - started) / 1000 };
}

/**
 * The branches whose PRs count for a repo: as configured, or else every branch that has been
 * the repo's default, so renaming `master` to `main` doesn't drop the PRs merged before it.
 */
export function measuredBranches(config: Config, repo: StoredRepo): string[] {
  const options = { nocase: true, dot: true };
  for (const [pattern, branches] of Object.entries(config.branches)) {
    if (picomatch(pattern, options)(repo.fullName)) return branches;
  }
  const history = [...repo.defaultBranches, repo.defaultBranch];
  return [...new Set(history.filter((branch): branch is string => branch !== null))];
}

/** Config's teams and products, with product repo patterns matched against the synced repos. */
export function groupsOf(config: Config, repos: readonly string[]): Groups {
  return {
    teams: Object.entries(config.teams).map(([name, team]) => ({ name, members: team.people })),
    products: Object.entries(config.products).map(([name, product]) => {
      const owns =
        product.repos.length > 0 ? picomatch(product.repos, { nocase: true }) : () => false;
      return { name, repos: repos.filter((repo) => owns(repo)), teams: product.teams };
    }),
  };
}

export function rulesFor(
  config: Config,
  measured: readonly string[],
  groups: Groups = NO_GROUPS,
): DeriveRules {
  // Git branch names are case-sensitive; logins are not.
  const isMeasured = measured.length > 0 ? picomatch([...measured], { dot: true }) : () => false;
  const isPromotion = picomatch(config.promotions, { dot: true });
  const bots = new Set(config.bots.accounts.map((login) => login.toLowerCase()));
  const reviewers = new Set(config.bots.reviewers.map((login) => login.toLowerCase()));
  const ignored = config.bots.ignore_bodies.map((source) => new RegExp(source, "i"));
  return {
    isMeasuredBranch: (_repo, branch) => isMeasured(branch),
    isPromotionBranch: (branch) => isPromotion(branch),
    classify: pathClassifier(config.paths),
    isBot: (actor) => actor.bot || bots.has(actor.login.toLowerCase()),
    isBotReviewer: (actor) => reviewers.has(actor.login.toLowerCase()),
    isIgnoredBody: (body) => body !== "" && ignored.some((pattern) => pattern.test(body)),
    includeBotPrs: config.bots.include_prs,
    attribute: (pr) => attribute(groups, pr),
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
