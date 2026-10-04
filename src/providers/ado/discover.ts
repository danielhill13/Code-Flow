// Which Azure DevOps repos a source selects: one project's or every project's, narrowed by repo
// name, leaving out disabled and empty repos (and forks, unless asked for).
import picomatch from "picomatch";
import type { AdoSource } from "../../config/schema.ts";
import type { AdoClient } from "./client.ts";
import type { AdoRepo } from "./types.ts";

export type AdoSkipReason = "excluded" | "not included" | "disabled" | "fork" | "empty";

export type AdoSourceResult = {
  source: AdoSource;
  repos: AdoRepo[];
  skipped: { repo: string; reason: AdoSkipReason }[];
  error?: string;
};

type RawRepo = {
  id: string;
  name: string;
  defaultBranch?: string;
  isDisabled?: boolean;
  isFork?: boolean;
  size?: number;
  project: { name: string };
};

export async function discoverAdo(client: AdoClient, source: AdoSource): Promise<AdoSourceResult> {
  try {
    const projects = source.project
      ? [source.project]
      : (await client.list<{ name: string; state?: string }>("/_apis/projects", { $top: 500 }))
          .filter((p) => p.state === undefined || p.state === "wellFormed")
          .map((p) => p.name)
          .sort((a, b) => a.localeCompare(b));
    const raw: RawRepo[] = [];
    for (const project of projects) {
      const { value } = await client.get<{ value: RawRepo[] }>(
        `/${encodeURIComponent(project)}/_apis/git/repositories`,
      );
      raw.push(...value);
    }
    return { source, ...selectAdoRepos(source, client.organization, raw) };
  } catch (err) {
    return { source, repos: [], skipped: [], error: (err as Error).message };
  }
}

/** Applies a source's filters. Patterns match the repo's name, ignoring case. */
export function selectAdoRepos(
  source: AdoSource,
  organization: string,
  raw: readonly RawRepo[],
): Omit<AdoSourceResult, "source"> {
  const options = { nocase: true, dot: true };
  const included = picomatch(source.include, options);
  const excluded = source.exclude.length > 0 ? picomatch(source.exclude, options) : () => false;
  const repos: AdoRepo[] = [];
  const skipped: AdoSourceResult["skipped"] = [];
  for (const repo of [...raw].sort((a, b) => a.name.localeCompare(b.name))) {
    const fullName = `${organization}/${repo.project.name}/${repo.name}`;
    const reason: AdoSkipReason | undefined = excluded(repo.name)
      ? "excluded"
      : !included(repo.name)
        ? "not included"
        : repo.isDisabled
          ? "disabled"
          : repo.isFork && !source.forks
            ? "fork"
            : !repo.defaultBranch
              ? "empty"
              : undefined;
    if (reason) {
      skipped.push({ repo: fullName, reason });
      continue;
    }
    repos.push({
      id: repo.id,
      name: repo.name,
      project: repo.project.name,
      fullName,
      defaultBranch: branchName(repo.defaultBranch ?? null),
      disabled: repo.isDisabled ?? false,
      fork: repo.isFork ?? false,
    });
  }
  return { repos, skipped };
}

/** "refs/heads/main" → "main". */
export function branchName(ref: string | null): string | null {
  return ref === null ? null : ref.replace(/^refs\/heads\//, "");
}
