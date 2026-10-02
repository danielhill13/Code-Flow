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

/** Counts matches without fetching any. Repeated `repo:` qualifiers are OR'd together. */
export const SEARCH_COUNT = /* GraphQL */ `
  query SearchCount($q: String!) {
    ${RATE_LIMIT}
    search(query: $q, type: ISSUE) { issueCount }
  }
`;

/** PRs per page of PR_PAGE. Small enough to stay well inside GitHub's per-query time limit. */
export const PR_PAGE_SIZE = 25;

/**
 * One page of a repo's pull requests, most recently updated first, with everything a PR's
 * metrics need. `sync` walks these pages back to its watermark. Connections cap at 100 nodes;
 * a PR that exceeds one (`totalCount` > 100) needs follow-up calls.
 */
export const PR_PAGE = /* GraphQL */ `
  query PrPage($owner: String!, $name: String!, $first: Int!, $after: String, $dryRun: Boolean!) {
    rateLimit(dryRun: $dryRun) { cost remaining limit resetAt }
    repository(owner: $owner, name: $name) {
      pullRequests(first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id number title body url state isDraft
          createdAt updatedAt mergedAt closedAt
          baseRefName headRefName
          additions deletions changedFiles
          author { __typename login }
          mergedBy { __typename login }
          commits(first: 100) {
            totalCount
            nodes { commit { oid authoredDate committedDate message author { user { login } } } }
          }
          reviews(first: 100) {
            totalCount
            nodes { author { __typename login } state submittedAt body }
          }
          reviewThreads(first: 100) { totalCount }
          comments(first: 100) {
            totalCount
            nodes { author { __typename login } createdAt body }
          }
          files(first: 100) {
            totalCount
            nodes { path additions deletions changeType }
          }
          timelineItems(
            first: 100
            itemTypes: [
              READY_FOR_REVIEW_EVENT
              CONVERT_TO_DRAFT_EVENT
              REVIEW_REQUESTED_EVENT
              HEAD_REF_FORCE_PUSHED_EVENT
              BASE_REF_CHANGED_EVENT
              CLOSED_EVENT
              REOPENED_EVENT
              MERGED_EVENT
            ]
          ) {
            totalCount
            nodes {
              __typename
              ... on ReadyForReviewEvent { createdAt }
              ... on ConvertToDraftEvent { createdAt }
              ... on ReviewRequestedEvent { createdAt }
              ... on HeadRefForcePushedEvent { createdAt }
              ... on BaseRefChangedEvent { createdAt previousRefName currentRefName }
              ... on ClosedEvent { createdAt }
              ... on ReopenedEvent { createdAt }
              ... on MergedEvent { createdAt }
            }
          }
        }
      }
    }
  }
`;
