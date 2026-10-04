import { describe, expect, it } from "vitest";
import { at, deriveRules, prFact } from "../testing/factories.ts";
import { branchesSnippet, unmeasuredBranches } from "./branches.ts";

const asOf = new Date("2026-04-15T00:00:00Z");
// The factory's PRs merge on 03-04 into main; rules measure main only.
const into = (base: string, count: number, repo = "acme/api") =>
  Array.from({ length: count }, () => prFact({ repo, baseBranch: base }));

describe("unmeasuredBranches", () => {
  it("flags a repo whose recent work lands on a branch that isn't measured [rule 2]", () => {
    const facts = [
      ...into("develop", 12),
      ...into("main", 2),
      ...into("develop", 30, "acme/web"),
      ...into("main", 40, "acme/web"),
    ];
    expect(unmeasuredBranches(facts, asOf)).toEqual([
      { repo: "acme/api", branch: "develop", into: 12, merged: 14, counted: 2 },
    ]);
  });

  it("ignores a handful of stacked PRs, bot PRs and old history", () => {
    const old = prFact({
      baseBranch: "develop",
      mergedAt: at("01-02 10:00"),
      createdAt: at("01-01 10:00"),
    });
    const bots = Array.from({ length: 12 }, () =>
      prFact({ baseBranch: "develop", author: { login: "dependabot", bot: true } }, deriveRules()),
    );
    expect(unmeasuredBranches([...into("feature/x", 9), old, ...bots], asOf)).toEqual([]);
  });

  it("writes the config that would measure the branch, keeping the repo's own", () => {
    const advice = unmeasuredBranches(into("develop", 12), asOf);
    expect(branchesSnippet(advice, () => ["main"])).toBe("branches:\n  acme/api: [main, develop]");
  });
});
