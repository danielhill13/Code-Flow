import { describe, expect, it } from "vitest";
import { at, bob, carol, deriveRules, prFact } from "../../testing/factories.ts";
import type { PrFact } from "../facts.ts";
import { attribute, type Groups, NO_TEAM, noGroup } from "../groups.ts";
import { METRICS, metricOf } from "../metrics.ts";
import type { PrModel, Review } from "../model.ts";
import { choices, EVERYTHING, type Selection } from "../selection.ts";
import { compare } from "./compare.ts";
import { lagged, Slice, type ViewContext, type ViewQuery } from "./context.ts";
import { flow, openCount } from "./flow.ts";
import { overview } from "./overview.ts";
import { type PrFilter, prList } from "./prs.ts";
import { review } from "./review.ts";
import { speed } from "./speed.ts";

// The 30-day window is Sep 3 – Oct 3; the one before it Aug 4 – Sep 3.
const asOf = new Date("2026-10-03T00:00:00Z");
const repos = ["acme/api", "acme/web", "acme/scripts"];
// Products own repos; the one team is alice, who opens every PR but the outsider's.
const groups: Groups = {
  people: [],
  teams: [{ name: "Core", members: [{ login: "alice", from: null, to: null, secondary: false }] }],
  groups: [
    { name: "Platform", kind: "product", repos: ["acme/api"], teams: [], people: [] },
    { name: "Web", kind: "product", repos: ["acme/web"], teams: [], people: [] },
  ],
};
const NO_PRODUCT = noGroup("product");
const rules = deriveRules({ attribute: (pr) => attribute(groups, pr) });
const fact = (overrides: Partial<PrModel>) => prFact(overrides, rules);

const reviewBy = (who: typeof bob, time: string, state: Review["state"] = "approved"): Review => ({
  author: who,
  state,
  at: at(time),
  body: "",
});

/** A PR merged on `day` ("09-10"), opened the day before, first commit two days before. */
function merged(day: string, overrides: Partial<PrModel> = {}): PrFact {
  const [month, date] = day.split("-").map(Number) as [number, number];
  const shift = (days: number) =>
    new Date(Date.UTC(2026, month - 1, date - days, 10)).toISOString().replace(".000Z", "Z");
  return fact({
    createdAt: shift(1),
    mergedAt: shift(0),
    closedAt: shift(0),
    updatedAt: shift(0),
    commits: [{ sha: `c${day}`, authoredAt: shift(2), committedAt: shift(2), message: "x" }],
    reviews: [reviewBy(bob, `${day} 08:00`)],
    ...overrides,
  });
}

function open(createdAt: string, overrides: Partial<PrModel> = {}): PrFact {
  return fact({
    state: "open",
    createdAt,
    updatedAt: createdAt,
    mergedAt: null,
    closedAt: null,
    mergedBy: null,
    commits: [
      { sha: `o${createdAt}`, authoredAt: createdAt, committedAt: createdAt, message: "x" },
    ],
    ...overrides,
  });
}

const days = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `09-${String(from + i).padStart(2, "0")}`);

const facts: PrFact[] = [
  // Platform: 12 merged in the window, 3 in the window before.
  ...days(4, 12).map((day) => merged(day, { repo: "acme/api" })),
  ...["08-10", "08-11", "08-12"].map((day) => merged(day, { repo: "acme/api" })),
  // Web: 3 merged in the window, too few for a median; one into a feature branch, not counted.
  ...days(20, 3).map((day) => merged(day, { repo: "acme/web", reviews: [] })),
  merged("09-25", { repo: "acme/web", baseBranch: "feature/x" }),
  // Unassigned: one abandoned in the window.
  fact({
    repo: "acme/scripts",
    state: "closed",
    createdAt: at("09-01 10:00"),
    mergedAt: null,
    closedAt: at("09-15 10:00"),
    mergedBy: null,
  }),
  // Open: an outsider's PR waiting on bob since August, a draft, and an approved one.
  open(at("08-01 10:00"), {
    repo: "acme/api",
    fromFork: true,
    authorAssociation: "NONE",
    author: { login: "visitor", bot: false },
    events: [
      { type: "review_requested", at: at("08-01 11:00"), reviewer: { ...bob, team: false } },
    ],
  }),
  open(at("09-30 10:00"), { repo: "acme/api", draft: true }),
  open(at("10-01 10:00"), { repo: "acme/web", reviews: [reviewBy(carol, "10-02 10:00")] }),
];

