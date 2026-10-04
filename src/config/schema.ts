import { z } from "zod";
import { DEFAULT_PROMOTION_BRANCHES } from "../core/derive.ts";
import { everyMs } from "../core/every.ts";

export { everyMs };

import { groupProblems, type Member, NO_TEAM, noGroup } from "../core/groups.ts";
import { BUCKETS } from "../core/paths.ts";
import { type Rule, ruleProblems } from "../core/rules.ts";

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
  /** Everyone in the team, by person key or login. A PR counts for its author's team that day. */
  people: z.array(MemberSchema).min(1, "list the team's people"),
});

/** A person: their GitHub logins (default: the key), and what config says about them. */
const PersonSchema = z
  .strictObject({
    name: z.string().min(1).optional(),
    /** Every login they use, current first. Renamed and second accounts belong here. */
    github: z.array(z.string().min(1)).min(1).optional(),
    /** Count them as internal (true) or external (false) whatever GitHub says. */
    internal: z.boolean().optional(),
    /** Treat them as a bot: a service account, say. */
    bot: z.boolean().optional(),
  })
  .prefault({});

const KIND = /^[a-z][a-z0-9_-]*$/;

const GroupSchema = z
  .strictObject({
    /** What sort of group: product, area, program… One lowercase word. */
    kind: z
      .string()
      .regex(KIND, "a kind is one lowercase word, like product or area")
      .default("group"),
    /** Repos (owner/name globs) whose PRs belong to the group. */
    repos: z.array(Pattern).default([]),
    /** Teams whose PRs belong to the group, in any repo. */
    teams: z.array(z.string().min(1)).default([]),
    /** People whose PRs belong to the group, in any repo. */
    people: z.array(z.string().min(1)).default([]),
  })
  .refine((group) => group.repos.length + group.teams.length + group.people.length > 0, {
    message: "give the group `repos`, `teams`, `people`, or a mix",
  });

/** `products:` is shorthand for groups of kind product. */
const ProductSchema = z
  .strictObject({
    repos: z.array(Pattern).default([]),
    teams: z.array(z.string().min(1)).default([]),
    people: z.array(z.string().min(1)).default([]),
  })
  .refine((product) => product.repos.length + product.teams.length + product.people.length > 0, {
    message: "give the product `repos`, `teams`, `people`, or a mix",
  });

/** Lowercase, no `:`: ids with a `:` belong to the rules config keys stand for. */
const RuleId = /^[a-z0-9][a-z0-9_.-]*$/;

/** One rule in rules.yml. Validated whole with the rest of the config (checkGroups). */
const RuleSchema = z.strictObject({
  id: z.string().regex(RuleId, "an id is lowercase letters, digits, - _ and ."),
  description: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  scope: z
    .strictObject({
      repos: z.array(Pattern).optional(),
      teams: z.array(z.string().min(1)).optional(),
      groups: z.array(z.string().min(1)).optional(),
      people: z.array(z.string().min(1)).optional(),
    })
    .default({}),
  when: z
    .strictObject({
      labels: z.array(z.string().min(1)).optional(),
      title: Regex.optional(),
      base: z.array(Pattern).optional(),
      head: z.array(Pattern).optional(),
      author_association: z.array(z.string().min(1)).optional(),
      from_fork: z.boolean().optional(),
      draft: z.boolean().optional(),
      author_bot: z.boolean().optional(),
    })
    .default({}),
  // biome-ignore lint/suspicious/noThenProperty: rules.yml pairs `when:` with `then:`; code reads it as `effects`
  then: z.strictObject({
    count: z.boolean().optional(),
    internal: z.boolean().optional(),
    ignore_comments: z.array(Regex).optional(),
    measured_branches: z.array(Pattern).min(1).optional(),
    promotion_branches: z.array(Pattern).optional(),
    paths: z
      .array(
        z.strictObject({
          match: z
            .union([Pattern, z.array(Pattern).min(1)])
            .transform((m) => (Array.isArray(m) ? m : [m])),
          bucket: z.enum(BUCKETS),
        }),
      )
      .optional(),
    bot: z.boolean().optional(),
    bot_reviews_count: z.boolean().optional(),
  }),
});

export type RuleInput = z.output<typeof RuleSchema>;

/** A rules.yml on its own, as `rules test` and import read one. */
export const RulesFileSchema = z.strictObject({ rules: z.array(RuleSchema).default([]) });

type GroupInput = { kind: string; teams: string[] };

/**
 * Checks that span people, teams and groups: reserved and repeated names, teams that exist, a
 * login on one person only, one team per person per day.
 */
