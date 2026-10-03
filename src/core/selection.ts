// What the report looks at: any mix of teams, groups, repos and people (decision D26). A PR must
// match every dimension that is set. Within one, it may match any value, except that groups of
// different kinds combine: product Checkout and area Mobile means PRs in both. An empty
// selection is everything.
import type { PrFact } from "./facts.ts";
import { type Groups, NO_TEAM, noGroup, personOf } from "./groups.ts";

export type Dimension = "team" | "group" | "repo" | "person";

export const DIMENSIONS: readonly Dimension[] = ["team", "group", "repo", "person"];

export type Selection = Record<Dimension, string[]>;

export const EVERYTHING: Selection = { team: [], group: [], repo: [], person: [] };

/** What a breakdown lists: teams, the groups of one kind, or repos. Never people. */
export type Breakdown = "team" | "repo" | `group:${string}`;

/** What can be selected: the configured teams, groups and people, and what the data holds. */
export type Choices = {
  teams: { name: string; people: string[] }[];
  /** Every group, catch-alls ("No product") included, A–Z within each kind. */
  groups: { name: string; kind: string; repos: string[]; teams: string[]; catchAll: boolean }[];
  /** Kinds of group, in config's order. */
  kinds: string[];
  repos: string[];
  /** People who opened counted PRs, by key, with the name config gives them. */
  people: { key: string; name: string | null }[];
};

export function choices(
  groups: Groups,
  repos: readonly string[],
  facts: readonly PrFact[],
): Choices {
  const counted = facts.filter((pr) => pr.counted);
  const teams = groups.teams.map((team) => ({
    name: team.name,
    people: unique(team.members.map((member) => personOf(groups, member.login))),
  }));
  if (teams.length > 0 && counted.some((pr) => pr.team === null)) {
    teams.push({ name: NO_TEAM, people: [] });
  }
  const kinds = [...new Set(groups.groups.map((group) => group.kind))];
  const listed = kinds.flatMap((kind) => {
    const own = groups.groups
      .filter((group) => group.kind === kind)
      .map(({ name, repos, teams }) => ({ name, kind, repos, teams, catchAll: false }));
    const rest = noGroup(kind);
    const catchAll = counted.some((pr) => pr.groups.includes(rest))
      ? [{ name: rest, kind, repos: [], teams: [], catchAll: true }]
      : [];
    return [...sortGroups(own), ...catchAll];
  });
  const names = new Map(groups.people.map((p) => [p.key.toLowerCase(), p.name]));
  return {
    teams: sortGroups(teams),
    groups: listed,
    kinds,
    repos: [...repos].sort(byName),
    people: unique(counted.map((pr) => pr.person))
      .sort(byName)
      .map((key) => ({ key, name: names.get(key.toLowerCase()) ?? null })),
  };
}

/** A PR's values along a dimension: its team, groups, repo or author. */
export function valuesOf(pr: PrFact, dimension: Dimension): string[] {
  switch (dimension) {
    case "team":
      return [pr.team ?? NO_TEAM];
    case "group":
      return pr.groups;
    case "repo":
      return [pr.repo];
    case "person":
      return [pr.person];
  }
}

/** The kind of a group, by name; null for a name config doesn't define. */
export function kindOf(choices: Choices, group: string): string | null {
  return choices.groups.find((g) => lower(g.name) === lower(group))?.kind ?? null;
}

/** A test for the PRs a selection holds. */
export function selects(selection: Selection, choices: Choices): (pr: PrFact) => boolean {
  const tests: ((pr: PrFact) => boolean)[] = [];
  for (const dimension of ["team", "repo", "person"] as const) {
    if (selection[dimension].length === 0) continue;
    const values = new Set(selection[dimension].map(lower));
    tests.push((pr) => valuesOf(pr, dimension).some((value) => values.has(lower(value))));
  }
  // Groups combine by kind: any of a kind's values, and every kind that has one.
  const byKind = new Map<string, Set<string>>();
  for (const group of selection.group) {
    const kind = kindOf(choices, group) ?? "";
    byKind.set(kind, (byKind.get(kind) ?? new Set()).add(lower(group)));
  }
  for (const values of byKind.values()) {
    tests.push((pr) => pr.groups.some((group) => values.has(lower(group))));
  }
  return (pr) => tests.every((test) => test(pr));
}

