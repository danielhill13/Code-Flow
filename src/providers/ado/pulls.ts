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

/** A PR's comment threads: votes, reviewer changes and conversations. One request. */
export async function prThreads(
  client: AdoClient,
  repo: AdoRepo,
  pr: AdoPullRequest,
): Promise<{ value: AdoThread[] }> {
  return client.get<{ value: AdoThread[] }>(
    `${repoPath(repo)}/pullRequests/${pr.pullRequestId}/threads`,
  );
}

/**
 * What can change on an open PR, read from its list entry and its threads: a push (the source
 * commit), a vote, a comment or reviewer change (threads), its title, labels, draft or status.
 * Equal for two reads, the PR hasn't moved, and the rest of it needn't be read again.
 */
export function openSignature(pr: AdoPullRequest, threads: readonly AdoThread[]): string {
  return JSON.stringify([
    pr.status,
    pr.isDraft ?? false,
    pr.title,
    pr.lastMergeSourceCommit?.commitId ?? null,
    (pr.labels ?? []).map((l) => `${l.name}:${l.active !== false}`).sort(),
    threads
      .filter((t) => !t.isDeleted)
      .map((t) => [t.id, t.lastUpdatedDate ?? t.publishedDate, t.comments.length])
      .sort(),
  ]);
}

/** Everything about one PR that codeflow reads, as one payload to store. */
export async function fetchPr(
  client: AdoClient,
  repo: AdoRepo,
  pr: AdoPullRequest,
  /** The PR's threads, when the caller has just read them. */
  read?: AdoThread[],
): Promise<AdoPayload> {
  const base = `${repoPath(repo)}/pullRequests/${pr.pullRequestId}`;
  // One after another: the client paces every request (D41).
  const threads = read ? { value: read } : await prThreads(client, repo, pr);
  const iterations = await client.get<{ value: AdoIteration[] }>(`${base}/iterations`);
  const commits = await client.get<{ value: AdoCommit[] }>(`${base}/commits`, {
    $top: MAX_COMMITS,
  });
  const truncated: string[] = [];
  if (commits.value.length >= MAX_COMMITS) truncated.push("commits");
  const sized = await changedFiles(client, repo, base, iterations.value).catch(
    (err: unknown): Sized => ({ error: err instanceof Error ? err.message : String(err) }),
  );
  const files = "files" in sized ? sized.files : null;
  if (files === null) truncated.push("files");
  return {
    pr,
    webUrl: `${client.base}/${encodeURIComponent(repo.project)}/_git/${encodeURIComponent(repo.name)}/pullrequest/${pr.pullRequestId}`,
    threads: threads.value.filter((thread) => !thread.isDeleted),
    iterations: iterations.value,
    commits: commits.value,
    files,
    ...("error" in sized && { filesError: sized.error }),
    truncated,
  };
}

/** A PR's changed files with their lines, or why they couldn't be read. */
type Sized = { files: NonNullable<AdoPayload["files"]> } | { error: string };

/**
 * The PR's changed files with lines added and deleted: its last push compared with where its
 * branch left the target, as Azure DevOps's own "Files" tab compares them. Or why not: too many
 * files to count, or a diff Azure DevOps wouldn't give.
 */
export async function changedFiles(
  client: AdoClient,
  repo: AdoRepo,
  base: string,
  iterations: readonly AdoIteration[],
): Promise<Sized> {
  const last = iterations.at(-1);
  const target = last?.sourceRefCommit?.commitId;
  const from = last?.commonRefCommit?.commitId;
  if (!last) return { error: "the PR has no pushes (iterations)" };
  if (!target || !from) {
    return { error: `its last push (iteration ${last.id}) names no source or common commit` };
  }
  const changes = await client.get<{
    changeEntries: {
      item: { path: string; isFolder?: boolean };
      changeType: string | number;
      originalPath?: string;
    }[];
  }>(`${base}/iterations/${last.id}/changes`, { $top: MAX_FILES + 1, $compareTo: 0 });
  const entries = (changes.changeEntries ?? []).filter((e) => !e.item.isFolder);
  if (entries.length > MAX_FILES) return { error: `more than ${MAX_FILES} files changed` };
  const files: NonNullable<AdoPayload["files"]> = [];
  for (let i = 0; i < entries.length; i += DIFF_BATCH) {
    const batch = entries.slice(i, i + DIFF_BATCH);
    const answer = await client.post<FileDiff[] | { value?: FileDiff[] }>(
      `${repoPath(repo)}/filediffs`,
      {
        baseVersionCommit: from,
        targetVersionCommit: target,
        fileDiffParams: batch.map((e) => ({
          path: changed(e.changeType, "delete") ? "" : e.item.path,
          originalPath: changed(e.changeType, "add") ? "" : (e.originalPath ?? e.item.path),
        })),
      },
    );
    // Azure DevOps wraps a list as { count, value }; a bare list is read too.
    const diffs = Array.isArray(answer) ? answer : (answer.value ?? []);
    for (const [j, entry] of batch.entries()) {
      const path = entry.item.path;
      // By path where the answer gives one, else by position, as the request listed them.
      const diff =
        diffs.find((d) => d.path === path || (d.path === "" && d.originalPath === path)) ??
        diffs[j];
      // A file missing from the answer has an unknown size, and so has the PR: never zero.
      if (!diff) {
        return { error: `Azure DevOps gave ${diffs.length} diffs for ${batch.length} files` };
      }
      // A file with no line blocks (binary, or renamed unchanged) changed no lines, as GitHub
      // counts it too.
      let additions = 0;
      let deletions = 0;
      for (const block of diff.lineDiffBlocks ?? []) {
        const kind = blockKind(block.changeType);
        if (kind === "add" || kind === "edit") additions += block.modifiedLinesCount ?? 0;
        if (kind === "delete" || kind === "edit") deletions += block.originalLinesCount ?? 0;
      }
      files.push({ path: path.replace(/^\//, ""), additions, deletions });
    }
  }
  return { files };
}

type FileDiff = {
  path: string;
  originalPath?: string;
  lineDiffBlocks?: {
    changeType: string | number;
    modifiedLinesCount?: number;
    originalLinesCount?: number;
  }[];
};

/** Whether a change type (a name such as "rename, edit", or flags) includes `kind`. */
function changed(type: string | number, kind: "add" | "delete"): boolean {
  if (typeof type === "number") return (type & (kind === "add" ? 1 : 16)) !== 0;
  return type
    .toLowerCase()
    .split(/[\s,]+/)
    .includes(kind);
}

/** A line block's kind, whether Azure DevOps names it or numbers it (none, add, delete, edit). */
function blockKind(type: string | number): "none" | "add" | "delete" | "edit" {
  if (typeof type === "number") return (["none", "add", "delete", "edit"] as const)[type] ?? "none";
  const name = type.toLowerCase();
  return name === "add" || name === "delete" || name === "edit" ? name : "none";
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