const ctx: ViewContext = {
  facts,
  choices: choices(groups, repos, facts),
  asOf,
  coveredFrom: "2026-01-01",
  staleAfterDays: 90,
  peopleViews: true,
};
const query = (
  selection: Selection = EVERYTHING,
  overrides: Partial<ViewQuery> = {},
): ViewQuery => ({
  selection,
  by: "group:product",
  contributors: "all",
  window: "30d",
  percentile: 0.5,
  ...overrides,
});
const platform: Selection = { ...EVERYTHING, group: ["Platform"] };

describe("overview", () => {
  const model = overview(ctx, query());
  const tile = (key: string) => model.tiles.find((t) => t.key === key);

  it("compares each headline number with the window before", () => {
    expect(tile("merged")?.value).toMatchObject({ value: 15, n: 15 });
    expect(tile("merged")?.previous).toMatchObject({ value: 3 });
    expect(tile("cycle")?.value).toMatchObject({ value: 48, n: 15 });
    expect(tile("cycle")?.previous).toMatchObject({ value: null, hidden: expect.any(String) });
  });

  it("measures reverts a revert window back, so every PR is old enough to tell", () => {
    expect(tile("reverted")?.span).toMatchObject({
      start: "2026-08-04T00:00:00Z",
      label: "Aug 4 – Sep 3",
    });
    expect(tile("reverted")?.value).toMatchObject({ value: 0, n: 3, notApplicable: 0 });
  });

  it("draws one trend point per week, the last still running", () => {
    // Platform merges Sep 4–15, Web Sep 20–22: weeks start Aug 31, Sep 7, 14, 21 and 28.
    expect(tile("merged")?.series.map((p) => p.value?.value)).toEqual([3, 7, 3, 2, 0]);
    expect(tile("merged")?.series.at(-1)?.bucket.partial).toBe(true);
  });

  it("lists the teams A–Z with the unassigned group last, and nothing below a single repo", () => {
    expect(model.rows.map((r) => [r.name, r.merged.value.value, r.open])).toEqual([
      ["Platform", 12, 2],
      ["Web", 3, 1],
      [NO_PRODUCT, 0, 0],
    ]);
    expect(overview(ctx, query(platform)).rows).toEqual([]);
  });

  it("notes only facts: what isn't counted, single-PR outliers, outsiders, thin rows, the lag", () => {
    expect(model.notes.map((n) => n.kind)).toEqual([
      "excluded",
      "concentration",
      "outside",
      "tooFew",
      "revertLag",
    ]);
    expect(model.notes[0]).toMatchObject({ base: 1, bot: 0, promotion: 0 });
    // Each unreviewed Web PR waited 24 of the window's 96 merge-wait hours.
    expect(model.notes[1]).toMatchObject({ phase: "mergeWait", share: 0.25 });
    expect(model.notes[2]).toEqual({ kind: "outside", external: 1, open: 3 });
    expect(model.notes[3]).toEqual({
      kind: "tooFew",
      rows: [
        { name: "Web", merged: 3 },
        { name: NO_PRODUCT, merged: 0 },
      ],
    });
  });

  it("breaks down by team: whose PRs, wherever they landed", () => {
    const byTeam = overview(ctx, query(EVERYTHING, { by: "team" }));
    expect(byTeam.rows.map((r) => [r.name, r.merged.value.value, r.open])).toEqual([
      ["Core", 15, 2],
      [NO_TEAM, 0, 1],
    ]);
    expect(byTeam.rows[0]?.selection).toEqual({ ...EVERYTHING, team: ["Core"] });
  });

  it("says when products overlap, so their rows add up to more than the total", () => {
    const overlapping: ViewContext = {
      ...ctx,
      facts: facts.map((pr) =>
        pr.repo === "acme/api" ? { ...pr, groups: ["Platform", "Web"] } : pr,
      ),
    };
    const notes = overview(overlapping, query()).notes;
    expect(notes).toContainEqual({ kind: "overlap", by: "group:product", prs: 12 });
    expect(overview(ctx, query()).notes.map((n) => n.kind)).not.toContain("overlap");
  });

  it("filters by contributors without changing the selection", () => {
    const external = overview(ctx, query(EVERYTHING, { contributors: "external" }));
    expect(external.tiles[1]?.value.value).toBe(0);
    expect(external.notes.map((n) => n.kind)).not.toContain("outside");
  });

  it("shows no number for a window the data doesn't reach [rule 4]", () => {
    const late = overview({ ...ctx, coveredFrom: "2026-09-20" }, query());
    expect(late.tiles[0]?.value).toMatchObject({
      value: null,
      hidden: "the data starts 2026-09-20",
    });
    expect(late.phases).toBeNull();
  });
});

