import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitRepo } from "../../testing/git-repo.ts";
import {
  commitLines,
  copyStatus,
  landed,
  numstat,
  parseNumstat,
  present,
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
