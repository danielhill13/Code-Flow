// @vitest-environment happy-dom
/** @jsxImportSource preact */
// Every tab, at every scope, window, statistic and contributors filter, plus PR lists and the
// side panel: no view may show "undefined", "NaN", "Infinity" or "[object Object]" (roadmap,
// phase 3), and the numbers it shows are core's.
import { options, render } from "preact";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { measure } from "../core/aggregate.ts";
import type { PrFact } from "../core/facts.ts";
import { formatValue } from "../core/format.ts";
import {
  attribute,
  type Groups,
  type Member,
  NO_GROUPS,
  NO_PRODUCT,
  NO_TEAM,
} from "../core/groups.ts";
import type { PrModel, Review } from "../core/model.ts";
import { parsePeriod } from "../core/periods.ts";
import { EVERYTHING, type Selection } from "../core/selection.ts";
import { EmbeddedSource, type ReportData } from "../core/source.ts";
import { at, bob, carol, deriveRules, prFact as fact } from "../testing/factories.ts";
import { App } from "./app.tsx";
import { DEFAULT_STATE, type ReportState, TABS, writeState } from "./state.ts";

const asOf = "2026-10-03T00:12:08.928Z";
const people = ["ana", "devon", "mika", "visitor"];
const repos = ["acme/api", "acme/web", "acme/scripts"];

const groups: Groups = {
  teams: [
    {
      name: "Platform",
      members: [member("ana"), member("devon", { to: "2026-08-15" })],
    },
    {
      name: "Web",
      members: [
        member("mika"),
        member("devon", { from: "2026-08-16" }),
        member("ana", { secondary: true }),
      ],
    },
  ],
  products: [
    { name: "Core", repos: ["acme/api"], teams: [] },
    { name: "Site", repos: ["acme/web"], teams: ["Web"] },
  ],
};

function member(login: string, extra: Partial<Member> = {}): Member {
  return { login, from: null, to: null, secondary: false, ...extra };
}

function facts(withGroups: Groups): PrFact[] {
  const rules = deriveRules({ attribute: (pr) => attribute(withGroups, pr) });
  const prFact = (overrides: Partial<PrModel>) => fact(overrides, rules);
  const out: PrFact[] = [];
  for (let i = 0; i < 90; i++) {
    const month = 7 + (i % 3);
    const day = 1 + ((i * 7) % 27);
    const pad = (n: number) => String(n).padStart(2, "0");
    const when = (d: number, h: number) => `${pad(month)}-${pad(Math.min(28, d))} ${pad(h)}:00`;
    const author = people[i % people.length] ?? "ana";
    const reviews: Review[] =
      i % 5 === 0
        ? []
        : [
            { author: i % 2 ? bob : carol, state: "commented", at: at(when(day + 1, 9)), body: "" },
            { author: bob, state: "approved", at: at(when(day + 2, 9)), body: "" },
          ];
    const base = {
      repo: repos[i % repos.length],
      author: { login: author, bot: false },
      authorAssociation: author === "visitor" ? "NONE" : "MEMBER",
      fromFork: author === "visitor",
      createdAt: at(when(day, 10)),
      commits: [
        {
          sha: `c${i}`,
          authoredAt: at(when(day, 8)),
          committedAt: at(when(day + 1, 12)),
          message: "x",
        },
      ],
      reviews,
      files: [{ path: "src/a.ts", additions: (i * 37) % 1200, deletions: i % 9 }],
    };
    if (i % 11 === 0) {
      out.push(
        prFact({
          ...base,
          state: "open",
          mergedAt: null,
          closedAt: null,
          mergedBy: null,
          draft: i % 2 === 0,
        }),
      );
    } else if (i % 13 === 0) {
      out.push(
        prFact({
          ...base,
          state: "closed",
          mergedAt: null,
          closedAt: at(when(day + 3, 10)),
          mergedBy: null,
        }),
      );
    } else {
      const merged = at(when(day + 3, 15));
      out.push(prFact({ ...base, mergedAt: merged, closedAt: merged, updatedAt: merged }));
    }
  }
  return out;
}

const withTeams: ReportData = {
  builtAt: asOf,
  asOf,
  coveredFrom: "2026-01-01",
  repos,
  groups,
  facts: facts(groups),
};
const withoutTeams: ReportData = { ...withTeams, groups: NO_GROUPS, facts: facts(NO_GROUPS) };