describe("every number opens its PRs [rule 8]", () => {
  // Rule 8: the list behind a value holds exactly the PRs the value rests on.
  const window = overview(ctx, query()).window;
  const list = (scope: Selection, filters: PrFilter[]) =>
    prList(ctx, {
      selection: scope,
      contributors: "all",
      set: "merged",
      filters,
      sort: { key: "merged", dir: "desc" },
      limit: 1000,
    }).total;

  it.each(METRICS.filter((m) => m.population === "merged").map((m) => m.key))("%s", (key) => {
    const metric = metricOf(key);
    for (const scope of [EVERYTHING, platform]) {
      const span = lagged(key, window.current);
      const value = new Slice(ctx, scope, "all").value(key, span, 0.5);
      const filters: PrFilter[] = [{ kind: "span", ...span }];
      if (metric.subset) filters.push({ kind: "applies", metric: key });
      expect(list(scope, filters)).toBe(value.n);
      if (metric.kind === "share" && value.value !== null) {
        const yes = list(scope, [...filters, { kind: "is", metric: key, value: true }]);
        expect(yes / value.n).toBeCloseTo(value.value, 9);
      }
    }
  });
});

describe("speed", () => {
  const model = speed(ctx, query());

  it("states predictability as the median, P85 and their ratio", () => {
    expect(model.predictability.median).toMatchObject({ value: 48, n: 15 });
    expect(model.predictability.slow).toMatchObject({ value: null }); // needs 34 PRs
    expect(model.predictability.spread).toBeNull();
  });

  it("marks the phase with the most cycle hours and splits PRs by size", () => {
    expect(model.largest).toBe("coding");
    expect(model.sizes.map((s) => s.count.value)).toEqual([15, 0, 0, 0, 0]);
  });
});

describe("review", () => {
  it("names nobody at the top level: one row per team instead [rule 10]", () => {
    const model = review(ctx, query());
    expect(model.reviewers).toEqual([]);
    expect(model.teams.map((t) => [t.name, t.reviews, t.reviewers, t.topTwo])).toEqual([
      ["Platform", 12, 1, null],
      ["Web", 1, 1, null], // carol's review of an open PR is review work too
      [NO_PRODUCT, 0, 0, null],
    ]);
    expect(model.unreviewed).toBe(3);
  });

  it("names reviewers inside a team, with the PRs waiting on them", () => {
    const model = review(ctx, query(platform));
    expect(model.teams).toEqual([]);
    expect(model.reviewers).toEqual([
      expect.objectContaining({ login: "bob", reviews: 12, share: 1, waiting: 1 }),
    ]);
    expect(model.reviewers[0]?.response).toMatchObject({ value: 22, n: 12 });
  });
});

