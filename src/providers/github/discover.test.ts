import { describe, expect, it } from "vitest";
import { ownerSource, repo } from "../../testing/factories.ts";
import { dropDuplicates, selectRepos } from "./discover.ts";

const names = (repos: { name: string }[]) => repos.map((r) => r.name);

describe("selectRepos", () => {
  it("selects every repo by default, including dot-named ones like .github", () => {
    const { repos, skipped } = selectRepos(ownerSource(), [repo("api"), repo(".github")]);
    expect(names(repos)).toEqual(["api", ".github"]);
    expect(skipped).toEqual([]);
  });

  it("skips archived repos, forks and empty repos", () => {
    const { repos, skipped } = selectRepos(ownerSource(), [
      repo("api"),
      repo("old", { archived: true }),
      repo("vendored", { fork: true }),
      repo("blank", { empty: true }),
    ]);
    expect(names(repos)).toEqual(["api"]);
    expect(skipped).toEqual([
      { repo: "acme/old", reason: "archived" },
      { repo: "acme/vendored", reason: "fork" },
      { repo: "acme/blank", reason: "empty" },
    ]);
  });

  it("keeps archived repos and forks when the source opts in", () => {
    const { repos } = selectRepos(ownerSource({ archived: true, forks: true }), [
      repo("old", { archived: true }),
      repo("vendored", { fork: true }),
    ]);
    expect(names(repos)).toEqual(["old", "vendored"]);
  });

  it("matches patterns on the repo name, ignoring case, with exclude winning", () => {
    const source = ownerSource({ include: ["api-*", "web"], exclude: ["*-legacy"] });
    const { repos, skipped } = selectRepos(source, [
      repo("API-Gateway"),
      repo("api-legacy"),
      repo("Web"),
      repo("docs"),
    ]);
    expect(names(repos)).toEqual(["API-Gateway", "Web"]);
    expect(skipped).toEqual([
      { repo: "acme/api-legacy", reason: "excluded" },
      { repo: "acme/docs", reason: "not included" },
    ]);
  });
});

describe("dropDuplicates", () => {
  it("keeps a repo under the first source that selected it", () => {
    const [first, second] = dropDuplicates([
      { source: ownerSource(), repos: [repo("api"), repo("web")], skipped: [] },
      { source: { kind: "repo", owner: "acme", name: "api" }, repos: [repo("api")], skipped: [] },
    ]);
    expect(names(first?.repos ?? [])).toEqual(["api", "web"]);
    expect(second?.repos).toEqual([]);
    expect(second?.skipped).toEqual([{ repo: "acme/api", reason: "duplicate" }]);
  });
});
