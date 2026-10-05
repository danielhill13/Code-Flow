// A repo's local copy (decision D46): a bare git clone codeflow keeps beside the org's database,
// for what the hosts' APIs give poorly or not at all: Azure DevOps PR sizes and lines per commit,
// and line-level churn on either host. Opt-in per repo (`local_copies`). Only reads: it fetches,
// and asks git about commits and lines; nothing is ever pushed.
//
// The token reaches git through its environment (GIT_CONFIG_*), never a file or the command line,
// so it isn't stored with the copy or visible in the process list.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { CodeflowError } from "../../errors.ts";

const run = promisify(execFile);

/** A changed file with its lines, as `git diff --numstat` counts them (binary files: 0). */
export type GitFile = { path: string; additions: number; deletions: number };

export class GitError extends CodeflowError {}

/** How codeflow talks to git: the binary, and an Authorization header for the host, if any. */
export type GitAccess = { authorization?: string };

/** Runs git; its error says what git said, without the token. */
export async function git(
  args: readonly string[],
  options: { cwd?: string; access?: GitAccess; timeoutMs?: number } = {},
): Promise<string> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    // Never use a credential helper's saved login: only the token codeflow was given.
    GCM_INTERACTIVE: "never",
  };
  if (options.access?.authorization) {
    env.GIT_CONFIG_COUNT = "2";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: ${options.access.authorization}`;
    env.GIT_CONFIG_KEY_1 = "credential.helper";
    env.GIT_CONFIG_VALUE_1 = "";
  }
  try {
    const { stdout } = await run("git", [...args], {
      cwd: options.cwd,
      env,
      maxBuffer: 512 * 1024 * 1024,
      timeout: options.timeoutMs ?? 0,
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") {
      throw new GitError("git isn't installed, or isn't on the PATH: local copies need it.");
    }
    const said = (e.stderr ?? e.message).trim().split("\n").slice(-2).join(" ");
    throw new GitError(
      `git ${args[0]}: ${said.replace(/Authorization: \S+ \S+/g, "Authorization: …")}`,
    );
  }
}

/** The installed git's version, or null when there is none. */
export async function gitVersion(): Promise<string | null> {
  try {
    return (await git(["--version"])).trim();
  } catch {
    return null;
  }
}

/** Where a repo's copy lives: one bare clone per repo, by its store id. */
export function copyPath(root: string, repoId: string): string {
  return join(root, `${repoId.replace(/[^A-Za-z0-9._-]+/g, "_")}.git`);
}

/**
 * Makes the copy current: created the first time, then fetched (only what's new). Every branch,
 * and on GitHub every PR's head, so commits of PRs whose branches are gone are still there.
 */
export async function updateCopy(options: {
  dir: string;
  url: string;
  access: GitAccess;
  github: boolean;
}): Promise<void> {
  const { dir } = options;
  if (!existsSync(join(dir, "HEAD"))) {
    await mkdir(dir, { recursive: true });
    await git(["init", "--bare", "--quiet", dir]);
    await git(["remote", "add", "origin", options.url], { cwd: dir });
  } else {
    await git(["remote", "set-url", "origin", options.url], { cwd: dir });
  }
  const refspecs = ["+refs/heads/*:refs/heads/*"];
  if (options.github) refspecs.push("+refs/pull/*/head:refs/pull/*/head");
  await git(["fetch", "--quiet", "--prune", "--no-tags", "origin", ...refspecs], {
    cwd: dir,
    access: options.access,
  });
}

/** Removes a repo's copy. */
export async function removeCopy(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** A copy's size on disk, and when it was last fetched; null when there is none. */
export async function copyStatus(
  dir: string,
): Promise<{ bytes: number; fetchedAt: string | null } | null> {
  if (!existsSync(join(dir, "HEAD"))) return null;
  const fetched = join(dir, "FETCH_HEAD");
  return {
    bytes: await sizeOf(dir),
    fetchedAt: existsSync(fetched) ? (await stat(fetched)).mtime.toISOString() : null,
  };
}

async function sizeOf(path: string): Promise<number> {
  const info = await stat(path);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(path)) total += await sizeOf(join(path, entry));
  return total;
}

/** Which of these commits the copy holds. */
export async function present(dir: string, shas: readonly string[]): Promise<Set<string>> {
  if (shas.length === 0) return new Set();
  const out = await gitInput(
    dir,
    ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    shas.join("\n"),
  );
  const found = new Set<string>();
  for (const line of out.split("\n")) {
    const [sha, type] = line.split(" ");
    if (sha && type === "commit") found.add(sha);
  }
  return found;
}

async function gitInput(dir: string, args: string[], input: string): Promise<string> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: dir, windowsHide: true });
    let out = "";
    let errText = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      errText += d;
    });
    child.on("error", (err) => reject(new GitError(`git: ${err.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new GitError(`git ${args[0]}: ${errText.trim()}`)),
    );
    child.stdin.end(`${input}\n`);
  });
}

/** Lines changed from one commit to another, per file; renames count only their edits. */
export async function numstat(dir: string, from: string, to: string): Promise<GitFile[]> {
  return parseNumstat(await git(["diff", "--numstat", "-z", "-M", from, to], { cwd: dir }));
}

