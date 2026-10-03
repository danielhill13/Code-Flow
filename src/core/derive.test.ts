import { describe, expect, it } from "vitest";
import { alice, at, bob, carol, deriveRules, prModel, rabbit } from "../testing/factories.ts";
import { derivePr } from "./derive.ts";
import type { PrFact } from "./facts.ts";
import type { PrModel, Review } from "./model.ts";
import type { PrOutcome } from "./rules.ts";

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

/** What rules say about a PR, with an id for each thing they say. */
const ruled = (outcome: Partial<PrOutcome>): PrOutcome => ({
  count: null,
  countRule: null,
  internal: null,
  ignore: [],
  applied: [outcome.countRule ?? "a-rule"],
  ...outcome,
});

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
      deriveRules({
        prRules: () => ({
          count: null,
          countRule: null,
          internal: null,
          ignore: [/configured for manual reviews/i],
          applied: ["quiet-bots"],
        }),
      }),
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
      derive(
        { author: { login: "dependabot", bot: true } },
        deriveRules({ prRules: () => ruled({ count: true, countRule: "count-bots" }) }),
      ).counted,
    ).toBe(true);
  });

  it("leaves out a PR a rule says not to count, naming the rule, but never counts one twice", () => {
    const skip = deriveRules({ prRules: () => ruled({ count: false, countRule: "no-chores" }) });
    expect(derive({}, skip)).toMatchObject({
      counted: false,
      exclusion: "rule",
      excludedBy: "no-chores",
      rules: ["no-chores"],
    });
    // Branches decide first: `count: true` can't bring back a PR into an unmeasured branch.
    const keep = deriveRules({ prRules: () => ruled({ count: true, countRule: "all" }) });
    expect(derive({ baseBranch: "feature/x" }, keep)).toMatchObject({ exclusion: "base" });
  });

  it("takes internal from a rule", () => {
    const rules = deriveRules({ prRules: () => ruled({ internal: false }) });
    expect(derive({}, rules).internal).toBe(false);
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

describe("derivePr: review log and first responses", () => {
  it("logs each counted review, oldest first, leaving out the author's and bots'", () => {
    const fact = derive({
      reviews: [
        review(carol, "03-03 09:00", "approved"),
        review(bob, "03-02 14:00", "changes_requested"),
        review(alice, "03-02 15:00"),
        review(rabbit, "03-02 10:05"),
      ],
    });
    expect(fact.reviewLog).toEqual([
      { by: "bob", at: at("03-02 14:00"), state: "changes_requested" },
      { by: "carol", at: at("03-03 09:00"), state: "approved" },
    ]);
  });

  it("times a first response from ready, or from the reviewer's own request when that came later", () => {
    const fact = derive({
      events: [
        { type: "review_requested", at: at("03-02 12:00"), reviewer: { ...carol, team: false } },
        {
          type: "review_requested",
          at: at("03-02 11:00"),
          reviewer: { login: "core", bot: false, team: true },
        },
      ],
      reviews: [
        review(bob, "03-02 14:00"),
        review(carol, "03-02 16:00"),
        review(bob, "03-03 09:00"),
      ],
    });
    // Ready at 03-02 10:00. Bob wasn't asked: 4 hours. Carol was asked at 12:00: 4 hours.
    expect(fact.responses).toEqual([
      { by: "bob", hours: 4 },
      { by: "carol", hours: 4 },
    ]);
  });
});

describe("derivePr: where an open PR stands", () => {
  const open = { state: "open" as const, mergedAt: null, closedAt: null, mergedBy: null };
  const asked = (who: typeof bob, time: string) => ({
    type: "review_requested" as const,
    at: at(time),
    reviewer: { ...who, team: false },
  });
  const push = (time: string) => ({
    sha: `p${time}`,
    authoredAt: at(time),
    committedAt: at(time),
    message: "more",
  });

  it("is nothing once the PR has ended", () => {
    expect(derive()).toMatchObject({ openState: null, waitingOn: null, waitingSince: null });
  });

  it("waits on its author while a draft", () => {
    expect(derive({ ...open, draft: true })).toMatchObject({
      openState: "draft",
      waitingOn: { on: "author", why: "draft" },
      waitingSince: at("03-02 10:00"),
    });
  });

  it("waits on the people asked to review, or says nobody was asked", () => {
    expect(
      derive({
        ...open,
        events: [
          asked(bob, "03-02 11:00"),
          asked(rabbit, "03-02 11:00"),
          {
            type: "review_requested",
            at: at("03-02 11:00"),
            reviewer: { login: "core", bot: false, team: true },
          },
        ],
      }),
    ).toMatchObject({
      openState: "waiting",
      waitingOn: { on: "reviewers", why: "requested", people: ["bob"], teams: ["core"] },
      waitingSince: at("03-02 10:00"),
    });
    expect(derive(open)).toMatchObject({
      openState: "waiting",
      waitingOn: { on: "reviewers", why: "unassigned", people: [], teams: [] },
    });
  });

  it("waits on the author after a change request, and on the reviewer once the author pushes", () => {
    const changes = { ...open, reviews: [review(bob, "03-03 10:00", "changes_requested")] };
    expect(derive(changes)).toMatchObject({
      openState: "in_review",
      waitingOn: { on: "author", why: "changes_requested" },
      waitingSince: at("03-03 10:00"),
    });
    expect(
      derive({ ...changes, commits: [...prModel().commits, push("03-04 08:00")] }),
    ).toMatchObject({
      openState: "in_review",
      waitingOn: { on: "reviewers", why: "re_review", people: ["bob"], teams: [] },
      waitingSince: at("03-04 08:00"),
    });
  });

  it("waits on the merge once approved, unless a change request still stands", () => {
    expect(derive({ ...open, reviews: [review(bob, "03-03 10:00", "approved")] })).toMatchObject({
      openState: "approved",
      waitingOn: { on: "merge", why: "approved" },
      waitingSince: at("03-03 10:00"),
    });
    expect(
      derive({
        ...open,
        reviews: [
          review(bob, "03-03 10:00", "approved"),
          review(carol, "03-03 11:00", "changes_requested"),
        ],
      }),
    ).toMatchObject({ openState: "in_review", waitingOn: { on: "author" } });
    // A reviewer's own later approval replaces their change request.
    expect(
      derive({
        ...open,
        reviews: [
          review(bob, "03-03 10:00", "changes_requested"),
          review(bob, "03-03 12:00", "approved"),
        ],
      }),
    ).toMatchObject({ openState: "approved" });
  });

  it("after comments alone, waits on the author, then on the reviewers once the author pushes", () => {
    const commented = { ...open, reviews: [review(bob, "03-03 10:00")] };
    expect(derive(commented)).toMatchObject({
      openState: "in_review",
      waitingOn: { on: "author", why: "review_comments" },
    });
    expect(
      derive({ ...commented, commits: [...prModel().commits, push("03-03 12:00")] }),
    ).toMatchObject({ waitingOn: { on: "reviewers", why: "re_review", people: ["bob"] } });
  });

  it("stops waiting on a reviewer once they review, until they are asked again", () => {
    const fact = derive({
      ...open,
      events: [asked(bob, "03-02 11:00"), asked(carol, "03-02 11:00"), asked(bob, "03-04 09:00")],
      reviews: [review(bob, "03-03 10:00")],
      commits: [...prModel().commits, push("03-04 08:00")],
    });
    expect(fact.waitingOn).toEqual({
      on: "reviewers",
      why: "re_review",
      people: ["bob", "carol"],
      teams: [],
    });
  });
});
