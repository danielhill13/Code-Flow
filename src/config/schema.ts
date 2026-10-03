import { z } from "zod";
import { DEFAULT_PROMOTION_BRANCHES } from "../core/derive.ts";
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

export const ConfigSchema = z.strictObject({
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
});

export type Config = z.output<typeof ConfigSchema>;
