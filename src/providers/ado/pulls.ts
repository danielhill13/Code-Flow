// Reading Azure DevOps pull requests: pages of a repo's PRs, then everything about one PR that
// its metrics need, fetched together as one stored version (decision D40).
import type { AdoClient } from "./client.ts";
import { iso } from "./normalize.ts";
import type {
  AdoCommit,
  AdoIteration,
  AdoPayload,
  AdoPullRequest,
  AdoRepo,
  AdoThread,
} from "./types.ts";

/** PRs per page of a repo's list. */
export const PAGE_SIZE = 100;
/** Commits read per PR; more than this marks the list as cut short. */
const MAX_COMMITS = 250;
/** Files whose lines are counted per PR; more, and the PR's size is unknown rather than guessed. */
const MAX_FILES = 500;
/** Files per file-diff request. */
const DIFF_BATCH = 50;

const repoPath = (repo: AdoRepo) =>
  `/${encodeURIComponent(repo.project)}/_apis/git/repositories/${repo.id}`;

export type ListRequest = {
  status: "all" | "active" | "completed" | "abandoned";
  skip: number;
  /** With `closedSince`: only PRs that closed at or after it. */
  closedSince?: string;
};

/**
 * One page of a repo's PRs, newest created first (or, with `closedSince`, closed since then).
 * `next` is the skip for the following page, or null at the end.
 */
export async function listPrs(
  client: AdoClient,
  repo: AdoRepo,
  request: ListRequest,
): Promise<{ prs: AdoPullRequest[]; next: number | null }> {
  const { value } = await client.get<{ value: AdoPullRequest[] }>(
    `${repoPath(repo)}/pullrequests`,
    {
      "searchCriteria.status": request.status,
      "searchCriteria.includeLinks": "false",
      ...(request.closedSince && {
        "searchCriteria.minTime": request.closedSince,
        "searchCriteria.queryTimeRangeType": "closed",
      }),
      $top: PAGE_SIZE,
      $skip: request.skip,
    },
  );
  return { prs: value, next: value.length < PAGE_SIZE ? null : request.skip + value.length };
}

/** Everything about one PR that codeflow reads, as one payload to store. */
export async function fetchPr(
  client: AdoClient,
  repo: AdoRepo,
  pr: AdoPullRequest,
): Promise<AdoPayload> {
  const base = `${repoPath(repo)}/pullRequests/${pr.pullRequestId}`;
  // One after another: the client paces every request (D41).
  const threads = await client.get<{ value: AdoThread[] }>(`${base}/threads`);
  const iterations = await client.get<{ value: AdoIteration[] }>(`${base}/iterations`);
  const commits = await client.get<{ value: AdoCommit[] }>(`${base}/commits`, {
    $top: MAX_COMMITS,
  });
  const truncated: string[] = [];
  if (commits.value.length >= MAX_COMMITS) truncated.push("commits");
  const files = await changedFiles(client, repo, base, iterations.value).catch(() => null);
  if (files === null) truncated.push("files");
  return {
    pr,
    webUrl: `${client.base}/${encodeURIComponent(repo.project)}/_git/${encodeURIComponent(repo.name)}/pullrequest/${pr.pullRequestId}`,
    threads: threads.value.filter((thread) => !thread.isDeleted),
    iterations: iterations.value,
    commits: commits.value,
    files,
    truncated,
  };
}

/**
 * The PR's changed files with lines added and deleted: its last push compared with where its
 * branch left the target. Null when there are too many files to count, or the diff can't be read.
 */
async function changedFiles(
  client: AdoClient,
  repo: AdoRepo,
  base: string,
  iterations: readonly AdoIteration[],
): Promise<AdoPayload["files"]> {
  const last = iterations.at(-1);
  const target = last?.sourceRefCommit?.commitId;
  const from = last?.commonRefCommit?.commitId;
  if (!last || !target || !from) return null;
  const changes = await client.get<{
    changeEntries: {
      item: { path: string; isFolder?: boolean };
      changeType: string;
      originalPath?: string;
    }[];
  }>(`${base}/iterations/${last.id}/changes`, { $top: MAX_FILES + 1, $compareTo: 0 });
  const entries = changes.changeEntries.filter((e) => !e.item.isFolder);
  if (entries.length > MAX_FILES) return null;
  const files: NonNullable<AdoPayload["files"]> = [];
  for (let i = 0; i < entries.length; i += DIFF_BATCH) {
    const batch = entries.slice(i, i + DIFF_BATCH);
    const diffs = await client.post<
      {
        path: string;
        lineDiffBlocks?: {
          changeType: string;
          modifiedLinesCount: number;
          originalLinesCount: number;
        }[];
      }[]
    >(`${repoPath(repo)}/filediffs`, {
      baseVersionCommit: from,
      targetVersionCommit: target,
      fileDiffParams: batch.map((e) => ({
        path: e.changeType.includes("delete") ? "" : e.item.path,
        originalPath: e.changeType.includes("add") ? "" : (e.originalPath ?? e.item.path),
      })),
    });
    batch.forEach((entry, j) => {
      const blocks = diffs[j]?.lineDiffBlocks ?? [];
      files.push({
        path: entry.item.path.replace(/^\//, ""),
        additions: blocks.reduce(
          (n, b) => n + (b.changeType === "delete" ? 0 : b.modifiedLinesCount),
          0,
        ),
        deletions: blocks.reduce(
          (n, b) => n + (b.changeType === "add" ? 0 : b.originalLinesCount),
          0,
        ),
      });
    });
  }
  return files;
}

/**
 * The version a payload is: its newest timestamp. A PR nobody touched since the last sync keeps
 * its version, so fetching it again stores nothing new.
 */
export function versionOf(payload: AdoPayload): string {
  const raw = [
    payload.pr.creationDate,
    payload.pr.closedDate,
    ...payload.threads.flatMap((t) => [t.publishedDate, t.lastUpdatedDate]),
    ...payload.threads.flatMap((t) => t.comments.map((c) => c.lastUpdatedDate ?? c.publishedDate)),
    ...payload.iterations.flatMap((i) => [i.createdDate, i.updatedDate]),
  ];
  const times = raw.map(iso).filter((time): time is string => time !== null);
  return times.reduce(
    (max, time) => (time > max ? time : max),
    times[0] ?? payload.pr.creationDate,
  );
}
