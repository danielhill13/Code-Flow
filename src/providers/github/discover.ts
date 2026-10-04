import picomatch from "picomatch";
import type { GitHubSource, OwnerSource, Source } from "../../config/schema.ts";
import { type GitHubClient, graphqlErrors } from "./client.ts";
import { OWNER_REPOS, REPO } from "./queries.ts";

export type Repo = {
  id: string;
  owner: string;
  name: string;
  /** owner/name, spelled the way GitHub spells it. */
  fullName: string;
  /** Null only for an empty repo. */
  defaultBranch: string | null;
  archived: boolean;
  fork: boolean;
  empty: boolean;
  private: boolean;
  prs: { open: number; merged: number; closed: number };
  /** When the most recently updated PR was last updated; null if the repo has no PRs. */
  lastPrActivity: string | null;
};

export type SkipReason = "excluded" | "not included" | "archived" | "fork" | "empty" | "duplicate";
export type Skipped = { repo: string; reason: SkipReason };

export type SourceResult = {
  source: Source;
  ownerType?: "Organization" | "User";
  repos: Repo[];
  skipped: Skipped[];
  /** Set when the source itself could not be read; `repos` is then empty. */
  error?: string;
};

type RepoNode = {
  id: string;
  name: string;
  nameWithOwner: string;
  owner: { login: string };
  isArchived: boolean;
  isFork: boolean;
  isEmpty: boolean;
  isPrivate: boolean;
  defaultBranchRef: { name: string } | null;
  open: { totalCount: number };
  merged: { totalCount: number };
  closed: { totalCount: number };
  latest: { nodes: { updatedAt: string }[] };
};

type OwnerReposData = {
  repositoryOwner: {
    __typename: "Organization" | "User";
    repositories: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: RepoNode[];
    };
  } | null;
};

/** Resolves every source to the repos it selects. A repo selected twice is measured once. */
export async function discoverRepos(
  client: GitHubClient,
  sources: readonly GitHubSource[],
): Promise<SourceResult[]> {
  const results: SourceResult[] = [];
  for (const source of sources) {
    try {
      results.push(
        source.kind === "owner" ? await fromOwner(client, source) : await fromRepo(client, source),
      );
    } catch (err) {
      const errors = graphqlErrors(err);
      const message = errors ? errors.map((e) => e.message).join("; ") : String(err);
      results.push({ source, repos: [], skipped: [], error: message });
    }
  }
  return dropDuplicates(results);
}

async function fromOwner(client: GitHubClient, source: OwnerSource): Promise<SourceResult> {
  const nodes: RepoNode[] = [];
  let ownerType: "Organization" | "User" | undefined;
  let after: string | null = null;
  do {
    const data: OwnerReposData = await client.graphql<OwnerReposData>(OWNER_REPOS, {
      login: source.owner,
      after,
    });
    const owner = data.repositoryOwner;
    if (!owner) {
      return { source, repos: [], skipped: [], error: notFound(source.owner) };
    }
    ownerType = owner.__typename;
    nodes.push(...owner.repositories.nodes);
    after = owner.repositories.pageInfo.hasNextPage ? owner.repositories.pageInfo.endCursor : null;
  } while (after);

  return { source, ownerType, ...selectRepos(source, nodes.map(toRepo)) };
}

async function fromRepo(
  client: GitHubClient,
  source: Extract<Source, { kind: "repo" }>,
): Promise<SourceResult> {
  let node: RepoNode | null;
  try {
    ({ repository: node } = await client.graphql<{ repository: RepoNode | null }>(REPO, {
      owner: source.owner,
      name: source.name,
    }));
  } catch (err) {
    if (!graphqlErrors(err)?.every((e) => e.type === "NOT_FOUND")) throw err;
    node = null;
  }
  if (!node) {
    return { source, repos: [], skipped: [], error: notFound(`${source.owner}/${source.name}`) };
  }
  // A repo named explicitly is measured even if it is archived or a fork: naming it is the
  // opt-in. An empty repo has nothing to measure.
  const repo = toRepo(node);
  return repo.empty
    ? { source, repos: [], skipped: [{ repo: repo.fullName, reason: "empty" }] }
    : { source, repos: [repo], skipped: [] };
}

/** Applies an owner source's filters. Patterns match the repo name, ignoring case. */
export function selectRepos(
  source: OwnerSource,
  repos: readonly Repo[],
): { repos: Repo[]; skipped: Skipped[] } {
  // dot: true so `*` also matches repos like `.github`.
  const options = { nocase: true, dot: true };
  const included = picomatch(source.include, options);
  const excluded = source.exclude.length > 0 ? picomatch(source.exclude, options) : () => false;

  const selected: Repo[] = [];
  const skipped: Skipped[] = [];
  for (const repo of repos) {
    const reason: SkipReason | undefined = excluded(repo.name)
      ? "excluded"
      : !included(repo.name)
        ? "not included"
        : repo.archived && !source.archived
          ? "archived"
          : repo.fork && !source.forks
            ? "fork"
            : repo.empty
              ? "empty"
              : undefined;
    if (reason) skipped.push({ repo: repo.fullName, reason });
    else selected.push(repo);
  }
  return { repos: selected, skipped };
}

/** Keeps each repo under the first source that selected it. */
export function dropDuplicates(results: readonly SourceResult[]): SourceResult[] {
  const seen = new Set<string>();
  return results.map((result) => {
    const repos: Repo[] = [];
    const skipped = [...result.skipped];
    for (const repo of result.repos) {
      if (seen.has(repo.id)) {
        skipped.push({ repo: repo.fullName, reason: "duplicate" });
      } else {
        seen.add(repo.id);
        repos.push(repo);
      }
    }
    return { ...result, repos, skipped };
  });
}

function toRepo(node: RepoNode): Repo {
  return {
    id: node.id,
    owner: node.owner.login,
    name: node.name,
    fullName: node.nameWithOwner,
    defaultBranch: node.defaultBranchRef?.name ?? null,
    archived: node.isArchived,
    fork: node.isFork,
    empty: node.isEmpty,
    private: node.isPrivate,
    prs: {
      open: node.open.totalCount,
      merged: node.merged.totalCount,
      closed: node.closed.totalCount,
    },
    lastPrActivity: node.latest.nodes[0]?.updatedAt ?? null,
  };
}

/** `acme` for an owner source, `acme/api` for a repo source. */
export function sourceName(source: Source): string {
  switch (source.kind) {
    case "owner":
      return source.owner;
    case "repo":
      return `${source.owner}/${source.name}`;
    case "ado":
      return `${source.organization}${source.project ? `/${source.project}` : ""} (Azure DevOps)`;
  }
}

function notFound(what: string): string {
  return `${what} not found, or this token can't see it`;
}