describe("flow", () => {
  const model = flow(ctx, query());

  it("counts open PRs now and at the window's start, with their states and ages", () => {
    // At the start: the outsider's PR and the abandoned one.
    expect(model.open).toMatchObject({ now: 3, atStart: 2 });
    // Each merged PR is open from 10:00 the day before it merges, so some span a week's end.
    expect(model.open.series.map((p) => p.count)).toEqual([3, 3, 2, 1, 3]);
    expect(model.waiting).toEqual({ count: 1, oldestSince: at("08-01 10:00") });
    expect(model.approved).toEqual({ count: 1, oldestSince: at("10-02 10:00") });
    // 2.6 and 1.6 days old, then 63 days.
    expect(model.ages.map((a) => a.total)).toEqual([0, 2, 0, 0, 1, 0]);
    expect(model.ages[4]?.states).toEqual({ draft: 0, waiting: 1, in_review: 0, approved: 0 });
    expect(model.oldest.map((pr) => pr.createdAt)).toEqual([
      at("08-01 10:00"),
      at("09-30 10:00"),
      at("10-01 10:00"),
    ]);
  });

  it("counts a PR open from its creation until it merged or closed", () => {
    // The outsider's, the abandoned one (closes 10:00) and the one merging at 10:00.
    expect(openCount(facts, at("09-15 09:00"))).toBe(3);
    expect(openCount(facts, at("09-15 10:00"))).toBe(1);
  });
});

describe("compare", () => {
  const a = { start: "2026-08-01", end: "2026-09-01", label: "August 2026" };
  const b = { start: "2026-09-01", end: "2026-10-01", label: "September 2026" };

  it("puts every metric side by side, with the middle half where there are PRs enough", () => {
    const model = compare(ctx, {
      selection: EVERYTHING,
      contributors: "all",
      percentile: 0.5,
      a,
      b,
    });
    const row = (key: string) => model.rows.find((r) => r.key === key);
    expect(row("merged")).toMatchObject({ a: { value: 3 }, b: { value: 15 } });
    expect(row("cycle")?.middleB).toBeNull(); // P25 and P75 need 20 PRs
    expect(model.b).toMatchObject({ complete: true, covered: true });
  });
});

describe("prList", () => {
  const base = { selection: EVERYTHING, contributors: "all" as const, limit: 50 };

  it("sorts by a column, missing values last either way", () => {
    const rows = (dir: "asc" | "desc") =>
      prList(ctx, { ...base, set: "merged", filters: [], sort: { key: "pickup", dir } }).rows;
    expect(rows("desc").at(-1)?.pickupHours).toBeNull();
    expect(rows("asc").at(-1)?.pickupHours).toBeNull();
    expect(rows("asc")[0]?.pickupHours).not.toBeNull();
  });

  it("lists open PRs by state, by whom they wait on, and by age", () => {
    const openList = (filters: PrFilter[]) =>
      prList(ctx, { ...base, set: "open", filters, sort: { key: "age", dir: "desc" } }).total;
    expect(openList([])).toBe(3);
    expect(openList([{ kind: "state", state: "draft" }])).toBe(1);
    expect(openList([{ kind: "waiting", reviewer: "BOB" }])).toBe(1);
    expect(openList([{ kind: "age", band: "3mo" }])).toBe(1);
  });

  it("lists abandoned PRs by when they closed", () => {
    const window = overview(ctx, query()).window.current;
    expect(
      prList(ctx, {
        ...base,
        set: "abandoned",
        filters: [{ kind: "span", ...window }],
        sort: { key: "closed", dir: "desc" },
      }).total,
    ).toBe(1);
  });
});
