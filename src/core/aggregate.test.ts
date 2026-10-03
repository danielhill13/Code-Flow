import { describe, expect, it } from "vitest";
import { at, bob, deriveRules, prModel } from "../testing/factories.ts";
import { measure } from "./aggregate.ts";
import { derivePr } from "./derive.ts";
import type { PrFact } from "./facts.ts";
import type { PrModel } from "./model.ts";
import { parsePeriod } from "./periods.ts";

const march =
  parsePeriod("2026-03") ??
  (() => {
    throw new Error("unreachable");
  })();
const asOf = new Date("2026-04-15T00:00:00Z");

let next = 1;
/** A fact for a PR merged in March unless overridden. */
const fact = (overrides: Partial<PrModel> = {}): PrFact => {
  const number = next++;
  return derivePr(prModel({ id: `PR_${number}`, number, ...overrides }), deriveRules());
};
const many = (count: number, overrides: Partial<PrModel> = {}) =>
  Array.from({ length: count }, () => fact(overrides));

const metricOf = (facts: PrFact[], key: string) => {
  const found = measure(facts, march, { asOf }).values.find((v) => v.metric.key === key);
  if (!found) throw new Error(`no metric ${key}`);
  return found;
};

describe("measure", () => {
  it("counts PRs merged in the period, and says why others were left out", () => {
    const facts = [
      ...many(3),
      fact({ mergedAt: at("02-20 10:00"), createdAt: at("02-19 10:00") }),
      fact({ author: { login: "dependabot", bot: true } }),
      fact({ baseBranch: "feature/x" }),
    ];
    const result = measure(facts, march, { asOf });
    expect(result.values.find((v) => v.metric.key === "merged")).toMatchObject({ value: 3, n: 3 });
    expect(result.excluded).toEqual({ bot: 1, base: 1, promotion: 0 });
  });

  it("hides a median resting on fewer than 10 PRs", () => {
    expect(metricOf(many(9), "cycle")).toMatchObject({
      value: null,
      n: 9,
      hidden: "needs 10 PRs with a value, has 9",
    });
    expect(metricOf(many(10), "cycle")).toMatchObject({ value: 72, n: 10 });
  });

  it("uses another percentile when asked", () => {
    const facts = [...many(19), fact({ mergedAt: at("03-20 10:00") })];
    const p75 = measure(facts, march, { asOf, percentile: 0.75 }).values.find(
      (v) => v.metric.key === "cycle",
    );
    expect(p75).toMatchObject({ value: 72, n: 20 });
  });

  it("counts a share only over the PRs it applies to", () => {
    const reviewed = {
      reviews: [{ author: bob, state: "approved" as const, at: at("03-03 10:00"), body: "" }],
    };
    const facts = [...many(2, reviewed), ...many(2)];
    expect(metricOf(facts, "reviewed")).toMatchObject({ value: 0.5, n: 4 });
    // Re-pushed applies to reviewed PRs only: the two unreviewed ones aren't in its n.
    expect(metricOf(facts, "repushed")).toMatchObject({ value: 0, n: 2, notApplicable: 2 });
  });

  it("leaves merges too recent to judge out of the revert rate", () => {
    const facts = [
      fact({ mergedAt: at("03-04 10:00") }),
      { ...fact({ mergedAt: at("03-04 10:00") }), revertedAt: at("03-10 10:00"), revertedBy: 99 },
      fact({ mergedAt: at("03-31 10:00") }), // 15 days before asOf: too recent
    ];
    expect(metricOf(facts, "reverted")).toMatchObject({ value: 0.5, n: 2, notApplicable: 1 });
  });

  it("measures abandonment over PRs that ended in the period", () => {
    const facts = [
      ...many(3),
      fact({ state: "closed", mergedAt: null, closedAt: at("03-10 10:00") }),
      fact({ state: "open", mergedAt: null, closedAt: null }),
    ];
    expect(metricOf(facts, "abandoned")).toMatchObject({ value: 0.25, n: 4 });
  });

  it("splits cycle hours into phases that add up, naming a PR that dominates one", () => {
    const facts = [
      ...many(3),
      fact({
        commits: [
          {
            sha: "x",
            authoredAt: at("01-01 10:00"),
            committedAt: at("01-01 10:00"),
            message: "old",
          },
        ],
      }),
    ];
    const phases = measure(facts, march, { asOf }).phases ?? [];
    expect(phases.reduce((sum, phase) => sum + phase.share, 0)).toBeCloseTo(1, 9);
    const coding = phases.find((phase) => phase.phase === "coding");
    expect(coding?.largestPr).toBe(facts[3]?.number);
    expect(coding?.largestShare).toBeGreaterThan(0.9);
  });

  it("snapshots open PRs as of the data, whatever the period", () => {
    const open = {
      state: "open" as const,
      mergedAt: null,
      closedAt: null,
      createdAt: at("04-05 00:00"),
    };
    const result = measure([fact(open), fact({ ...open, draft: true })], march, { asOf });
    expect(result.open).toEqual({ count: 2, drafts: 1, medianAgeDays: 10 });
  });
});
