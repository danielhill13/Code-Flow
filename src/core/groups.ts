// People, teams and groups (decisions D25, D30). A person has one or more logins. A team is
// people, with dates: a PR belongs to its author's team on the day they opened it, so teams
// never overlap and a move keeps its history. A group has a kind (product, area, program…) and
// holds repos, teams and people; groups may overlap. Where the definitions come from (config
// today, GitHub teams or an HR export later) doesn't matter past this file.

/** A person, by the key config uses for them, with every login they use. */
export type Person = {
  key: string;
  name: string | null;
  /** GitHub logins, the first being current. Default: the key itself. */
  github: string[];
  /** Counted as internal (or external) whatever GitHub says; null to go by GitHub. */
  internal: boolean | null;
  /** Treated as a bot: their PRs aren't counted and their reviews aren't review. */
  bot: boolean | null;
};

/** A person's place in a team: a person's key or a login. Dates inclusive; null is open. */
export type Member = {
  login: string;
  from: string | null;
  to: string | null;
  /** Listed with the team, but their PRs count for their primary team. */
  secondary: boolean;
};

export type TeamDef = { name: string; members: Member[] };

/** A group, its repo patterns already matched to repo names. */
export type GroupDef = {
  name: string;
  /** What sort of group: "product", "area", "program"… Breakdowns go kind by kind. */
  kind: string;
  repos: string[];
  teams: string[];
  people: string[];
};

export type Groups = { people: Person[]; teams: TeamDef[]; groups: GroupDef[] };

export const NO_GROUPS: Groups = { people: [], teams: [], groups: [] };

/** Where PRs by people in no team go. Config may not use this name. */
export const NO_TEAM = "No team";

/** Where PRs in no group of a kind go: "No product". Config may not use these names. */
export const noGroup = (kind: string) => `No ${kind}`;

export type Attribution = {
  /** Who opened the PR: their person key, or their login when config doesn't list them. */
  person: string;
  /** Their primary team on the day they opened it; null when they had none. */
  team: string | null;
  /** Teams they were a secondary member of that day. Their PRs don't count there. */
  alsoTeams: string[];
  /**
   * Groups the PR belongs to, through its repo, its team or its author; for each kind it has no
   * group of, that kind's catch-all ("No product").
   */
  groups: string[];
};

type Index = {
  byLogin: Map<string, Person>;
  kinds: string[];
};
const indexes = new WeakMap<Groups, Index>();

function indexOf(groups: Groups): Index {
  let index = indexes.get(groups);
  if (!index) {
    const byLogin = new Map<string, Person>();
    for (const person of groups.people) {
      byLogin.set(person.key.toLowerCase(), person);
      for (const login of person.github) byLogin.set(login.toLowerCase(), person);
    }
    index = { byLogin, kinds: [...new Set(groups.groups.map((g) => g.kind))] };
    indexes.set(groups, index);
  }
  return index;
}

/** The person a login (or a person's key) belongs to: their key, or the login itself. */
export function personOf(groups: Groups, login: string): string {
  return indexOf(groups).byLogin.get(login.toLowerCase())?.key ?? login;
}

/** The person's record, if config lists them. */
export function personRecord(groups: Groups, login: string): Person | undefined {
  return indexOf(groups).byLogin.get(login.toLowerCase());
}

/** The kinds of group config defines, in the order it first uses them. */
export const groupKinds = (groups: Groups) => indexOf(groups).kinds;

/** The one place that says who opened a PR and which team and groups it belongs to. */
export function attribute(
  groups: Groups,
  pr: { repo: string; author: string; createdAt: string },
): Attribution {
  const day = pr.createdAt.slice(0, 10);
  const person = personOf(groups, pr.author);
  const key = person.toLowerCase();
  let team: string | null = null;
  const alsoTeams: string[] = [];
  for (const def of groups.teams) {
    for (const member of def.members) {
      if (personOf(groups, member.login).toLowerCase() !== key || !onDay(member, day)) continue;
      if (member.secondary) {
        if (!alsoTeams.includes(def.name)) alsoTeams.push(def.name);
      } else if (team === null) {
        team = def.name;
      }
    }
  }
  const repo = pr.repo.toLowerCase();
  const matched = groups.groups.filter(
    (group) =>
      group.repos.some((name) => name.toLowerCase() === repo) ||
      (team !== null && group.teams.includes(team)) ||
      group.people.some((p) => personOf(groups, p).toLowerCase() === key),
  );
  const names = matched.map((group) => group.name);
  for (const kind of groupKinds(groups)) {
    if (!matched.some((group) => group.kind === kind)) names.push(noGroup(kind));
  }
  return {
    person,
    team,
    alsoTeams: alsoTeams.filter((name) => name !== team),
    groups: names,
  };
}

function onDay(member: Member, day: string): boolean {
  return (member.from === null || member.from <= day) && (member.to === null || day <= member.to);
}

/**
 * Problems with people and teams, each a sentence saying how to fix it: a login claimed by two
 * people, or a person in two teams as a primary member on the same day, which would count their
 * PRs twice.
 */
export function groupProblems(groups: Pick<Groups, "people" | "teams">): string[] {
  const problems: string[] = [];
  const owner = new Map<string, string>();
  for (const person of groups.people) {
    for (const login of [person.key, ...person.github]) {
      const seen = owner.get(login.toLowerCase());
      if (seen !== undefined && seen !== person.key) {
        problems.push(`${login} is listed under both ${seen} and ${person.key}: keep it on one.`);
      }
      owner.set(login.toLowerCase(), person.key);
    }
  }
  const resolve = (login: string) => owner.get(login.toLowerCase()) ?? login.toLowerCase();
  const spans = new Map<string, { team: string; member: Member }[]>();
  for (const team of groups.teams) {
    for (const member of team.members) {
      if (member.secondary) continue;
      const key = resolve(member.login);
      spans.set(key, [...(spans.get(key) ?? []), { team: team.name, member }]);
    }
  }
  for (const list of spans.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (!a || !b || a.team === b.team) continue;
        const from = later(a.member.from, b.member.from);
        const to = earlier(a.member.to, b.member.to);
        if (from !== null && to !== null && from > to) continue;
        const when =
          from === null && to === null
            ? "at the same time"
            : `from ${from ?? "the start"} to ${to ?? "now"}`;
        problems.push(
          `${a.member.login} is in ${a.team} and ${b.team} ${when}. A PR can count for one team ` +
            "only: give the memberships dates that don't overlap, or mark one `secondary: true`.",
        );
      }
    }
  }
  return problems;
}

const later = (a: string | null, b: string | null) =>
  a === null ? b : b === null ? a : a > b ? a : b;
const earlier = (a: string | null, b: string | null) =>
  a === null ? b : b === null ? a : a < b ? a : b;