const BAD = /undefined|NaN|Infinity|\[object Object\]/;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
// Effects wait for an animation frame, which happy-dom spaces out: run them on the next tick.
options.requestAnimationFrame = (callback) => setTimeout(callback, 0);

/** Shows a view and waits until the page says it is that view, with its data loaded. */
async function show(state: Partial<ReportState>): Promise<string> {
  const hash = writeState({ ...DEFAULT_STATE, ...state });
  history.replaceState(null, "", hash);
  dispatchEvent(new HashChangeEvent("hashchange"));
  for (let i = 0; i < 200; i++) {
    const main = document.querySelector("main");
    if (main?.dataset.view === hash && main.dataset.ready === "true") {
      return document.body.textContent ?? "";
    }
    await tick();
  }
  throw new Error(`The report never showed ${hash}`);
}

describe.each([
  ["with teams", withTeams],
  ["without teams", withoutTeams],
])("the report, %s", (_, data) => {
  const root = document.createElement("div");
  beforeAll(async () => {
    document.body.append(root);
    render(<App source={new EmbeddedSource(data)} />, root);
    for (let i = 0; i < 4; i++) await tick();
  });
  afterAll(() => {
    render(null, root);
    root.remove();
  });

  const some = (selection: Partial<Selection>): Selection => ({ ...EVERYTHING, ...selection });
  const selections =
    data.groups.teams.length > 0
      ? [
          EVERYTHING,
          some({ team: ["Platform"] }),
          some({ team: ["Web"], repo: ["acme/web"] }),
          some({ team: [NO_TEAM] }),
          some({ product: ["Core"] }),
          some({ product: [NO_PRODUCT] }),
          some({ person: ["visitor"] }),
          some({ team: ["Platform", "Web"], person: ["ana", "mika"] }),
        ]
      : [EVERYTHING, some({ repo: ["acme/scripts"] }), some({ person: ["ana"] })];

  it("shows no broken values in any tab, scope, window, statistic or filter", async () => {
    for (const tab of TABS.map((t) => t.key)) {
      for (const selection of selections) {
        for (const window of ["30d", "60d", "90d", "ytd"] as const) {
          for (const percentile of [0.5, 0.75]) {
            for (const contributors of ["all", "internal", "external"] as const) {
              const text = await show({ tab, selection, window, percentile, contributors });
              const where = JSON.stringify({ tab, selection, window, percentile, contributors });
              expect(text, where).not.toMatch(BAD);
              expect(text, where).not.toContain("Loading");
            }
          }
        }
      }
    }
  });

  it("breaks down by each dimension the selection offers, with a row per value", async () => {
    if (data.groups.teams.length === 0) return;
    for (const tab of ["overview", "review"] as const) {
      for (const by of ["team", "product", "repo"] as const) {
        const text = await show({ tab, by });
        expect(text, `${tab} by ${by}`).not.toMatch(BAD);
        const rows = {
          team: ["Platform", "Web", NO_TEAM],
          product: ["Core", "Site", NO_PRODUCT],
          repo: repos,
        };
        for (const name of rows[by]) expect(text, `${tab} by ${by}`).toContain(name);
      }
    }
  });

  it("lists PRs by every set and opens each kind of PR in the side panel", async () => {
    for (const set of ["merged", "open", "abandoned"] as const) {
      const list = { ...DEFAULT_STATE.list, set };
      expect(await show({ tab: "prs", list })).not.toMatch(BAD);
    }
    for (const pr of data.facts.filter((_, i) => i % 6 === 0)) {
      const text = await show({ tab: "prs", pr: pr.id });
      expect(text, `#${pr.number}`).not.toMatch(BAD);
      expect(text).toContain("how codeflow read the pull request");
    }
  });

  it("shows core's own numbers: Compare's months match summary's", async () => {
    const text = await show({
      tab: "compare",
      compare: { grain: "month", a: "2026-08", b: "2026-09" },
    });
    const september = parsePeriod("2026-09");
    if (!september) throw new Error("unreachable");
    const result = measure(data.facts, september, { asOf: new Date(asOf) });
    for (const key of ["merged", "cycle", "reviewed"]) {
      const value = result.values.find((v) => v.key === key);
      if (!value) throw new Error(key);
      expect(text).toContain(formatValue(value));
    }
  });
});
