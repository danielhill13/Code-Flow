import { describe, expect, it } from "vitest";
import {
  alice,
  at,
  bob,
  carol,
  deriveRules,
  prFact,
  prModel,
  rabbit,
} from "../testing/factories.ts";
import { churnClues, linkChurn } from "./churn.ts";
import { contextAt, metricOf } from "./metrics.ts";
import type { PrModel } from "./model.ts";

const rules = deriveRules();
const file = (path: string) => ({ path, additions: 10, deletions: 2 });

/** Derives the PRs as one repo's, linking churn, and returns their facts by number. */
function linked(models: PrModel[]) {
  const facts = new Map(models.map((m) => [m.id, prFact(m, rules)]));
  linkChurn(
    models.map((m) => churnClues(m, facts.get(m.id) ?? prFact(m), rules.classify)),
    facts,
  );
  return new Map([...facts.values()].map((f) => [f.number, f]));
}

const pr = (number: number, mergedDay: string, overrides: Partial<PrModel> = {}) =>
  prModel({
    id: `PR_${number}`,
    number,
    mergedAt: at(`${mergedDay} 10:00`),
    closedAt: at(`${mergedDay} 10:00`),
    files: [file("src/app.ts")],
    ...overrides,
  });

describe("churn: product files changed again after merging [rule 13]", () => {
  it("names the first later PR into the same branch that changed one of its product files", () => {
    const facts = linked([
      pr(1, "03-04"),
      pr(2, "03-10", { author: bob, files: [file("src/other.ts"), file("src/app.ts")] }),
      pr(3, "03-08", { author: carol, files: [file("src/app.ts")] }),
      pr(4, "03-06", { author: carol, files: [file("src/unrelated.ts")] }),
    ]);
    expect(facts.get(1)).toMatchObject({ touchedAgainBy: 3, touchedAgainAt: at("03-08 10:00") });
    expect(facts.get(3)).toMatchObject({ touchedAgainBy: 2 });
    expect(facts.get(2)).toMatchObject({ touchedAgainBy: null, touchedAgainAt: null });
    expect(facts.get(4)).toMatchObject({ touchedAgainBy: null });
  });

  it("sets a follow-up only for the same person's later PR", () => {
    const facts = linked([
      pr(1, "03-04"),
      pr(2, "03-06", { author: bob }),
      pr(3, "03-09", { author: alice }),
    ]);
    expect(facts.get(1)).toMatchObject({
      touchedAgainBy: 2,
      followUpBy: 3,
      followUpAt: at("03-09 10:00"),
    });
  });

  it("ignores test and docs files, other branches, bots' PRs and open PRs", () => {
    const facts = linked([
      pr(1, "03-04", { files: [file("src/app.ts"), file("src/app.test.ts"), file("README.md")] }),
      pr(2, "03-05", { author: bob, files: [file("src/app.test.ts"), file("README.md")] }),
      pr(3, "03-06", { author: bob, baseBranch: "release" }),
      pr(4, "03-07", { author: rabbit }),
      pr(5, "03-08", { author: bob, state: "open", mergedAt: null, closedAt: null }),
    ]);
    expect(facts.get(1)).toMatchObject({ touchedAgainBy: null, followUpBy: null });
  });

  it("can't say for a PR whose files weren't all listed", () => {
    const facts = linked([
      pr(1, "03-04", { truncated: ["files"] }),
      pr(2, "03-05", { author: bob }),
    ]);
    expect(facts.get(1)?.touchedAgainBy).toBeNull();
    const metric = metricOf("touchedAgain");
    if (metric.kind !== "share") throw new Error("a share");
    const fact = facts.get(1);
    expect(fact && metric.test(fact, contextAt(new Date(at("06-01 00:00"))))).toBeNull();
  });
});

describe("the churn metrics [rule 13]", () => {
  const metric = metricOf("touchedAgain");
  if (metric.kind !== "share") throw new Error("a share");
  const facts = linked([
    pr(1, "03-04"),
    pr(2, "03-20", { author: bob }),
    pr(3, "05-01", { author: bob }),
  ]);
  const one = facts.get(1);
  const two = facts.get(2);
  if (!one || !two) throw new Error("derived");

  it("counts a change within the window, and not one after it", () => {
    const ctx = contextAt(new Date(at("06-30 00:00")));
    expect(metric.test(one, ctx)).toBe(true); // 16 days later
    expect(metric.test(two, ctx)).toBe(false); // 42 days later: outside 30
    expect(metric.test(two, { ...ctx, churnDays: 60 })).toBe(true);
  });

  it("is null while a PR is too recent to tell, never a no", () => {
    const facts2 = linked([pr(9, "06-20")]);
    const recent = facts2.get(9);
    if (!recent) throw new Error("derived");
    expect(metric.test(recent, contextAt(new Date(at("06-30 00:00"))))).toBeNull();
    expect(metric.test(recent, contextAt(new Date(at("07-30 00:00"))))).toBe(false);
  });
});
