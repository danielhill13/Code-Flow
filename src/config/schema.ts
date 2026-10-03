import { z } from "zod";
import { DEFAULT_PROMOTION_BRANCHES } from "../core/derive.ts";
import { type Member, NO_PRODUCT, NO_TEAM, teamOverlaps } from "../core/groups.ts";
import { BUCKETS } from "../core/paths.ts";

/** GitHub repo names are letters, digits, `.`, `_` and `-`; logins are a subset of that. */
export const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export type OwnerSource = {
  kind: "owner";
  owner: string;
  include: string[];
  exclude: string[];
  archived: boolean;
  forks: boolean;
};
export type RepoSource = { kind: "repo"; owner: string; name: string };
export type Source = OwnerSource | RepoSource;

// One input shape for both kinds of source, so a mistake gets one clear message instead of a
// union error that lists everything each branch expected.
const SourceSchema = z
  .strictObject({
    owner: z.string().min(1).optional(),
    repo: z.string().regex(REPO_PATTERN, "must look like owner/name").optional(),
    include: z.array(z.string().min(1)).min(1).optional(),
    exclude: z.array(z.string().min(1)).optional(),
    archived: z.boolean().optional(),
    forks: z.boolean().optional(),
  })
  .refine((s) => (s.owner === undefined) !== (s.repo === undefined), {
    message: "set exactly one of `owner` or `repo`",
  })
  .refine(
    (s) => s.repo === undefined || (s.include ?? s.exclude ?? s.archived ?? s.forks) === undefined,
    { message: "`include`, `exclude`, `archived` and `forks` only apply to `owner` sources" },
  )
  .transform((s): Source => {
    if (s.repo !== undefined) {
      const [owner = "", name = ""] = s.repo.split("/");
      return { kind: "repo", owner, name };
    }
    return {
      kind: "owner",
      owner: s.owner ?? "",
      include: s.include ?? ["*"],
      exclude: s.exclude ?? [],
      archived: s.archived ?? false,
      forks: s.forks ?? false,
    };
  });

const GitHubSchema = z.strictObject({
  api_url: z.url().default("https://api.github.com"),
  token_env: z.string().min(1).default("GITHUB_TOKEN"),
});

const Pattern = z.string().min(1);

const Regex = z.string().refine(
  (source) => {
    try {
      new RegExp(source);
      return source.length > 0;
    } catch {
      return false;
    }
  },
  { message: "must be a valid regular expression" },
);

const BotsSchema = z.strictObject({
  /** Logins to treat as bots, besides the accounts GitHub itself marks as bots. */
  accounts: z.array(Pattern).default([]),
  /** Bot logins whose reviews count as review. */
  reviewers: z.array(Pattern).default([]),
  /** Count PRs that bots open in flow metrics. */
  include_prs: z.boolean().default(false),
  /** Comments and review bodies matching any of these are ignored, as boilerplate. */
  ignore_bodies: z.array(Regex).default([]),
});

const PathRuleSchema = z.strictObject({
  match: z.union([Pattern, z.array(Pattern).min(1)]).transform((m) => (Array.isArray(m) ? m : [m])),
  bucket: z.enum(BUCKETS),
  repos: z.array(Pattern).min(1).optional(),
});

const Day = z.iso.date("must be a date like 2026-06-01");

/** A team member: a login, or a login with the dates they were in the team. */
const MemberSchema = z.union([
  z
    .string()
    .min(1)
    .transform((login): Member => ({ login, from: null, to: null, secondary: false })),
  z
    .strictObject({
      login: z.string().min(1),
      from: Day.optional(),
      to: Day.optional(),
      /** Listed with the team, but their PRs count for their primary team. */
      secondary: z.boolean().default(false),
    })
    .refine((m) => m.from === undefined || m.to === undefined || m.from <= m.to, {
      message: "`from` must come before `to`",
    })
    .transform(
      (m): Member => ({
        login: m.login,
        from: m.from ?? null,
        to: m.to ?? null,
        secondary: m.secondary,
      }),
    ),
]);

const TeamSchema = z.strictObject({
  /** Everyone in the team. A PR belongs to its author's team on the day it opened. */
  people: z.array(MemberSchema).min(1, "list the team's people"),
});

const ProductSchema = z
  .strictObject({
    /** Repos (owner/name globs) whose PRs belong to the product. */
    repos: z.array(Pattern).default([]),
    /** Teams whose PRs belong to the product, in any repo. */
    teams: z.array(z.string().min(1)).default([]),
  })
  .refine((product) => product.repos.length + product.teams.length > 0, {
    message: "give the product `repos`, `teams` or both",
  });

const RESERVED = [NO_TEAM, NO_PRODUCT].map((name) => name.toLowerCase());

/** Checks that span teams and products: reserved names, known teams, one team per person per day. */
function checkGroups(
  config: {
    teams: Record<string, { people: Member[] }>;
    products: Record<string, { teams: string[] }>;
  },
  ctx: z.RefinementCtx,
): void {
  for (const [kind, names] of [
    ["teams", Object.keys(config.teams)],
    ["products", Object.keys(config.products)],
  ] as const) {
    for (const name of names) {
      if (RESERVED.includes(name.toLowerCase())) {
        ctx.addIssue({
          code: "custom",
          path: [kind, name],
          message: `"${name}" is the report's name for PRs outside any of the ${kind}: choose another`,
        });
      }
    }
  }
  for (const [name, product] of Object.entries(config.products)) {
    for (const team of product.teams) {
      if (!(team in config.teams)) {
        ctx.addIssue({
          code: "custom",
          path: ["products", name, "teams"],
          message: `no team is called "${team}"`,
        });
      }
    }
  }
  const teams = Object.entries(config.teams).map(([name, team]) => ({
    name,
    members: team.people,
  }));
  for (const problem of teamOverlaps(teams)) {
    ctx.addIssue({ code: "custom", path: ["teams"], message: problem });
  }
}

export const ConfigSchema = z
  .strictObject({
    sources: z.array(SourceSchema).min(1, "add at least one source"),
    since: z.iso.date("must be a date like 2025-10-01"),
    // prefault, not default: the empty object still runs through the schema, so the field
    // defaults above apply when the whole block is left out.
    github: GitHubSchema.prefault({}),
    /** Where synced data lives, relative to the config file. */
    data_dir: z.string().min(1).default(".codeflow"),
    /** Measured branches per repo (owner/name glob → branches). Default: the default branch. */
    branches: z.record(Pattern, z.array(Pattern).min(1)).default({}),
    /** Same-repo head branches that make a PR a promotion or back-merge. Replaces the defaults. */
    promotions: z.array(Pattern).default([...DEFAULT_PROMOTION_BRANCHES]),
    bots: BotsSchema.prefault({}),
    /** Path rules checked before the built-in ones. */
    paths: z.array(PathRuleSchema).default([]),
    /** Teams by name: who works together. A person is in one team at a time (decision D25). */
    teams: z.record(z.string().min(1), TeamSchema).default({}),
    /** Products by name: repos and teams. Products may overlap. */
    products: z.record(z.string().min(1), ProductSchema).default({}),
  })
  .superRefine(checkGroups);

export type Config = z.output<typeof ConfigSchema>;
