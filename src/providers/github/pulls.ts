import { CodeflowError } from "../../errors.ts";
import { type GitHubClient, graphqlErrors, httpStatus, IncompleteResponseError } from "./client.ts";
import {
  PR_CONNECTION,
  PR_CONNECTIONS,
  PR_PAGE,
  PR_PAGE_SIZE,
  type PrConnectionName,
} from "./queries.ts";

export type PrState = "OPEN" | "CLOSED" | "MERGED";

type Connection = {
  totalCount: number;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: unknown[];
};

/**
 * A pull request as PR_PAGE returns it. It is stored whole; only the fields sync itself reads
 * are typed here.
 */
export type GhPullRequest = {
  id: string;
  number: number;
  state: PrState;
  updatedAt: string;
} & Record<PrConnectionName, Connection>;

export type PageRequest = {
  after: string | null;
  /** null for every state. */
  states: PrState[] | null;
  direction: "ASC" | "DESC";
};

export type Page = { prs: GhPullRequest[]; endCursor: string | null; hasNextPage: boolean };

type GraphqlClient = Pick<GitHubClient, "graphql">;

type PrPageData = {
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: GhPullRequest[];
    };
  } | null;
};

/** One page of a repo's PRs, each complete: no connection is left at its first 100 nodes. */
export async function fetchPrPage(
  client: GraphqlClient,
  repo: { owner: string; name: string },
  request: PageRequest,
  size = PR_PAGE_SIZE,
): Promise<Page> {
  let data: PrPageData;
  try {
    data = await client.graphql<PrPageData>(PR_PAGE, {
      owner: repo.owner,
      name: repo.name,
      first: size,
      after: request.after,
      states: request.states,
      direction: request.direction,
      dryRun: false,
    });
  } catch (err) {
    // A page of very large PRs can exceed GitHub's time limit for one query, or come back cut
    // off. Cursors are keyset-based, so a smaller page simply ends earlier and the walk carries
    // on from there.
    if (size > 1 && isTooHeavy(err)) {
      return fetchPrPage(client, repo, request, Math.ceil(size / 2));
    }
    throw err;
  }
  if (!data.repository) {
    throw new CodeflowError(`${repo.owner}/${repo.name} is no longer visible to this token.`);
  }
  const { nodes, pageInfo } = data.repository.pullRequests;
  for (const pr of nodes) await completeConnections(client, pr);
  return { prs: nodes, endCursor: pageInfo.endCursor, hasNextPage: pageInfo.hasNextPage };
}

/** Fetches the rest of every connection that has more than its first 100 nodes, in place. */
export async function completeConnections(client: GraphqlClient, pr: GhPullRequest): Promise<void> {
  for (const name of PR_CONNECTIONS) {
    const connection = pr[name];
    while (connection.pageInfo.hasNextPage && connection.pageInfo.endCursor) {
      const data = await client.graphql<{ node: Partial<Record<PrConnectionName, Connection>> }>(
        PR_CONNECTION[name],
        { id: pr.id, after: connection.pageInfo.endCursor },
      );
      const next = data.node?.[name];
      if (!next || next.nodes.length === 0) break;
      connection.nodes.push(...next.nodes);
      connection.pageInfo = next.pageInfo;
    }
  }
}

function isTooHeavy(err: unknown): boolean {
  if (err instanceof IncompleteResponseError) return true;
  const status = httpStatus(err);
  if (status === 502 || status === 504) return true;
  return graphqlErrors(err)?.some((e) => /time ?out|timed out|in time/i.test(e.message)) ?? false;
}
