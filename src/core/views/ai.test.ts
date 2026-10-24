import { describe, expect, it } from "vitest";
import { bob, deriveRules, prFact } from "../../testing/factories.ts";
import type { PrFact } from "../facts.ts";
import type { PrModel } from "../model.ts";
import { choices, EVERYTHING } from "../selection.ts";
import { ai } from "./ai.ts";
import type { ViewContext } from "./context.ts";
import { prList } from "./prs.ts";

// The 30-day window is Sep 3 – Oct 3; the one before it Aug 4 – Sep 3.
const asOf = new Date("2026-10-03T00:00:00Z");
// Bot PRs count, as an org's do by default (bots.include_prs).
const rules = deriveRules({
  prRules: (pr) => ({
    count: pr.authorBot ? true : null,
    countRule: null,
    internal: null,
    ignore: [],
    applied: [],
  }),
});

/** A PR merged on `day` ("09-10") into main, reviewed, by `who`. */
function merged(day: string, who: string, overrides: Partial<PrModel> = {}): PrFact {
  const [month, date] = day.split("-").map(Number) as [number, number];
  const shift = (days: number) =>
    new Date(Date.UTC(2026, month - 1, date - days, 10)).toISOString().replace(".000Z", "Z");
  return prFact(
    {
      author: { login: who, bot: false },
      createdAt: shift(1),
      mergedAt: shift(0),
      closedAt: shift(0),
      updatedAt: shift(0),
      commits: [
        { sha: `c${day}${who}`, authoredAt: shift(2), committedAt: shift(2), message: "x" },
      ],
      reviews: [{ author: bob, state: "approved", at: shift(0), body: "" }],
      ...overrides,
    },
    rules,
  );
}

const thoughts = { files: [{ path: "thoughts/plan.md", additions: 3, deletions: 0 }] };
const signed = { body: "🤖 Generated with [Claude Code](https://claude.com/claude-code)" };

const facts: PrFact[] = [
  // In the window: alice uses AI on 3 of 4 (one with two markers), dana on none, an agent opens one.
  merged("09-10", "alice", thoughts),
  merged("09-11", "alice", { ...thoughts, ...signed }),
  merged("09-12", "alice", { ...signed, repo: "acme/web" }),
  merged("09-13", "alice"),
  merged("09-14", "dana"),
  merged("09-15", "dana", { repo: "acme/web" }),
  merged("09-16", "copilot-swe-agent", {
    author: { login: "copilot-swe-agent[bot]", bot: true },
    headBranch: "copilot/fix-docs",
  }),
  // The window before: one of two.
  merged("08-20", "alice", signed),
  merged("08-21", "dana"),
  // May: none.
  merged("05-12", "dana"),
];

const ctx: ViewContext = {
  facts,
  choices: choices({ people: [], teams: [], groups: [] }, ["acme/api", "acme/web"], facts),
  asOf,
  coveredFrom: "2026-04-01",
  staleAfterDays: 90,
  peopleViews: true,
  churnDays: 30,
  sizeTargetLines: 400,
};
const model = ai(ctx, {
  selection: EVERYTHING,
  by: null,
  contributors: "all",
  window: "30d",
  percentile: 0.5,
});

describe("AI insights", () => {
  it("gives the share of merged PRs with a marker, against the window before [rule 20]", () => {
    // 4 of 7 merged in the window (the agent's PR counts: bot PRs count by default).
    expect(model.share.value.value).toBeCloseTo(4 / 7);
    expect(model.share.previous?.value).toBeCloseTo(1 / 2);
    expect(model.assisted).toEqual({ value: 4, previous: 1 });
  });

  it("counts the people with an AI-assisted PR, leaving bots out [rule 20]", () => {
    expect(model.people).toMatchObject({ people: 2, using: 1, share: 0.5 });
    expect(model.people.previous).toEqual({ people: 2, using: 1, share: 0.5 });
  });

  it("counts each marker, the PRs it alone marks, and PRs by how many they show", () => {
    const row = (marker: string) => model.markers.find((m) => m.marker === marker);
    expect(row("thoughts")).toEqual({ marker: "thoughts", prs: 2, only: 1 });
    expect(row("signature")).toEqual({ marker: "signature", prs: 2, only: 1 });
    expect(row("agentAuthor")).toEqual({ marker: "agentAuthor", prs: 1, only: 0 });
    expect(model.markers.some((m) => m.marker === "custom")).toBe(false);
    expect(model.depth).toEqual([
      { markers: 0, prs: 3 },
      { markers: 1, prs: 2 },
      { markers: 2, prs: 2 },
      { markers: 3, prs: 0 },
    ]);
    expect(model.tools).toEqual([
      { tool: "Claude", prs: 2 },
      { tool: "Copilot", prs: 1 },
    ]);
  });

  it("shows each repo's share month by month, null before the data", () => {
    const months = model.adoption.months.map((m) => m.short);
    expect(months).toEqual(
      ["Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct"].slice(-months.length),
    );
    const sep = model.adoption.months.findIndex((m) => m.short === "Sep");
    const api = model.adoption.rows.find((r) => r.repo === "acme/api");
    expect(api?.cells[sep]).toEqual({ merged: 5, ai: 3, share: 0.6 });
    const web = model.adoption.rows.find((r) => r.repo === "acme/web");
    expect(web?.cells[sep]).toEqual({ merged: 2, ai: 1, share: 0.5 });
    expect(model.adoption.total[sep]).toEqual({ merged: 7, ai: 4, share: 4 / 7 });
    // Before the data starts (April), a month is null, not 0%.
    const mar = model.adoption.months.findIndex((m) => m.short === "Mar");
    if (mar >= 0) expect(model.adoption.total[mar]).toBeNull();
    expect(model.adoption.rows[0]?.repo).toBe("acme/api");
  });

  it("weighs each metric for AI-assisted PRs and the rest, in the window and the one before", () => {
    expect(model.impact.periods.map((p) => p.label)).toEqual([
      "the previous 30 days",
      "last 30 days",
    ]);
    const mergedRow = model.impact.rows.find((r) => r.key === "merged");
    expect(mergedRow?.cells.map((c) => [c.ai.value, c.none.value])).toEqual([
      [1, 1],
      [4, 3],
    ]);
    const cycle = model.impact.rows.find((r) => r.key === "cycle");
    expect(cycle?.cells[1]?.ai.n).toBe(4);
  });

  it("compares the periods the reader picks, oldest first", () => {
    const picked = ai(ctx, {
      selection: EVERYTHING,
      by: null,
      contributors: "all",
      window: "30d",
      percentile: 0.5,
      periods: ["2026-09", "2026-05"],
    });
    expect(picked.impact.periods.map((p) => p.label)).toEqual(["May 2026", "September 2026"]);
  });

  it("lists the PRs behind each marker, and those with none", () => {
    const list = (marker: "any" | "none" | "thoughts") =>
      prList(ctx, {
        selection: EVERYTHING,
        contributors: "all",
        set: "merged",
        filters: [{ kind: "ai", marker }],
        periods: ["30d"],
        sort: { key: "ai", dir: "desc" },
        limit: 50,
      });
    expect(list("any").total).toBe(4);
    expect(list("none").total).toBe(3);
    expect(list("thoughts").total).toBe(2);
    expect(list("any").rows[0]?.ai).toHaveLength(2);
  });
});
