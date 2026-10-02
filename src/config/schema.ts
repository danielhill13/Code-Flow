import { z } from "zod";

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

export const ConfigSchema = z.strictObject({
  sources: z.array(SourceSchema).min(1, "add at least one source"),
  since: z.iso.date("must be a date like 2025-10-01"),
  // prefault, not default: the empty object still runs through the schema, so the field
  // defaults above apply when the whole `github` block is left out.
  github: GitHubSchema.prefault({}),
});

export type Config = z.output<typeof ConfigSchema>;
