import { describe, expect, it } from "vitest";
import { prFact } from "../testing/factories.ts";
import { ruleImpact } from "./preview.ts";

describe("ruleImpact", () => {
  it("lists PRs that would stop or start counting, and authors whose side would change", () => {
    const counted = prFact({ id: "A", number: 1 });
    const outsider = prFact({ id: "B", number: 2, fromFork: true, authorAssociation: "NONE" });
    const staff = prFact({ id: "C", number: 3, authorAssociation: "MEMBER" });
    const before = [counted, outsider, staff];
    const after = [
      {
        ...counted,
        counted: false,
        exclusion: "rule" as const,
        excludedBy: "no-chores",
        rules: ["no-chores"],
      },
      { ...outsider, internal: true, rules: ["contractors"] },
      { ...staff, internal: true, rules: ["contractors"] },
    ];
    const impact = ruleImpact(before, after);
    expect(impact.leftOut).toEqual([
      expect.objectContaining({ number: 1, before: null, after: "rule", rule: "no-chores" }),
    ]);
    expect(impact.broughtIn).toEqual([]);
    // The member already counted as internal: a rule saying so changes nothing a reader sees.
    expect(impact.internal.map((c) => c.number)).toEqual([2]);
    expect(impact.applied).toEqual({ "no-chores": 1, contractors: 2 });
  });
});