/** `git diff --numstat -z` output: "a\td\tpath\0", or "a\td\t\0old\0new\0" for a rename. */
export function parseNumstat(out: string): GitFile[] {
  const parts = out.split("\0");
  const files: GitFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i];
    if (!head) continue;
    const [a = "", d = "", path = ""] = head.split("\t");
    const lines = (n: string) => (n === "-" ? 0 : Number(n)); // "-": a binary file
    if (path === "") {
      // A rename: the old path, then the new one, follow.
      const renamed = parts[i + 2] ?? "";
      files.push({ path: renamed, additions: lines(a), deletions: lines(d) });
      i += 2;
    } else {
      files.push({ path, additions: lines(a), deletions: lines(d) });
    }
  }
  return files;
}

/** A commit's parents. */
export async function parentsOf(dir: string, sha: string): Promise<string[]> {
  const out = await git(["rev-list", "--parents", "-n", "1", sha], { cwd: dir });
  return out.trim().split(/\s+/).slice(1);
}

/** The first `n` commits along the first-parent line from `sha`, newest first, with subjects. */
export async function firstParentLine(
  dir: string,
  sha: string,
  n: number,
): Promise<{ sha: string; subject: string }[]> {
  const out = await git(["log", "--first-parent", `-n${n}`, "--format=%H%x00%s", sha], {
    cwd: dir,
  });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash = "", subject = ""] = line.split("\0");
      return { sha: hash, subject };
    });
}

/**
 * What a merged PR changed in its target branch: where it started (`base`) and the commits it
 * landed as (`commits`). A merge commit or a squash lands as one commit over its first parent; a
 * rebase lands as the PR's own commits, in a row, which their subjects show.
 */
export async function landed(
  dir: string,
  mergeCommit: string,
  prCommitSubjects: readonly string[],
): Promise<{ base: string; commits: Set<string> } | null> {
  const parents = await parentsOf(dir, mergeCommit);
  const [first] = parents;
  if (!first) return null; // a root commit: nothing to compare with
  const n = prCommitSubjects.length;
  if (parents.length === 1 && n > 1) {
    const line = await firstParentLine(dir, mergeCommit, n + 1);
    const subjects = new Set(prCommitSubjects.map((s) => s.split("\n")[0]?.trim()));
    const rebased = line.slice(0, n);
    if (rebased.length === n && rebased.every((c) => subjects.has(c.subject.trim()))) {
      const base = line[n]?.sha;
      if (!base) return null;
      return { base, commits: new Set(rebased.map((c) => c.sha)) };
    }
  }
  return { base: first, commits: new Set([mergeCommit]) };
}

/** Lines each commit changed, for the commits the copy holds; with how many parents each has. */
export async function commitLines(
  dir: string,
  shas: readonly string[],
): Promise<Map<string, { additions: number; deletions: number; parents: number }>> {
  const held = [...(await present(dir, shas))];
  const result = new Map<string, { additions: number; deletions: number; parents: number }>();
  for (const sha of held) {
    const parents = await parentsOf(dir, sha);
    // A merge's own lines are its first parent's diff: what it brought in from the other side.
    const from = parents[0] ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // the empty tree
    const files = await numstat(dir, from, sha);
    result.set(sha, {
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      parents: parents.length,
    });
  }
  return result;
}

/**
 * Of the lines a merged PR added, how many were rewritten within `days` of merging (decision
 * D46): its added lines, file by file, that `git blame` no longer gives to the commits it landed
 * as, on its target branch as it stood `days` later. Null when the copy can't say.
 */
export async function rewrittenLines(
  dir: string,
  options: {
    mergeCommit: string;
    prCommitSubjects: readonly string[];
    branch: string;
    mergedAt: string;
    days: number;
    /** Which files count: product code only, as size counts it. */
    counts: (path: string) => boolean;
  },
): Promise<{ added: number; rewritten: number } | null> {
  const held = await present(dir, [options.mergeCommit]);
  if (!held.has(options.mergeCommit)) return null;
  const change = await landed(dir, options.mergeCommit, options.prCommitSubjects);
  if (!change) return null;
  const until = new Date(Date.parse(options.mergedAt) + options.days * 86_400_000).toISOString();
  const later = (
    await git(
      ["rev-list", "-1", "--first-parent", `--before=${until}`, `refs/heads/${options.branch}`],
      {
        cwd: dir,
      },
    ).catch(() => "")
  ).trim();
  if (!later) return null;
  // The branch then must hold the PR: otherwise it was never on this line of history.
  const contains = await git(["merge-base", "--is-ancestor", options.mergeCommit, later], {
    cwd: dir,
  }).then(
    () => true,
    () => false,
  );
  if (!contains) return null;

  const files = (await numstat(dir, change.base, options.mergeCommit)).filter(
    (f) => f.additions > 0 && options.counts(f.path),
  );
  let added = 0;
  let survived = 0;
  for (const file of files) {
    added += file.additions;
    const blame = await git(["blame", "--first-parent", "--porcelain", later, "--", file.path], {
      cwd: dir,
    }).catch(() => null); // gone by then: every line it added was rewritten
    if (blame === null) continue;
    for (const line of blame.split("\n")) {
      const header = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
      if (header?.[1] && change.commits.has(header[1])) survived += 1;
    }
  }
  return { added, rewritten: Math.max(0, added - Math.min(survived, added)) };
}
