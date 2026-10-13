import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitRepo } from "../../testing/git-repo.ts";
import {
  branchRef,
  commitLines,
  copyStatus,
  fetchRefspecs,
  git,
  landed,
  numstat,
  parseNumstat,
  present,
  remoteBranches,
  rewrittenLines,
  updateCopy,
} from "./git.ts";

const product = (path: string) => path.startsWith("src/");

/** main with a file; a PR branch adding to it, merged by a merge commit; later main work. */
function mergedRepo() {
  const repo = new GitRepo();
  repo.commit("2026-03-01T10:00:00Z", "Start", { "src/a.ts": GitRepo.lines(3, "base") });
  repo.run("checkout", "--quiet", "-b", "feat");
  const one = repo.commit("2026-03-02T10:00:00Z", "Add the thing", {
    "src/a.ts": GitRepo.lines(3, "base") + GitRepo.lines(10, "feat"),
  });
  const two = repo.commit("2026-03-03T10:00:00Z", "Test the thing", {
    "test/a.test.ts": GitRepo.lines(5, "test"),
  });
  repo.run("checkout", "--quiet", "main");
  repo.at("2026-03-05T10:00:00Z", "merge", "--quiet", "--no-ff", "-m", "Merge feat", "feat");
  const merge = repo.run("rev-parse", "HEAD");
  // Eight days later, four of the PR's ten lines are rewritten.
  const rewritten = `${GitRepo.lines(3, "base")}${GitRepo.lines(4, "again")}${GitRepo.lines(10, "feat").split("\n").slice(4).join("\n")}`;
  repo.commit("2026-03-13T10:00:00Z", "Rework the thing", { "src/a.ts": rewritten });
  return { repo, merge, prCommits: [one, two] };
}

describe("a local copy [rule 16]", () => {
  it("is cloned, then fetched, from the host's address, and holds the PR's commits", async () => {
    const { repo, merge, prCommits } = mergedRepo();
    const dir = join(mkdtempSync(join(tmpdir(), "codeflow-copy-")), "r.git");
    await updateCopy({ dir, url: repo.dir, access: {}, github: false });
    await updateCopy({ dir, url: repo.dir, access: {}, github: false });
    expect(await present(dir, [merge, ...prCommits, "0".repeat(40)])).toEqual(
      new Set([merge, ...prCommits]),
    );
    expect((await copyStatus(dir))?.bytes).toBeGreaterThan(0);
  });

  it("sizes a merge-commit PR from its first parent, renames counting only their edits", async () => {
    const { repo, merge } = mergedRepo();
    const change = await landed(repo.dir, merge, ["Add the thing", "Test the thing"]);
    expect(change?.commits).toEqual(new Set([merge]));
    const files = await numstat(repo.dir, change?.base ?? "", merge);
    expect(files).toEqual([
      { path: "src/a.ts", additions: 10, deletions: 0 },
      { path: "test/a.test.ts", additions: 5, deletions: 0 },
    ]);
    expect(parseNumstat("3\t1\t\0old.ts\0new.ts\0-\t-\tlogo.png\0")).toEqual([
      { path: "new.ts", additions: 3, deletions: 1 },
      { path: "logo.png", additions: 0, deletions: 0 },
    ]);
  });

  it("knows a squash, and a rebase, by what landed on the branch", async () => {
    const repo = new GitRepo();
    repo.commit("2026-03-01T10:00:00Z", "Start", { "src/a.ts": "a\n" });
    repo.run("checkout", "--quiet", "-b", "pr");
    repo.commit("2026-03-02T10:00:00Z", "First step", { "src/b.ts": GitRepo.lines(4, "b") });
    repo.commit("2026-03-02T11:00:00Z", "Second step", { "src/c.ts": GitRepo.lines(6, "c") });
    repo.run("checkout", "--quiet", "main");
    const before = repo.run("rev-parse", "HEAD");

    // Rebased: the PR's two commits, replayed on main.
    repo.at("2026-03-03T10:00:00Z", "cherry-pick", "pr~1", "pr");
    const rebased = repo.run("rev-parse", "HEAD");
    const asRebase = await landed(repo.dir, rebased, ["First step", "Second step"]);
    expect(asRebase?.base).toBe(before);
    expect(asRebase?.commits.size).toBe(2);
    expect(
      (await numstat(repo.dir, asRebase?.base ?? "", rebased)).reduce((n, f) => n + f.additions, 0),
    ).toBe(10);

    // Squashed: one commit, its own message.
    repo.run("reset", "--quiet", "--hard", before);
    repo.at("2026-03-03T10:00:00Z", "merge", "--quiet", "--squash", "pr");
    const squash = repo.commit("2026-03-03T10:00:00Z", "Steps (#7)", {});
    const asSquash = await landed(repo.dir, squash, ["First step", "Second step"]);
    expect(asSquash).toEqual({ base: before, commits: new Set([squash]) });
  });

  it("counts the lines each commit changed, and its parents", async () => {
    const { repo, merge, prCommits } = mergedRepo();
    const lines = await commitLines(repo.dir, [...prCommits, merge, "f".repeat(40)]);
    expect(lines.get(prCommits[0] ?? "")).toEqual({ additions: 10, deletions: 0, parents: 1 });
    expect(lines.get(prCommits[1] ?? "")).toEqual({ additions: 5, deletions: 0, parents: 1 });
    expect(lines.get(merge)?.parents).toBe(2);
    expect(lines.has("f".repeat(40))).toBe(false);
  });

  it("finds how many of a PR's added product lines were rewritten within the window", async () => {
    const { repo, merge } = mergedRepo();
    const base = {
      mergeCommit: merge,
      prCommitSubjects: ["Add the thing", "Test the thing"],
      branch: "main",
      mergedAt: "2026-03-05T10:00:00Z",
      counts: product,
    };
    expect(await rewrittenLines(repo.dir, { ...base, days: 30 })).toEqual({
      added: 10,
      rewritten: 4,
    });
    // Within a week, nothing had been rewritten yet.
    expect(await rewrittenLines(repo.dir, { ...base, days: 7 })).toEqual({
      added: 10,
      rewritten: 0,
    });
    // A commit the copy doesn't hold: it can't say.
    expect(
      await rewrittenLines(repo.dir, { ...base, mergeCommit: "a".repeat(40), days: 30 }),
    ).toBeNull();
  });
});

