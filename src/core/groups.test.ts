import { describe, expect, it } from "vitest";
import { attribute, type Groups, type Member, teamOverlaps } from "./groups.ts";

const member = (login: string, extra: Partial<Member> = {}): Member => ({
  login,
  from: null,
  to: null,
  secondary: false,
  ...extra,
});

const groups: Groups = {
  teams: [
    { name: "Platform", members: [member("devon", { to: "2026-05-31" }), member("mika")] },
    {
      name: "Payments",
      members: [
        member("Ana"),
        member("devon", { from: "2026-06-01" }),
        member("mika", { secondary: true }),
      ],
    },
  ],
  products: [
    { name: "Checkout", repos: ["acme/cart"], teams: ["Payments"] },
    { name: "Core", repos: ["acme/cart", "acme/api"], teams: [] },
  ],
};

const pr = (author: string, createdAt: string, repo = "acme/web") => ({ author, createdAt, repo });

describe("attribute", () => {
  it("puts a PR in its author's team on the day it opened, so a move keeps its history", () => {
    expect(attribute(groups, pr("devon", "2026-05-31T23:00:00Z")).team).toBe("Platform");
    expect(attribute(groups, pr("devon", "2026-06-01T08:00:00Z")).team).toBe("Payments");
    expect(attribute(groups, pr("ana", "2026-01-01T00:00:00Z")).team).toBe("Payments");
    expect(attribute(groups, pr("visitor", "2026-01-01T00:00:00Z")).team).toBeNull();
  });

  it("counts a secondary member's PRs for their primary team only", () => {
    expect(attribute(groups, pr("mika", "2026-03-01T00:00:00Z"))).toMatchObject({
      team: "Platform",
      alsoTeams: ["Payments"],
    });
  });

  it("puts a PR in every product that owns its repo or its team", () => {
    expect(attribute(groups, pr("ana", "2026-03-01T00:00:00Z", "acme/web")).products).toEqual([
      "Checkout",
    ]);
    expect(attribute(groups, pr("mika", "2026-03-01T00:00:00Z", "ACME/cart")).products).toEqual([
      "Checkout",
      "Core",
    ]);
    expect(attribute(groups, pr("visitor", "2026-03-01T00:00:00Z", "acme/api")).products).toEqual([
      "Core",
    ]);
  });
});

describe("teamOverlaps", () => {
  it("accepts dated moves and secondary memberships", () => {
    expect(teamOverlaps(groups.teams)).toEqual([]);
  });

  it("refuses a person in two teams at once, saying when and how to fix it", () => {
    const problems = teamOverlaps([
      { name: "A", members: [member("sam", { from: "2026-01-01", to: "2026-06-30" })] },
      { name: "B", members: [member("sam", { from: "2026-06-01" })] },
      { name: "C", members: [member("lee")] },
      { name: "D", members: [member("Lee")] },
    ]);
    expect(problems).toEqual([
      expect.stringContaining("sam is in A and B from 2026-06-01 to 2026-06-30"),
      expect.stringContaining("lee is in C and D at the same time"),
    ]);
  });
});
