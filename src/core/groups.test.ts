import { describe, expect, it } from "vitest";
import {
  attribute,
  type Groups,
  groupProblems,
  type Member,
  noGroup,
  type Person,
  personOf,
} from "./groups.ts";

const member = (login: string, extra: Partial<Member> = {}): Member => ({
  login,
  from: null,
  to: null,
  secondary: false,
  ...extra,
});

const person = (key: string, extra: Partial<Person> = {}): Person => ({
  key,
  name: null,
  github: [key],
  internal: null,
  bot: null,
  ...extra,
});

const groups: Groups = {
  people: [
    person("ana", { name: "Ana Ruiz", github: ["ana-r", "ana-old"] }),
    person("deploy", { github: ["deploy-svc"], bot: true, internal: true }),
  ],
  teams: [
    { name: "Platform", members: [member("devon", { to: "2026-05-31" }), member("mika")] },
    {
      name: "Payments",
      members: [
        member("ana"),
        member("devon", { from: "2026-06-01" }),
        member("mika", { secondary: true }),
      ],
    },
  ],
  groups: [
    { name: "Checkout", kind: "product", repos: ["acme/cart"], teams: ["Payments"], people: [] },
    { name: "Core", kind: "product", repos: ["acme/cart", "acme/api"], teams: [], people: [] },
    { name: "Mobile", kind: "area", repos: [], teams: [], people: ["mika"] },
  ],
};

const pr = (author: string, createdAt: string, repo = "acme/web") => ({ author, createdAt, repo });

describe("personOf", () => {
  it("finds a person by any of their logins, or by their key; others are their own login", () => {
    expect(personOf(groups, "ANA-OLD")).toBe("ana");
    expect(personOf(groups, "ana")).toBe("ana");
    expect(personOf(groups, "visitor")).toBe("visitor");
  });
});

describe("attribute", () => {
  it("puts a PR in its author's team on the day it opened, so a move keeps its history", () => {
    expect(attribute(groups, pr("devon", "2026-05-31T23:00:00Z")).team).toBe("Platform");
    expect(attribute(groups, pr("devon", "2026-06-01T08:00:00Z")).team).toBe("Payments");
    expect(attribute(groups, pr("ana-r", "2026-01-01T00:00:00Z"))).toMatchObject({
      person: "ana",
      team: "Payments",
    });
    expect(attribute(groups, pr("visitor", "2026-01-01T00:00:00Z")).team).toBeNull();
  });

  it("counts a secondary member's PRs for their primary team only", () => {
    expect(attribute(groups, pr("mika", "2026-03-01T00:00:00Z"))).toMatchObject({
      team: "Platform",
      alsoTeams: ["Payments"],
    });
  });

  it("puts a PR in every group its repo, team or author belongs to, and catch-alls per kind", () => {
    const at = "2026-03-01T00:00:00Z";
    expect(attribute(groups, pr("ana", at, "acme/web")).groups).toEqual([
      "Checkout",
      noGroup("area"),
    ]);
    expect(attribute(groups, pr("mika", at, "ACME/cart")).groups).toEqual([
      "Checkout",
      "Core",
      "Mobile",
    ]);
    expect(attribute(groups, pr("visitor", at, "acme/x")).groups).toEqual([
      "No product",
      "No area",
    ]);
  });

  it("knows a service account by its login, as a person", () => {
    // What config says about them (bot, internal) is a rule: see core/rules.ts.
    expect(attribute(groups, pr("deploy-svc", "2026-03-01T00:00:00Z")).person).toBe("deploy");
  });
});

describe("groupProblems", () => {
  it("accepts dated moves and secondary memberships", () => {
    expect(groupProblems(groups)).toEqual([]);
  });

  it("refuses a person in two teams at once, even under another login", () => {
    const problems = groupProblems({
      people: [person("sam", { github: ["sam", "sam-work"] })],
      teams: [
        { name: "A", members: [member("sam", { from: "2026-01-01", to: "2026-06-30" })] },
        { name: "B", members: [member("sam-work", { from: "2026-06-01" })] },
      ],
    });
    expect(problems).toEqual([
      expect.stringContaining("is in A and B from 2026-06-01 to 2026-06-30"),
    ]);
  });

  it("refuses a login claimed by two people", () => {
    const problems = groupProblems({
      people: [person("sam", { github: ["sam", "shared"] }), person("lee", { github: ["shared"] })],
      teams: [],
    });
    expect(problems).toEqual([expect.stringContaining("shared is listed under both sam and lee")]);
  });
});
