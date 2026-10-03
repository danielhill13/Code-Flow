import { describe, expect, it } from "vitest";
import { alice, at, bob, carol, deriveRules, prModel, rabbit } from "../testing/factories.ts";
import { derivePr } from "./derive.ts";
import type { PrFact } from "./facts.ts";
import type { PrModel, Review } from "./model.ts";

const review = (
  author: Review["author"],
  time: string,
  state: Review["state"] = "commented",
  body = "",
): Review => ({
  author,
  state,
  at: at(time),
  body,
});

const derive = (overrides: Partial<PrModel> = {}, rules = deriveRules()) =>
  derivePr(prModel(overrides), rules);

/** The phases must always add up to the cycle time: null phases count as zero. */
function expectPhasesToAddUp(fact: PrFact) {
  const sum =
    (fact.codingHours ?? 0) +
    (fact.pickupHours ?? 0) +
    (fact.reviewHours ?? 0) +
    (fact.mergeWaitHours ?? 0);
  expect(sum).toBeCloseTo(fact.cycleHours ?? Number.NaN, 9);
}

describe("derivePr: the timeline", () => {
  it("splits a reviewed, approved PR's cycle time into phases", () => {
    const fact = derive({
      reviews: [review(bob, "03-02 14:00"), review(bob, "03-03 10:00", "approved")],
    });

    expect(fact).toMatchObject({
      startAt: at("03-01 10:00"),
      readyAt: at("03-02 10:00"),
      firstReviewAt: at("03-02 14:00"),
      firstApprovalAt: at("03-03 10:00"),
      reviewEndAt: at("03-03 10:00"),
      cycleHours: 72,
      codingHours: 24,
      pickupHours: 4,
      reviewHours: 20,
      mergeWaitHours: 24,
      timeToApprovalHours: 24,
      reviewed: true,
      approved: true,
      reviewers: ["bob"],
    });
    expectPhasesToAddUp(fact);
  });

  it("counts draft time as coding: pickup starts when the PR became ready", () => {
    const fact = derive({
      draft: false,
      events: [{ type: "ready_for_review", at: at("03-03 10:00") }],
      reviews: [review(bob, "03-03 12:00", "approved")],
    });
    expect(fact).toMatchObject({ readyAt: at("03-03 10:00"), codingHours: 48, pickupHours: 2 });
    expectPhasesToAddUp(fact);
  });

  it("treats a PR that opened ready, then went back to draft, as ready at creation", () => {
    const fact = derive({
      events: [
        { type: "converted_to_draft", at: at("03-02 12:00") },
        { type: "ready_for_review", at: at("03-02 15:00") },
      ],
    });
    expect(fact.readyAt).toBe(at("03-02 10:00"));
  });

  it("makes pickup zero, not negative, when review came during the draft", () => {
    const fact = derive({
      events: [{ type: "ready_for_review", at: at("03-03 10:00") }],
      reviews: [review(bob, "03-02 12:00"), review(bob, "03-03 11:00", "approved")],
    });
    expect(fact.pickupHours).toBe(0);
    expect(fact.reviewHours).toBe(1);
    expectPhasesToAddUp(fact);
  });

  it("starts at creation when the commits are newer than the PR", () => {
    const fact = derive({
      commits: [
        { sha: "c2", authoredAt: at("03-03 09:00"), committedAt: at("03-03 09:00"), message: "x" },
      ],
    });
    expect(fact).toMatchObject({
      startAt: at("03-02 10:00"),
      firstCommitAt: at("03-03 09:00"),
      codingHours: 0,
    });
  });

  it("gives an unreviewed PR no pickup or review phase", () => {
    const fact = derive();
    expect(fact).toMatchObject({
      reviewed: false,
      pickupHours: null,
      reviewHours: null,
      mergeWaitHours: 48,
    });
    expectPhasesToAddUp(fact);
  });

  it("ends review at the last review when nobody approved", () => {
    const fact = derive({
      reviews: [review(bob, "03-02 12:00"), review(carol, "03-03 12:00", "changes_requested")],
    });
    expect(fact).toMatchObject({
      approved: false,
      reviewEndAt: at("03-03 12:00"),
      reviewHours: 24,
      mergeWaitHours: 22,
    });
    expectPhasesToAddUp(fact);
  });

  it("gives an open PR timestamps but no phases", () => {
    const fact = derive({ state: "open", mergedAt: null, closedAt: null, draft: true });
    expect(fact).toMatchObject({
      readyAt: null,
      cycleHours: null,
      codingHours: null,
      mergeWaitHours: null,
    });
  });
});

