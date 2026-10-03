import { describe, expect, it } from "vitest";
import { prFact } from "../testing/factories.ts";
import { NO_PRODUCT, NO_TEAM } from "./groups.ts";
import type { PrModel } from "./model.ts";
import {
  breakdowns,
  byContributors,
  type Choices,
  choices,
  defaultBreakdown,
  EVERYTHING,
  isInternal,
  selectionName,
  selects,
  validSelection,
} from "./selection.ts";

const pr = (overrides: Partial<PrModel>, team: string | null, products: string[] = []) => ({
  ...prFact(overrides),
  team,
  products,
});

const prs = [
  pr({ repo: "acme/api", author: { login: "ana", bot: false } }, "Payments", ["Checkout"]),
  pr({ repo: "acme/web", author: { login: "devon", bot: false } }, "Platform"),
  pr(
    {
      repo: "acme/api",
      author: { login: "visitor", bot: false },
      fromFork: true,
      authorAssociation: "NONE",
    },
    null,
  ),
];

const options: Choices = choices(
  {
    teams: [
      { name: "Platform", members: [{ login: "devon", from: null, to: null, secondary: false }] },
      { name: "Payments", members: [{ login: "ana", from: null, to: null, secondary: false }] },
    ],
    products: [{ name: "Checkout", repos: ["acme/api"], teams: [] }],
  },
  ["acme/web", "acme/api"],
  prs,
);

const authors = (selection: typeof EVERYTHING) =>
  prs.filter(selects(selection)).map((p) => p.author);

describe("choices", () => {
  it("lists teams and products A–Z with their catch-alls last, and the PRs' authors", () => {
    expect(options.teams.map((t) => t.name)).toEqual(["Payments", "Platform", NO_TEAM]);
    expect(options.products.map((p) => p.name)).toEqual(["Checkout", NO_PRODUCT]);
    expect(options.people).toEqual(["ana", "devon", "visitor"]);
  });
});

describe("selects", () => {
  it("matches any value within a dimension and every dimension that is set", () => {
    expect(authors(EVERYTHING)).toEqual(["ana", "devon", "visitor"]);
    expect(authors({ ...EVERYTHING, team: ["payments", "Platform"] })).toEqual(["ana", "devon"]);
    expect(authors({ ...EVERYTHING, repo: ["acme/api"], person: ["visitor", "devon"] })).toEqual([
      "visitor",
    ]);
    expect(authors({ ...EVERYTHING, team: [NO_TEAM] })).toEqual(["visitor"]);
    expect(authors({ ...EVERYTHING, product: [NO_PRODUCT] })).toEqual(["devon", "visitor"]);
  });

  it("drops values that no longer exist", () => {
    expect(
      validSelection(options, { ...EVERYTHING, team: ["Gone", "payments"], person: ["ANA"] }),
    ).toEqual({
      ...EVERYTHING,
      team: ["Payments"],
      person: ["ana"],
    });
  });
});

describe("breakdowns", () => {
  it("offers any dimension not narrowed to one value, starting where a reader would", () => {
    expect(breakdowns(options, EVERYTHING)).toEqual(["team", "product", "repo"]);
    expect(defaultBreakdown(options, EVERYTHING)).toBe("team");
    expect(defaultBreakdown(options, { ...EVERYTHING, team: ["Payments"] })).toBe("repo");
    expect(defaultBreakdown(options, { ...EVERYTHING, repo: ["acme/api"] })).toBe("team");
  });

  it("names a selection by what it holds", () => {
    expect(selectionName(options, EVERYTHING)).toBe("All teams");
    expect(selectionName(options, { ...EVERYTHING, team: ["Payments"], repo: ["acme/api"] })).toBe(
      "Payments · acme/api",
    );
    expect(selectionName(options, { ...EVERYTHING, person: ["a", "b", "c", "d"] })).toBe("a, b +2");
  });
});

describe("contributors", () => {
  it("counts team members as internal whatever GitHub says about them", () => {
    const hidden = pr({ fromFork: true, authorAssociation: "CONTRIBUTOR" }, "Payments");
    expect(isInternal(hidden)).toBe(true);
    expect(isInternal({ ...hidden, team: null })).toBe(false);
    expect(prs.filter(byContributors("external")).map((p) => p.author)).toEqual(["visitor"]);
  });
});
