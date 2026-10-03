// Real pull requests from usebruno/bruno, anonymized (scripts/fixture.ts), run through the same
// path sync's pipeline takes. Every expected value was checked against GitHub's REST API, which
// sync does not use, when Phase 2 was built.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../config/load.ts";
import { derivePr } from "../../core/derive.ts";
import { linkReverts, revertClues } from "../../core/reverts.ts";
import { rulesFor } from "../../pipeline/derive.ts";
import { type GhPayload, normalizePr } from "./normalize.ts";

const fixture = new URL("../../testing/fixtures/github/usebruno-bruno.json", import.meta.url);
const payloads = JSON.parse(readFileSync(fixture, "utf8")) as GhPayload[];

const config = parseConfig("sources:\n  - repo: usebruno/bruno\nsince: 2025-10-01\n");
const models = payloads.map((payload) =>
  normalizePr(payload, { id: "R_bruno", fullName: "usebruno/bruno" }),
);
const facts = new Map(
  models.map((model) => [model.id, derivePr(model, rulesFor(config, "usebruno/bruno", ["main"]))]),
);
linkReverts(models.map(revertClues), facts);
const fact = (number: number) => [...facts.values()].find((f) => f.number === number);

describe("real PRs from usebruno/bruno", () => {
  it("reads every list in full: nothing was cut short", () => {
    for (const model of models) expect(model.truncated, `#${model.number}`).toEqual([]);
  });

  it("#9000: a draft for a day, then four change requests and six rounds", () => {
    expect(fact(9000)).toMatchObject({
      counted: true,
      fromFork: true,
      readyAt: "2026-08-19T17:48:21Z",
      firstReviewAt: "2026-08-21T06:33:09Z",
      firstApprovalAt: "2026-09-02T10:22:05Z",
      mergedAt: "2026-09-02T10:29:36Z",
      reviews: 12,
      approvals: 1,
      changesRequested: 4,
      rounds: 6,
      sizeLines: 117,
      addedLines: 107,
      comments: 2,
    });
    expect(fact(9000)?.reviewers).toHaveLength(4);
    expect(fact(9000)?.pickupHours).toBeCloseTo(36.7467, 3);
    expect(fact(9000)?.cycleHours).toBeCloseTo(359.6392, 3);
  });

  it("#8790: opened before its first commit, approved, merged a month later by its author", () => {
    expect(fact(8790)).toMatchObject({
      readyAt: "2026-07-28T01:15:33Z",
      firstApprovalAt: "2026-08-05T06:55:42Z",
      selfMerged: true,
      codingHours: 0,
      sizeLines: 0, // docs only
    });
    expect(fact(8790)?.mergeWaitHours).toBeCloseTo(784.6, 1);
  });

  it("#7719 and #7921: a feature and the revert that undid it", () => {
    expect(fact(7719)).toMatchObject({
      revertedBy: 7921,
      revertedAt: "2026-05-06T08:29:30Z",
      rounds: 3,
    });
    expect(fact(7921)).toMatchObject({ reverts: [7719], sizeLines: 813, fromFork: false });
  });

  it("#6134: a Dependabot PR is not counted", () => {
    expect(fact(6134)).toMatchObject({ counted: false, exclusion: "bot", authorIsBot: true });
  });

  it("#6738: a PR from a fork's main branch is new work, not a promotion", () => {
    expect(fact(6738)).toMatchObject({ counted: true, fromFork: true, headBranch: "main" });
  });

  it("#2750: merged without a review", () => {
    expect(fact(2750)).toMatchObject({ reviewed: false, pickupHours: null, reviewHours: null });
  });

  it("#9198: closed without merging has no phases", () => {
    expect(fact(9198)).toMatchObject({
      state: "closed",
      counted: true,
      cycleHours: null,
      sizeLines: 36,
    });
  });

  it("ignores CodeRabbit's reviews, which are in these payloads", () => {
    const rabbit = models
      .flatMap((model) => model.reviews)
      .filter((r) => r.author?.login === "coderabbitai");
    expect(rabbit.length).toBeGreaterThan(0);
    for (const f of facts.values()) expect(f.reviewers).not.toContain("coderabbitai");
  });
});
