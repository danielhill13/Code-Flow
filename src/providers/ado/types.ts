// What Azure DevOps's REST API returns, as far as codeflow reads it (api-version 7.1), and the
// payload codeflow stores for each version of a PR: the PR with its threads, iterations, commits
// and changed files, fetched together.

export type AdoIdentity = {
  id?: string;
  displayName: string;
  /** An email address for people; "Build\\<guid>" and the like for service identities. */
  uniqueName?: string;
  /** A group, such as a team asked to review. */
  isContainer?: boolean;
  descriptor?: string;
};

export type AdoPullRequest = {
  pullRequestId: number;
  status: "active" | "completed" | "abandoned" | "notSet";
  title: string;
  description?: string;
  isDraft?: boolean;
  createdBy: AdoIdentity;
  creationDate: string;
  closedDate?: string;
  closedBy?: AdoIdentity;
  sourceRefName: string;
  targetRefName: string;
  mergeStatus?: string;
  lastMergeCommit?: { commitId: string };
  lastMergeTargetCommit?: { commitId: string };
  lastMergeSourceCommit?: { commitId: string };
  forkSource?: { name?: string };
  labels?: { name: string; active?: boolean }[];
  repository: { id: string; name: string; project: { id?: string; name: string } };
};

export type AdoComment = {
  id: number;
  parentCommentId?: number;
  author: AdoIdentity;
  content?: string;
  publishedDate: string;
  lastUpdatedDate?: string;
  commentType: "text" | "system" | "codeChange" | "unknown";
  isDeleted?: boolean;
};

/** A thread: a conversation, or a system note such as a vote, a status change or new reviewers. */
export type AdoThread = {
  id: number;
  publishedDate: string;
  lastUpdatedDate?: string;
  comments: AdoComment[];
  /** Set on comments anchored to a file and line. */
  threadContext?: { filePath?: string } | null;
  /** System notes say what they are here: CodeReviewThreadType, CodeReviewVoteResult… */
  properties?: Record<string, { $type?: string; $value: string | number }>;
  /** Identities a system note refers to, by the keys its properties use. */
  identities?: Record<string, AdoIdentity>;
  isDeleted?: boolean;
};

/** One push to the PR's branch. The first is the PR's creation; each later one, new commits. */
export type AdoIteration = {
  id: number;
  createdDate: string;
  updatedDate?: string;
  author?: AdoIdentity;
  sourceRefCommit?: { commitId: string };
  commonRefCommit?: { commitId: string };
};

export type AdoCommit = {
  commitId: string;
  author?: { name?: string; email?: string; date: string };
  committer?: { name?: string; email?: string; date: string };
  comment?: string;
  /** Added by codeflow from a local copy (D46): the lines it changed, and its parents. */
  additions?: number;
  deletions?: number;
  parents?: number;
};

/** What codeflow stores for one version of an Azure DevOps PR. */
export type AdoPayload = {
  pr: AdoPullRequest;
  /** The PR's page in Azure DevOps. */
  webUrl: string;
  threads: AdoThread[];
  iterations: AdoIteration[];
  commits: AdoCommit[];
  /** Changed files with their line counts; null when they couldn't be worked out. */
  files: { path: string; additions: number; deletions: number }[] | null;
  /** Why `files` is null, as Azure DevOps or codeflow put it. */
  filesError?: string;
  /** Linked work items' ids, when the org links fixes by work item (D49); absent: not asked. */
  workItems?: string[];
  /** Where the line counts came from: the repo's local copy (D46), or Azure DevOps's API. */
  filesFrom?: "local copy" | "api";
  /** Lists cut short: "commits", "files". */
  truncated: string[];
};

export type AdoRepo = {
  id: string;
  name: string;
  project: string;
  /** organization/project/repo: unique across orgs and providers. */
  fullName: string;
  /** Null for an empty repo. */
  defaultBranch: string | null;
  disabled: boolean;
  fork: boolean;
};
