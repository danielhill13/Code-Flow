import { describe, expect, it } from "vitest";
import { prFact } from "../testing/factories.ts";
import { type Groups, NO_TEAM, noGroup } from "./groups.ts";
import type { PrModel } from "./model.ts";
import {
  breakdowns,
  breakdownValues,
  byContributors,
  type Choices,
  choices,
  defaultBreakdown,
  EVERYTHING,
  isInternal,
  narrow,
  type Selection,
  selectionName,
  selects,
  validSelection,
} from "./selection.ts";

const groups: Groups = {
  people: [
    { key: "ana", name: "Ana Ruiz", github: ["ana"], internal: null, bot: null },
    { key: "devon", name: null, github: ["devon"], internal: null, bot: null },
  ],
  teams: [
    { name: "Platform", members: [{ login: "devon", from: null, to: null, secondary: false }] },
    { name: "Payments", members: [{ login: "ana", from: null, to: null, secondary: false }] },
  ],
  groups: [
    { name: "Checkout", kind: "product", repos: ["acme/api"], teams: [], people: [] },
    { name: "Mobile", kind: "area", repos: [], teams: [], people: ["devon"] },
  ],
};

/** A fact as derive would leave it: its team, and its groups with a catch-all per missing kind. */
const pr = (
  author: string,
  overrides: Partial<PrModel>,
  team: string | null,
  groupNames: string[],
) => ({
  ...prFact({ author: { login: author, bot: false }, ...overrides }),
  person: author,
  team,
  groups: groupNames,
});

const prs = [
  pr("ana", { repo: "acme/api" }, "Payments", ["Checkout", noGroup("area")]),
  pr("devon", { repo: "acme/web" }, "Platform", [noGroup("product"), "Mobile"]),
  pr("devon", { repo: "acme/api" }, "Platform", ["Checkout", "Mobile"]),
  pr("visitor", { repo: "acme/api", fromFork: true, authorAssociation: "NONE" }, null, [
    "Checkout",
    noGroup("area"),
  ]),
];

const options: Choices = choices(groups, ["acme/web", "acme/api"], prs);
const some = (selection: Partial<Selection>): Selection => ({ ...EVERYTHING, ...selection });
const numbers = (selection: Selection) =>
  prs.filter(selects(selection, options)).map((p) => `${p.person}@${p.repo}`);

describe("choices", () => {
  it("lists teams and each kind's groups A–Z with catch-alls last, and people with names", () => {
    expect(options.teams.map((t) => t.name)).toEqual(["Payments", "Platform", NO_TEAM]);
    expect(options.groups.map((g) => [g.name, g.kind])).toEqual([
      ["Checkout", "product"],
      ["No product", "product"],
      ["Mobile", "area"],
      ["No area", "area"],
    ]);
    expect(options.kinds).toEqual(["product", "area"]);
    expect(options.people).toEqual([
      { key: "ana", name: "Ana Ruiz" },
      { key: "devon", name: null },
      { key: "visitor", name: null },
    ]);
  });
});

describe("selects", () => {
  it("matches any value within a dimension, and every dimension that is set", () => {
    expect(numbers(EVERYTHING)).toHaveLength(4);
    expect(numbers(some({ team: ["payments", "Platform"] }))).toEqual([
      "ana@acme/api",
      "devon@acme/web",
      "devon@acme/api",
    ]);
    expect(numbers(some({ repo: ["acme/api"], person: ["visitor", "devon"] }))).toEqual([
      "devon@acme/api",
      "visitor@acme/api",
    ]);
    expect(numbers(some({ team: [NO_TEAM] }))).toEqual(["visitor@acme/api"]);
  });

  it("combines groups of different kinds, and any group within a kind", () => {
    expect(numbers(some({ group: ["Checkout", "Mobile"] }))).toEqual(["devon@acme/api"]);
    expect(numbers(some({ group: ["Checkout", "No product"] }))).toHaveLength(4);
    expect(numbers(some({ group: ["No area"] }))).toEqual(["ana@acme/api", "visitor@acme/api"]);
  });

  it("drops values that no longer exist", () => {
    expect(validSelection(options, some({ team: ["Gone", "payments"], person: ["ANA"] }))).toEqual(
      some({ team: ["Payments"], person: ["ana"] }),
    );
  });
});

describe("breakdowns", () => {
  it("offers teams, each kind of group and repos, unless narrowed to one", () => {
    expect(breakdowns(options, EVERYTHING)).toEqual([
      "team",
      "group:product",
      "group:area",
      "repo",
    ]);
    expect(breakdowns(options, some({ group: ["Checkout"] }))).toEqual([
      "team",
      "group:area",
      "repo",
    ]);
    expect(defaultBreakdown(options, EVERYTHING)).toBe("team");
    expect(defaultBreakdown(options, some({ team: ["Payments"] }))).toBe("repo");
  });

  it("lists a kind's groups, and narrows one kind without dropping another", () => {
    expect(breakdownValues(options, "group:area", prs)).toEqual(["Mobile", "No area"]);
    expect(
      narrow(options, some({ group: ["Checkout", "Mobile"] }), "group:area", "No area"),
    ).toEqual(some({ group: ["Checkout", "No area"] }));
  });

  it("names a selection by what it holds, people by their names", () => {
    expect(selectionName(options, EVERYTHING)).toBe("All teams");
    expect(selectionName(options, some({ team: ["Payments"], repo: ["acme/api"] }))).toBe(
      "Payments · acme/api",
    );
    expect(selectionName(options, some({ person: ["ana", "devon"] }))).toBe("Ana Ruiz, devon");
  });
});

describe("contributors", () => {
  it("lets config decide, then team membership, then GitHub", () => {
    const hidden = {
      ...prs[0],
      fromFork: true,
      authorAssociation: "CONTRIBUTOR",
      internal: null,
    } as (typeof prs)[number];
    expect(isInternal(hidden)).toBe(true); // in a team
    expect(isInternal({ ...hidden, team: null })).toBe(false);
    expect(isInternal({ ...hidden, team: null, internal: true })).toBe(true);
    expect(isInternal({ ...hidden, internal: false })).toBe(false);
    expect(prs.filter(byContributors("external")).map((p) => p.person)).toEqual(["visitor"]);
  });
});