function checkGroups(
  config: {
    people: Record<string, { github?: string[] | undefined }>;
    teams: Record<string, { people: Member[] }>;
    groups: Record<string, GroupInput>;
    products: Record<string, { teams: string[] }>;
    rules: RuleInput[];
  },
  ctx: z.RefinementCtx,
): void {
  const groups: [string, string, GroupInput][] = [
    ...Object.entries(config.groups).map(([n, g]): [string, string, GroupInput] => [
      "groups",
      n,
      g,
    ]),
    ...Object.entries(config.products).map(([n, g]): [string, string, GroupInput] => [
      "products",
      n,
      { kind: "product", teams: g.teams },
    ]),
  ];
  const reserved = new Set(
    [NO_TEAM, ...groups.map(([, , g]) => noGroup(g.kind))].map((n) => n.toLowerCase()),
  );
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });
  for (const name of Object.keys(config.teams)) {
    if (reserved.has(name.toLowerCase())) {
      issue(["teams", name], `"${name}" is the report's name for PRs outside any team or group`);
    }
  }
  const seen = new Set<string>();
  for (const [key, name, group] of groups) {
    if (reserved.has(name.toLowerCase())) {
      issue(
        [key, name],
        `"${name}" is the report's name for PRs in no ${group.kind}: choose another`,
      );
    }
    if (seen.has(name.toLowerCase())) issue([key, name], `another group is called "${name}"`);
    seen.add(name.toLowerCase());
    for (const team of group.teams) {
      if (!(team in config.teams)) issue([key, name, "teams"], `no team is called "${team}"`);
    }
  }
  const problems = groupProblems({
    people: Object.entries(config.people).map(([key, p]) => ({
      key,
      name: null,
      github: p.github ?? [key],
      internal: null,
      bot: null,
    })),
    teams: Object.entries(config.teams).map(([name, team]) => ({ name, members: team.people })),
  });
  for (const problem of problems) issue(["teams"], problem);
  const known = {
    teams: Object.keys(config.teams),
    groups: [...Object.keys(config.groups), ...Object.keys(config.products)],
  };
  for (const problem of ruleProblems(
    config.rules.map((rule) => asRule(rule, "rules.yml")),
    known,
  )) {
    issue(["rules"], problem);
  }
}

/** A rule as config wrote it, in the engine's shape. */
export function asRule(input: RuleInput, source: string): Rule {
  return {
    id: input.id,
    description: input.description ?? null,
    enabled: input.enabled,
    scope: input.scope,
    when: input.when,
    effects: input.then,
    source,
  };
}

/** What org.yml holds: what to measure, and the older rule keys. */
const settingsShape = {
  sources: z.array(SourceSchema).min(1, "add at least one source"),
  since: z.iso.date("must be a date like 2025-10-01"),
  // prefault, not default: the empty object still runs through the schema, so the field
  // defaults above apply when the whole block is left out.
  github: GitHubSchema.prefault({}),
  /**
   * Where synced data lives, relative to the config file (or the org's folder). Default:
   * .codeflow next to a single-file config, .codeflow/<org> in a workspace.
   */
  data_dir: z.string().min(1).optional(),
  /** Measured branches per repo (owner/name glob → branches). Default: the default branch. */
  branches: z.record(Pattern, z.array(Pattern).min(1)).default({}),
  /** Same-repo head branches that make a PR a promotion or back-merge. Replaces the defaults. */
  promotions: z.array(Pattern).default([...DEFAULT_PROMOTION_BRANCHES]),
  bots: BotsSchema.prefault({}),
  /** Path rules checked before the built-in ones. */
  paths: z.array(PathRuleSchema).default([]),
  /**
   * How often `codeflow serve` syncs the org on its own: a number and a unit (m, h, d), such as
   * 24h or 6h, or off. Daily by default (decision D37).
   */
  sync_every: z
    .string()
    .regex(/^(off|\d+[mhd])$/, "must be like 24h, 6h, 30m, 7d, or off")
    .refine((text) => text === "off" || everyMs(text) >= 15 * 60_000, "must be 15m or longer")
    .default("24h"),
  /**
   * An open PR with no activity by a person for this many days is stale: shown and listed apart
   * from the PRs open now (decision D36).
   */
  stale_after_days: z.int().min(1).max(3650).default(90),
  /** Whether the report offers one person's numbers: picking people, reviewers by name. */
  people_views: z.boolean().default(true),
};

/** What people.yml, groups.yml and rules.yml hold. */
const definitionsShape = {
  /** People by key, with their logins (decision D30). */
  people: z.record(z.string().min(1), PersonSchema).default({}),
  /** Teams by name: who works together. A person is in one team at a time (decision D25). */
  teams: z.record(z.string().min(1), TeamSchema).default({}),
  /** Groups by name, of any kind: repos, teams and people. Groups may overlap. */
  groups: z.record(z.string().min(1), GroupSchema).default({}),
  /** Shorthand for groups of kind product. */
  products: z.record(z.string().min(1), ProductSchema).default({}),
  /** The org's own rules (decision D31): what counts, repo rules, people rules. */
  rules: z.array(RuleSchema).default([]),
};

export const ConfigSchema = z
  .strictObject({ ...settingsShape, ...definitionsShape })
  .superRefine(checkGroups);

/** The bundle format's version: `codeflow: 1` at the top of every bundle (decision D32). */
export const BUNDLE_VERSION = 1;

/**
 * A bundle of an org's config, as `codeflow export` writes and `codeflow import` reads. Each
 * part is optional; values take the same form as in the org's files. Checked here for shape;
 * whether it fits with the rest of an org is checked when it is imported.
 */
export const BundleSchema = z.strictObject({
  codeflow: z.literal(BUNDLE_VERSION, {
    message: `this isn't a codeflow bundle of a version this codeflow reads (it reads ${BUNDLE_VERSION})`,
  }),
  /** The org it was exported from, for the record. */
  org: z.string().optional(),
  /** When it was exported, ISO 8601. */
  exported: z.string().optional(),
  /** What org.yml holds. Rarely moved between orgs: sources and dates are each org's own. */
  settings: z.strictObject(settingsShape).partial().optional(),
  people: definitionsShape.people.optional(),
  teams: definitionsShape.teams.optional(),
  groups: definitionsShape.groups.optional(),
  products: definitionsShape.products.optional(),
  rules: definitionsShape.rules.optional(),
});

export type Config = z.output<typeof ConfigSchema>;
