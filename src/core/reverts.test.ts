import { describe, expect, it } from "vitest";
import { at, deriveRules, prModel } from "../testing/factories.ts";
import { derivePr } from "./derive.ts";
import type { PrFact } from "./facts.ts";
import type { PrModel } from "./model.ts";
import { linkReverts, revertClues } from "./reverts.ts";

/** PRs as a repo: #10 merged on 03-04 with merge commit aaaa…, plus whatever a test adds. */
function link(...others: Partial<PrModel>[]) {
  const prs = [
    prModel({
      id: "PR_10",
      number: 10,
      mergeCommitSha: "aaaa1111bbbb2222",
      commits: [commit("cccc3333dddd4444", "x")],
    }),
    ...others.map((overrides, i) =>
      prModel({ id: `PR_${11 + i}`, number: 11 + i, mergedAt: at("03-06 10:00"), ...overrides }),
    ),
  ];
  const facts = new Map<string, PrFact>(prs.map((pr) => [pr.id, derivePr(pr, deriveRules())]));
  linkReverts(prs.map(revertClues), facts);
  return (number: number) => [...facts.values()].find((fact) => fact.number === number);
}

const commit = (sha: string, message: string) => ({
  sha,
  authoredAt: at("03-05 10:00"),
  committedAt: at("03-05 10:00"),
  message,
});

describe("linkReverts", () => {
  it("links a revert to the PR its body names, as GitHub's Revert button writes it", () => {
    const fact = link({ title: 'Revert "Add a thing"', body: "Reverts acme/api#10" });
    expect(fact(11)?.reverts).toEqual([10]);
    expect(fact(10)).toMatchObject({ revertedBy: 11, revertedAt: at("03-06 10:00") });
  });

  it("links a revert by the merge commit it reverts, even from an abbreviated sha", () => {
    const fact = link({
      commits: [commit("eeee", 'Revert "Add a thing"\n\nThis reverts commit aaaa1111.')],
    });
    expect(fact(10)?.revertedBy).toBe(11);
  });

  it("links a revert by one of the reverted PR's own commits", () => {
    const fact = link({ commits: [commit("eeee", "This reverts commit cccc3333dddd4444.")] });
    expect(fact(10)?.revertedBy).toBe(11);
  });

  it("does not count a commit that reverts another commit of the same PR", () => {
    const fact = link({
      commits: [commit("ffff5555", "Try a thing"), commit("eeee", "This reverts commit ffff5555.")],
    });
    expect(fact(11)?.reverts).toEqual([]);
    expect(fact(10)?.revertedBy).toBeNull();
  });

  it("does not trust a revert title alone", () => {
    expect(link({ title: "Revert: re-add post response vars" })(11)?.reverts).toEqual([]);
  });

  it("ignores reverts that never merged, and PRs that never merged", () => {
    const openRevert = link({ state: "open", mergedAt: null, body: "Reverts acme/api#10" });
    expect(openRevert(10)?.revertedBy).toBeNull();

    const unmergedTarget = link(
      { state: "closed", mergedAt: null, mergeCommitSha: null, commits: [commit("9999", "x")] },
      { body: "Reverts acme/api#11", commits: [commit("8888", "This reverts commit 9999.")] },
    );
    expect(unmergedTarget(12)?.reverts).toEqual([]);
  });

  it("ignores a body naming a PR in another repo", () => {
    expect(link({ body: "Reverts other/repo#10" })(10)?.revertedBy).toBeNull();
  });

  it("keeps the earliest of two reverts", () => {
    const fact = link(
      { body: "Reverts acme/api#10", mergedAt: at("03-09 10:00") },
      { body: "Reverts acme/api#10", mergedAt: at("03-07 10:00") },
    );
    expect(fact(10)).toMatchObject({ revertedBy: 12, revertedAt: at("03-07 10:00") });
  });
});
