// What the report looks at: any mix of teams, products, repos and people (decision D26). Within
// one of them a PR needs to match any value; across them, all. An empty selection is everything.
import type { PrFact } from "./facts.ts";
import { type Groups, NO_PRODUCT, NO_TEAM } from "./groups.ts";

export type Dimension = "team" | "product" | "repo" | "person";

export const DIMENSIONS: readonly Dimension[] = ["team", "product", "repo", "person"];

export type Selection = Record<Dimension, string[]>;

export const EVERYTHING: Selection = { team: [], product: [], repo: [], person: [] };

/** What can be selected: the configured groups and what the data holds, A–Z. */
export type Choices = {
  teams: { name: string; people: string[] }[];
  products: { name: string; repos: string[]; teams: string[] }[];
  repos: string[];
  /** Authors of counted PRs. */
  people: string[];
};

export function choices(
  groups: Groups,
  repos: readonly string[],
  facts: readonly PrFact[],
): Choices {
  const counted = facts.filter((pr) => pr.counted);
  const teams = groups.teams.map((team) => ({
    name: team.name,
    people: unique(team.members.map((member) => member.login)),
  }));
  if (teams.length > 0 && counted.some((pr) => pr.team === null))
    teams.push({ name: NO_TEAM, people: [] });
  const products = groups.products.map(({ name, repos, teams }) => ({ name, repos, teams }));
  if (products.length > 0 && counted.some((pr) => pr.products.length === 0)) {
    products.push({ name: NO_PRODUCT, repos: [], teams: [] });
  }
  return {
    teams: sortGroups(teams),
    products: sortGroups(products),
    repos: [...repos].sort(byName),
    people: unique(counted.map((pr) => pr.author)).sort(byName),
  };
}

/** A PR's values along a dimension: its team, products, repo or author. */
export function valuesOf(pr: PrFact, dimension: Dimension): string[] {
  switch (dimension) {
    case "team":
      return [pr.team ?? NO_TEAM];
    case "product":
      return pr.products.length > 0 ? pr.products : [NO_PRODUCT];
    case "repo":
      return [pr.repo];
    case "person":
      return [pr.author];
  }
}

/** A test for the PRs a selection holds. */
export function selects(selection: Selection): (pr: PrFact) => boolean {
  const wanted = DIMENSIONS.filter((d) => selection[d].length > 0).map(
    (d) => [d, new Set(selection[d].map(lower))] as const,
  );
  return (pr) =>
    wanted.every(([dimension, values]) =>
      valuesOf(pr, dimension).some((value) => values.has(lower(value))),
    );
}

/** The selection without values that no longer exist: links can outlive config. */
export function validSelection(choices: Choices, selection: Selection): Selection {
  const known: Record<Dimension, string[]> = {
    team: choices.teams.map((t) => t.name),
    product: choices.products.map((p) => p.name),
    repo: choices.repos,
    person: choices.people,
  };
  const keep = (dimension: Dimension) =>
    selection[dimension].flatMap((value) => {
      const match = known[dimension].find((k) => lower(k) === lower(value));
      return match ? [match] : [];
    });
  return {
    team: keep("team"),
    product: keep("product"),
    repo: keep("repo"),
    person: keep("person"),
  };
}

export const isEverything = (selection: Selection) =>
  DIMENSIONS.every((d) => selection[d].length === 0);

/** The dimensions a selection can be broken down by: any not already narrowed to one value. */
export function breakdowns(choices: Choices, selection: Selection): Dimension[] {
  const offered: Dimension[] = [];
  if (choices.teams.length > 0 && selection.team.length !== 1) offered.push("team");
  if (choices.products.length > 0 && selection.product.length !== 1) offered.push("product");
  if (choices.repos.length > 1 && selection.repo.length !== 1) offered.push("repo");
  return offered;
}

/**
 * The breakdown shown unless the reader picks another: teams at the top, a team's repos, a
 * product's teams, the teams working in a repo.
 */
export function defaultBreakdown(choices: Choices, selection: Selection): Dimension | null {
  const offered = breakdowns(choices, selection);
  const order: Dimension[] =
    selection.team.length === 1 ? ["repo", "product"] : ["team", "product", "repo"];
  return order.find((d) => offered.includes(d)) ?? null;
}

/** The selection narrowed to one value along a dimension: a row of a breakdown, or a drill-down. */
export function narrow(selection: Selection, dimension: Dimension, value: string): Selection {
  return { ...selection, [dimension]: [value] };
}

/** How a selection reads: "All teams", "Payments", "Payments · acme/api", "ana, devon +1". */
export function selectionName(choices: Choices, selection: Selection): string {
  if (isEverything(selection)) {
    if (choices.teams.length > 0) return "All teams";
    if (choices.products.length > 0) return "All products";
    return choices.repos.length === 1 ? (choices.repos[0] ?? "") : "All repos";
  }
  return DIMENSIONS.filter((d) => selection[d].length > 0)
    .map((d) => listed(selection[d]))
    .join(" · ");
}

/** "ana", "ana, devon", "ana, devon +3". */
export function listed(values: readonly string[], max = 2): string {
  return values.length <= max + 1
    ? values.join(", ")
    : `${values.slice(0, max).join(", ")} +${values.length - max}`;
}

const INTERNAL_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export type Contributors = "all" | "internal" | "external";

export const CONTRIBUTORS: readonly Contributors[] = ["all", "internal", "external"];

/**
 * Whether a PR comes from inside the project: its author is in a team, is a bot, has write access
 * to the repo (GitHub's owner, member or collaborator), or opened it from a branch of the repo
 * itself, which takes write access. GitHub reports the author's relationship as it is now, and
 * hides private organization memberships from tokens outside the organization: listing such
 * people in a team counts them as internal.
 */
export function isInternal(pr: PrFact): boolean {
  return (
    pr.authorIsBot ||
    !pr.fromFork ||
    INTERNAL_ASSOCIATIONS.has(pr.authorAssociation ?? "") ||
    pr.team !== null ||
    pr.alsoTeams.length > 0
  );
}

export function byContributors(contributors: Contributors): (pr: PrFact) => boolean {
  if (contributors === "all") return () => true;
  const internal = contributors === "internal";
  return (pr) => isInternal(pr) === internal;
}

const lower = (text: string) => text.toLowerCase();
const byName = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });

function unique(values: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const value of values) if (!seen.has(lower(value))) seen.set(lower(value), value);
  return [...seen.values()];
}

/** A–Z, with the catch-all group ("No team", "No product") last. */
function sortGroups<T extends { name: string }>(groups: T[]): T[] {
  const rest = (name: string) => name === NO_TEAM || name === NO_PRODUCT;
  return groups.sort(
    (a, b) => Number(rest(a.name)) - Number(rest(b.name)) || byName(a.name, b.name),
  );
}

/** Values of a dimension in the order a breakdown lists them: A–Z, catch-alls last. */
export function sortValues(values: Iterable<string>): string[] {
  return sortGroups([...new Set(values)].map((name) => ({ name }))).map((g) => g.name);
}