/** The selection without values that no longer exist: links can outlive config. */
export function validSelection(choices: Choices, selection: Selection): Selection {
  const known: Record<Dimension, string[]> = {
    team: choices.teams.map((t) => t.name),
    group: choices.groups.map((g) => g.name),
    repo: choices.repos,
    person: choices.people.map((p) => p.key),
  };
  const keep = (dimension: Dimension) =>
    selection[dimension].flatMap((value) => {
      const match = known[dimension].find((k) => lower(k) === lower(value));
      return match ? [match] : [];
    });
  return { team: keep("team"), group: keep("group"), repo: keep("repo"), person: keep("person") };
}

export const isEverything = (selection: Selection) =>
  DIMENSIONS.every((d) => selection[d].length === 0);

const groupsOfKind = (choices: Choices, selection: Selection, kind: string) =>
  selection.group.filter((group) => kindOf(choices, group) === kind);

/** The breakdowns a selection offers: any dimension, or kind of group, not narrowed to one value. */
export function breakdowns(choices: Choices, selection: Selection): Breakdown[] {
  const offered: Breakdown[] = [];
  if (choices.teams.length > 0 && selection.team.length !== 1) offered.push("team");
  for (const kind of choices.kinds) {
    if (groupsOfKind(choices, selection, kind).length !== 1) offered.push(`group:${kind}`);
  }
  if (choices.repos.length > 1 && selection.repo.length !== 1) offered.push("repo");
  return offered;
}

/**
 * The breakdown shown unless the reader picks another: teams at the top, a team's repos, the
 * teams working in a repo or a group.
 */
export function defaultBreakdown(choices: Choices, selection: Selection): Breakdown | null {
  const offered = breakdowns(choices, selection);
  if (selection.team.length === 1) return offered.find((b) => b === "repo") ?? offered[0] ?? null;
  return offered[0] ?? null;
}

/** The values a breakdown lists for these PRs: A–Z, catch-alls last. */
export function breakdownValues(choices: Choices, by: Breakdown, prs: readonly PrFact[]): string[] {
  if (by === "team" || by === "repo") return sortValues(prs.flatMap((pr) => valuesOf(pr, by)));
  const kind = by.slice("group:".length);
  return sortValues(prs.flatMap((pr) => pr.groups.filter((g) => kindOf(choices, g) === kind)));
}

/** The selection narrowed to one value of a breakdown: a row of it, or a drill-down. */
export function narrow(
  choices: Choices,
  selection: Selection,
  by: Breakdown,
  value: string,
): Selection {
  if (by === "team" || by === "repo") return { ...selection, [by]: [value] };
  const kind = by.slice("group:".length);
  return {
    ...selection,
    group: [...selection.group.filter((g) => kindOf(choices, g) !== kind), value],
  };
}

/** How a selection reads: "All teams", "Payments", "Payments · acme/api", "ana, devon +1". */
export function selectionName(choices: Choices, selection: Selection): string {
  if (isEverything(selection)) {
    if (choices.teams.length > 0) return "All teams";
    if (choices.kinds.length > 0) return `All ${choices.kinds[0]}s`;
    return choices.repos.length === 1 ? (choices.repos[0] ?? "") : "All repos";
  }
  const shown = (dimension: Dimension) =>
    dimension === "person"
      ? selection.person.map((key) => personName(choices, key))
      : selection[dimension];
  return DIMENSIONS.filter((d) => selection[d].length > 0)
    .map((d) => listed(shown(d)))
    .join(" · ");
}

/** A person's name as config gives it, or their key. */
export function personName(choices: Choices, key: string): string {
  return choices.people.find((p) => lower(p.key) === lower(key))?.name ?? key;
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
 * Whether a PR comes from inside the project. Config decides first: a person marked internal or
 * external, or anyone in a team, is that. Otherwise, a bot, anyone GitHub calls owner, member
 * or collaborator, and anyone who opened the PR from a branch of the repo itself (which takes
 * write access) is internal. GitHub reports the relationship as it is now, and hides private
 * organization memberships from tokens outside the organization.
 */
export function isInternal(pr: PrFact): boolean {
  if (pr.internal !== null) return pr.internal;
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

/** "No team", or a kind's catch-all: kinds are lowercase words, so "No Limits" is a team. */
export const isCatchAll = (name: string) => name === NO_TEAM || /^No [a-z][a-z0-9_-]*$/.test(name);

/** A–Z, with the catch-all group ("No team", "No product") last. */
function sortGroups<T extends { name: string }>(groups: T[]): T[] {
  return groups.sort(
    (a, b) => Number(isCatchAll(a.name)) - Number(isCatchAll(b.name)) || byName(a.name, b.name),
  );
}

/** Values in the order a breakdown lists them: A–Z, catch-alls last. */
export function sortValues(values: Iterable<string>): string[] {
  return sortGroups([...new Set(values)].map((name) => ({ name }))).map((g) => g.name);
}
