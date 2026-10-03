// Teams and products (decision D25). A team is people, with dates: a PR belongs to its author's
// team on the day they opened it, so teams never overlap and a move keeps its history. A product
// is repos and teams, and products may overlap. Where the definitions come from (config today,
// GitHub teams or an HR export later) doesn't matter past this file.

/** A person's place in a team. Dates are YYYY-MM-DD, inclusive; null is open-ended. */
export type Member = {
  login: string;
  from: string | null;
  to: string | null;
  /** Listed with the team, but their PRs count for their primary team. */
  secondary: boolean;
};

export type TeamDef = { name: string; members: Member[] };

/** A product, its repo patterns already matched to repo names. */
export type ProductDef = { name: string; repos: string[]; teams: string[] };

export type Groups = { teams: TeamDef[]; products: ProductDef[] };

export const NO_GROUPS: Groups = { teams: [], products: [] };

/** Where PRs by people in no team go. Config may not use these names. */
export const NO_TEAM = "No team";
export const NO_PRODUCT = "No product";

export type Attribution = {
  /** The author's primary team on the day they opened the PR; null when they had none. */
  team: string | null;
  /** Teams the author was a secondary member of that day. Their PRs don't count there. */
  alsoTeams: string[];
  /** Products the PR belongs to: through its repo, or through its team. */
  products: string[];
};

/** The one place that says which team and products a PR belongs to. */
export function attribute(
  groups: Groups,
  pr: { repo: string; author: string; createdAt: string },
): Attribution {
  const day = pr.createdAt.slice(0, 10);
  const login = pr.author.toLowerCase();
  let team: string | null = null;
  const alsoTeams: string[] = [];
  for (const def of groups.teams) {
    for (const member of def.members) {
      if (member.login.toLowerCase() !== login || !onDay(member, day)) continue;
      if (member.secondary) {
        if (!alsoTeams.includes(def.name)) alsoTeams.push(def.name);
      } else if (team === null) {
        team = def.name;
      }
    }
  }
  const repo = pr.repo.toLowerCase();
  const products = groups.products
    .filter(
      (product) =>
        product.repos.some((name) => name.toLowerCase() === repo) ||
        (team !== null && product.teams.includes(team)),
    )
    .map((product) => product.name);
  return { team, alsoTeams: alsoTeams.filter((name) => name !== team), products };
}

function onDay(member: Member, day: string): boolean {
  return (member.from === null || member.from <= day) && (member.to === null || day <= member.to);
}

/**
 * Days a person is in two teams as a primary member at once, which would count their PRs twice.
 * Each problem comes back as a sentence saying how to fix it.
 */
export function teamOverlaps(teams: readonly TeamDef[]): string[] {
  const spans = new Map<string, { team: string; member: Member }[]>();
  for (const team of teams) {
    for (const member of team.members) {
      if (member.secondary) continue;
      const key = member.login.toLowerCase();
      spans.set(key, [...(spans.get(key) ?? []), { team: team.name, member }]);
    }
  }
  const problems: string[] = [];
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