describe("a copy of a repo with branch names no file system can hold [rule 16]", () => {
  const long = `story/develop/${"x".repeat(300)}`;
  const copyDir = () => join(mkdtempSync(join(tmpdir(), "codeflow-awkward-")), "r.git");
  const refsOf = async (dir: string) =>
    (await git(["for-each-ref", "--format=%(refname)"], { cwd: dir })).split("\n").filter(Boolean);

  /** A commit that only a branch of the given name has, as a PR branch's work can be. */
  function onlyOn(repo: GitRepo, name: string, day: string): string {
    repo.run("checkout", "--quiet", "-b", "scratch");
    const sha = repo.commit(`2026-03-${day}T10:00:00Z`, `Only on ${name.slice(0, 20)}`, {
      [`src/${day}.ts`]: `${day}\n`,
    });
    repo.run("checkout", "--quiet", "main");
    repo.run("branch", "-D", "scratch");
    repo.packedBranch(name, sha);
    return sha;
  }

  function source() {
    const repo = new GitRepo();
    repo.commit("2026-03-01T10:00:00Z", "Start", { "src/a.ts": "a\n" });
    repo.run("checkout", "--quiet", "-b", "feature/ok");
    const ok = repo.commit("2026-03-02T10:00:00Z", "On a normal branch", { "src/ok.ts": "ok\n" });
    repo.run("checkout", "--quiet", "main");
    return { repo, ok, onlyLong: onlyOn(repo, long, "03") };
  }

  it("is updated, every branch in it by a short name, whatever the branch is called", async () => {
    const { repo, ok, onlyLong } = source();
    expect(await remoteBranches(repo.dir, {})).toContain(long);
    const dir = copyDir();
    expect(await updateCopy({ dir, url: repo.dir, access: {}, github: false })).toEqual({
      branches: 3,
    });
    const refs = await refsOf(dir);
    expect(refs).toHaveLength(3);
    expect(refs.every((ref) => ref.startsWith("refs/codeflow/h/") && ref.length < 50)).toBe(true);
    expect(await present(dir, [ok, onlyLong])).toEqual(new Set([ok, onlyLong]));
    // The commit only the long branch has is kept by that branch's ref.
    const holders = await git(["for-each-ref", "--contains", onlyLong, "--format=%(refname)"], {
      cwd: dir,
    });
    expect(holders.trim()).toBe(branchRef(long));
  });

  it("tells the server what it has on the next sync, so only what is new comes down", async () => {
    const { repo } = source();
    const dir = copyDir();
    await updateCopy({ dir, url: repo.dir, access: {}, github: false });
    const fresh = repo.commit("2026-03-09T10:00:00Z", "New upstream", { "src/new.ts": "n\n" });
    const specs = (await remoteBranches(repo.dir, {})).map(
      (n) => `+refs/heads/${n}:${branchRef(n)}`,
    );
    const traced = spawnSync("git", ["fetch", "--no-tags", "--stdin", repo.dir], {
      cwd: dir,
      input: `${specs.join("\n")}\n`,
      encoding: "utf8",
      env: { ...process.env, GIT_TRACE_PACKET: "1" },
    });
    expect(traced.status).toBe(0);
    // A copy with no refs sends none, and is sent its whole history again.
    expect((traced.stderr.match(/fetch> have /g) ?? []).length).toBeGreaterThan(0);
    expect(await present(dir, [fresh])).toEqual(new Set([fresh]));
  });

  it("keeps two branches that differ only in case, and one inside another's name", async () => {
    const repo = new GitRepo();
    repo.commit("2026-03-01T10:00:00Z", "Start", { "src/a.ts": "a\n" });
    const upper = onlyOn(repo, "Feature/x", "04");
    const lower = onlyOn(repo, "feature/x", "05");
    const dir = copyDir();
    await updateCopy({ dir, url: repo.dir, access: {}, github: false });
    expect(await refsOf(dir)).toHaveLength(3);
    expect(await present(dir, [upper, lower])).toEqual(new Set([upper, lower]));
  });

  it("brings a copy made before up to date, and tidies what it kept", async () => {
    const { repo, ok } = (() => {
      const r = new GitRepo();
      r.commit("2026-03-01T10:00:00Z", "Start", { "src/a.ts": "a\n" });
      r.run("checkout", "--quiet", "-b", "feature/ok");
      const sha = r.commit("2026-03-02T10:00:00Z", "On a normal branch", { "src/ok.ts": "ok\n" });
      r.run("checkout", "--quiet", "main");
      return { repo: r, ok: sha };
    })();
    // As an earlier codeflow made it: a remote, and every branch by its own name.
    const dir = copyDir();
    await git(["init", "--bare", "--quiet", dir]);
    await git(["remote", "add", "origin", repo.dir], { cwd: dir });
    await git(["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/*:refs/heads/*"], {
      cwd: dir,
    });
    expect((await refsOf(dir)).some((ref) => ref.startsWith("refs/heads/"))).toBe(true);

    await updateCopy({ dir, url: repo.dir, access: {}, github: false });
    const refs = await refsOf(dir);
    expect(refs.filter((ref) => !ref.startsWith("refs/codeflow/h/"))).toEqual([]);
    expect(refs).toHaveLength(2);
    expect(await present(dir, [ok])).toEqual(new Set([ok]));
    // No remote is left to fetch from, and a branch is still found by the name it has upstream.
    await expect(git(["config", "--get", "remote.origin.url"], { cwd: dir })).rejects.toThrow();
    const mergedAt = "2026-03-05T10:00:00Z";
    expect(
      await rewrittenLines(dir, {
        mergeCommit: ok,
        prCommitSubjects: ["On a normal branch"],
        branch: "main",
        mergedAt,
        days: 30,
        counts: () => true,
      }),
    ).not.toBeUndefined();
  });

  it("drops a branch the remote deleted, and has no trouble with a repo with no branches", async () => {
    const { repo } = source();
    repo.run("branch", "short-lived");
    const dir = copyDir();
    await updateCopy({ dir, url: repo.dir, access: {}, github: false });
    expect(await refsOf(dir)).toHaveLength(4);
    repo.run("branch", "-D", "short-lived");
    expect((await updateCopy({ dir, url: repo.dir, access: {}, github: false })).branches).toBe(3);
    expect(await refsOf(dir)).toHaveLength(3);

    const empty = new GitRepo();
    expect(await updateCopy({ dir: copyDir(), url: empty.dir, access: {}, github: true })).toEqual({
      branches: 0,
    });
  });

  it("fetches any number of refspecs, from stdin or, for an older git, in batches", async () => {
    const { repo } = source();
    const specs = Array.from(
      { length: 400 },
      (_, i) => `+refs/heads/main:refs/codeflow/t/${i}${"y".repeat(80)}`,
    );
    for (const useStdin of [true, false]) {
      const dir = copyDir();
      await git(["init", "--bare", "--quiet", dir]);
      await fetchRefspecs(dir, repo.dir, specs, {}, useStdin);
      expect(await refsOf(dir)).toHaveLength(400);
    }
  });

  it("says plainly when the remote can't be reached, without a branch name in the way", async () => {
    const error = await updateCopy({
      dir: copyDir(),
      url: join(tmpdir(), "codeflow-no-such-repo"),
      access: {},
      github: false,
    }).catch((err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^git ls-remote: /);
    expect((error as Error).message.length).toBeLessThan(400);
  });
});