describe("derivePr: who counts as a reviewer", () => {
  it("ignores the author's own replies, bots, reviews after merge and boilerplate", () => {
    const fact = derive(
      {
        reviews: [
          review(alice, "03-02 11:00"), // replying to a thread creates a review by the author
          review(rabbit, "03-02 10:05"),
          review(carol, "03-02 12:00", "commented", "This repo is configured for manual reviews."),
          review(bob, "03-05 10:00", "approved"), // after merge
        ],
        comments: [
          { author: carol, at: at("03-02 13:00"), body: "Looks useful" },
          { author: alice, at: at("03-02 14:00"), body: "Thanks" },
          { author: rabbit, at: at("03-02 10:06"), body: "Summary by CodeRabbit" },
          { author: bob, at: at("03-05 11:00"), body: "Shipped" },
        ],
      },
      deriveRules({ isIgnoredBody: (body) => /configured for manual reviews/.test(body) }),
    );
    expect(fact).toMatchObject({ reviewed: false, reviews: 0, comments: 1, pickupHours: null });
  });

  it("counts a bot's reviews when config names it a reviewer", () => {
    const fact = derive(
      { reviews: [review(rabbit, "03-02 10:05")] },
      deriveRules({ isBotReviewer: (actor) => actor.login === "coderabbitai" }),
    );
    expect(fact).toMatchObject({
      reviewed: true,
      reviewers: ["coderabbitai"],
      pickupHours: 5 / 60,
    });
  });

  it("counts review submissions, approvals and change requests per PR", () => {
    const fact = derive({
      reviews: [
        review(bob, "03-02 12:00", "changes_requested"),
        review(carol, "03-02 13:00"),
        review(bob, "03-03 12:00", "approved"),
        review(carol, "03-03 13:00", "dismissed"),
      ],
    });
    expect(fact).toMatchObject({
      reviews: 4,
      approvals: 1,
      changesRequested: 1,
      reviewers: ["bob", "carol"],
    });
  });
});

describe("derivePr: size", () => {
  it("measures product code, keeping the other buckets", () => {
    const fact = derive({
      files: [
        { path: "src/a.ts", additions: 10, deletions: 2 },
        { path: "src/b.ts", additions: 3, deletions: 0 },
        { path: "package-lock.json", additions: 500, deletions: 300 },
        { path: "tests/a.test.ts", additions: 40, deletions: 0 },
        { path: "README.md", additions: 5, deletions: 1 },
      ],
    });
    expect(fact).toMatchObject({
      sizeLines: 15,
      addedLines: 13,
      productFiles: 2,
      linesByBucket: { product: 15, lockfile: 800, test: 40, docs: 6, generated: 0, vendored: 0 },
    });
  });

  it("leaves size unknown when the file list was cut short, rather than guessing", () => {
    const fact = derive({
      files: [{ path: "src/a.ts", additions: 1, deletions: 0 }],
      truncated: ["files"],
    });
    expect(fact).toMatchObject({
      sizeLines: null,
      addedLines: null,
      productFiles: null,
      linesByBucket: null,
    });
  });
});

describe("derivePr: rounds", () => {
  it("counts each time new commits arrived after a review", () => {
    const commit = (sha: string, time: string) => ({
      sha,
      authoredAt: at(time),
      committedAt: at(time),
      message: sha,
    });
    const fact = derive({
      commits: [
        commit("c1", "03-01 10:00"),
        commit("c2", "03-02 15:00"),
        commit("c3", "03-02 15:01"),
      ],
      reviews: [
        review(bob, "03-02 12:00", "changes_requested"),
        review(bob, "03-03 09:00"),
        review(bob, "03-03 12:00", "approved"),
      ],
      events: [{ type: "force_pushed", at: at("03-03 10:00") }],
    });
    // c2 and c3 answer the first review together; the force-push answers the second.
    expect(fact.rounds).toBe(2);
  });
});

describe("derivePr: what counts", () => {
  it("counts an ordinary PR into the measured branch", () => {
    expect(derive()).toMatchObject({ counted: true, exclusion: null });
  });

  it("leaves out bot PRs unless config includes them", () => {
    expect(derive({ author: { login: "dependabot", bot: true } })).toMatchObject({
      counted: false,
      exclusion: "bot",
    });
    expect(
      derive({ author: { login: "dependabot", bot: true } }, deriveRules({ includeBotPrs: true }))
        .counted,
    ).toBe(true);
  });

  it("leaves out PRs into other branches, such as stacked feature branches", () => {
    expect(derive({ baseBranch: "feature/big-thing" })).toMatchObject({
      counted: false,
      exclusion: "base",
    });
  });

  it("leaves out promotions from the repo's own long-lived branches, but not from forks", () => {
    expect(derive({ headBranch: "develop" })).toMatchObject({
      counted: false,
      exclusion: "promotion",
    });
    expect(derive({ headBranch: "main", fromFork: true })).toMatchObject({ counted: true });
  });

  it("notes who merged it", () => {
    expect(derive({ mergedBy: alice }).selfMerged).toBe(true);
    expect(derive().selfMerged).toBe(false);
  });

  it("calls a deleted account ghost", () => {
    expect(derive({ author: null }).author).toBe("ghost");
  });
});
