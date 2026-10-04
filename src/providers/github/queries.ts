// GraphQL documents. Each selects `rateLimit { cost }` so GitHubClient can count points spent.

const RATE_LIMIT = "rateLimit { cost remaining limit resetAt }";

export const VIEWER = /* GraphQL */ `
  query Viewer {
    ${RATE_LIMIT}
    viewer { login }
  }
`;

const REPO_FIELDS = /* GraphQL */ `
  fragment RepoFields on Repository {
    id
    name
    nameWithOwner
    owner { login }
    isArchived
    isFork
    isEmpty
    isPrivate
    defaultBranchRef { name }
    open: pullRequests(states: OPEN) { totalCount }
    merged: pullRequests(states: MERGED) { totalCount }
    closed: pullRequests(states: CLOSED) { totalCount }
    latest: pullRequests(first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { updatedAt }
    }
  }
`;

/** Repos an organization or user owns (not ones they only collaborate on), 100 per page. */
export const OWNER_REPOS = /* GraphQL */ `
  query OwnerRepos($login: String!, $after: String) {
    ${RATE_LIMIT}
    repositoryOwner(login: $login) {
      __typename
      repositories(
        first: 100
        after: $after
        ownerAffiliations: [OWNER]
        orderBy: { field: NAME, direction: ASC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes { ...RepoFields }
      }
    }
  }
  ${REPO_FIELDS}
`;

export const REPO = /* GraphQL */ `
  query Repo($owner: String!, $name: String!) {
    ${RATE_LIMIT}
    repository(owner: $owner, name: $name) { ...RepoFields }
  }
  ${REPO_FIELDS}
`;

/**
 * Counts what a first sync fetches, without fetching it: PRs updated since a date, and older
 * open PRs. Repeated `repo:` qualifiers in a search are OR'd together.
 */
export const SYNC_SEARCH_COUNTS = /* GraphQL */ `
  query SyncSearchCounts($updated: String!, $olderOpen: String!) {
    ${RATE_LIMIT}
    updated: search(query: $updated, type: ISSUE) { issueCount }
    olderOpen: search(query: $olderOpen, type: ISSUE) { issueCount }
  }
`;

/** PRs per page of PR_PAGE. Small enough to stay well inside GitHub's per-query time limit. */
export const PR_PAGE_SIZE = 25;

/**
 * Connections on a PR that sync reads completely: PR_PAGE fetches the first 100 nodes of each,
 * and PR_CONNECTION fetches the rest. GitHub itself caps some (commits at 250, files at 3,000);
 * past a cap, the count exceeds the nodes stored, which marks the PR as truncated.
 *
 * The count to compare is `totalCount`, except on `timelineItems`: there `totalCount` ignores
 * the `itemTypes` filter (and even undercounts the whole timeline), so it is `filteredCount`.
 * Payloads synced before `filteredCount` was selected are still complete: sync pages every
 * timeline to its end, and GitHub does not cap timelines.
 */
export const PR_CONNECTIONS = ["commits", "reviews", "comments", "files", "timelineItems"] as const;
export type PrConnectionName = (typeof PR_CONNECTIONS)[number];

const CONNECTION_ARGS: Partial<Record<PrConnectionName, string>> = {
  timelineItems: `itemTypes: [
    READY_FOR_REVIEW_EVENT CONVERT_TO_DRAFT_EVENT REVIEW_REQUESTED_EVENT HEAD_REF_FORCE_PUSHED_EVENT
    BASE_REF_CHANGED_EVENT CLOSED_EVENT REOPENED_EVENT MERGED_EVENT
  ]`,
};

const CONNECTION_NODES: Record<PrConnectionName, string> = {
  commits:
    "commit { oid authoredDate committedDate message additions deletions parents { totalCount } author { user { login } } }",
  reviews: "author { __typename login } state submittedAt body",
  comments: "author { __typename login } createdAt body",
  files: "path additions deletions changeType",
  timelineItems: `
    __typename
    ... on ReadyForReviewEvent { createdAt }
    ... on ConvertToDraftEvent { createdAt }
    ... on ReviewRequestedEvent {
      createdAt
      requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Team { slug } }
    }
    ... on HeadRefForcePushedEvent { createdAt }
    ... on BaseRefChangedEvent { createdAt previousRefName currentRefName }
    ... on ClosedEvent { createdAt }
    ... on ReopenedEvent { createdAt }
    ... on MergedEvent { createdAt }
  `,
};

/** One connection's selection. `after` names the cursor variable when fetching later pages. */
function connection(name: PrConnectionName, after?: string): string {
  const args = ["first: 100", after && `after: ${after}`, CONNECTION_ARGS[name]].filter(Boolean);
  return `${name}(${args.join(", ")}) {
    totalCount${name === "timelineItems" ? " filteredCount" : ""}
    pageInfo { hasNextPage endCursor }
    nodes { ${CONNECTION_NODES[name]} }
  }`;
}

/**
 * One page of a repo's pull requests ordered by last update, with everything their metrics
 * need. `$states: null` means every state. sync walks these pages; see sync.ts.
 */
export const PR_PAGE = /* GraphQL */ `
  query PrPage(
    $owner: String!
    $name: String!
    $first: Int!
    $after: String
    $states: [PullRequestState!]
    $direction: OrderDirection!
    $dryRun: Boolean!
  ) {
    rateLimit(dryRun: $dryRun) { cost remaining limit resetAt }
    repository(owner: $owner, name: $name) {
      pullRequests(
        first: $first
        after: $after
        states: $states
        orderBy: { field: UPDATED_AT, direction: $direction }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id number title body url state isDraft isCrossRepository
          createdAt updatedAt mergedAt closedAt
          baseRefName headRefName
          additions deletions changedFiles
          reviewDecision
          author { __typename login }
          authorAssociation
          mergedBy { __typename login }
          mergeCommit { oid }
          labels(first: 20) { totalCount nodes { name } }
          closingIssuesReferences(first: 10) {
            totalCount
            nodes { number repository { nameWithOwner } }
          }
          reviewThreads { totalCount }
          ${PR_CONNECTIONS.map((name) => connection(name)).join("\n")}
        }
      }
    }
  }
`;

/** The next 100 nodes of one connection on one PR. */
export const PR_CONNECTION = Object.fromEntries(
  PR_CONNECTIONS.map((name) => [
    name,
    /* GraphQL */ `
      query PrConnection($id: ID!, $after: String!) {
        ${RATE_LIMIT}
        node(id: $id) { ... on PullRequest { ${connection(name, "$after")} } }
      }
    `,
  ]),
) as Record<PrConnectionName, string>;
