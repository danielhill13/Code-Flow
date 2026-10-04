import { describe, expect, it } from "vitest";
import { statLabel } from "../core/format.ts";
import {
  DEFAULT_STATE,
  PERCENTILES,
  type ReportState,
  readState,
  TABS,
  writeState,
} from "./state.ts";

const views: ReportState[] = [
  DEFAULT_STATE,
  {
    ...DEFAULT_STATE,
    tab: "review",
    selection: { team: ["Platform", "Web"], group: ["Core"], repo: ["acme/api"], person: ["ana"] },
    by: "group:product",
    window: "90d",
    percentile: 0.75,
    contributors: "external",
  },
  {
    ...DEFAULT_STATE,
    tab: "compare",
    compare: { grain: "custom", a: "2026-01-01..2026-03-31", b: "2026-04-01..2026-06-30" },
  },
  {
    ...DEFAULT_STATE,
    tab: "prs",
    list: {
      from: "Speed › Pickup",
      set: "open",
      filters: [
        { kind: "span", start: "2026-09-01", end: "2026-10-01", label: "September 2026" },
        { kind: "applies", metric: "pickup" },
        { kind: "is", metric: "reverted", value: true },
        { kind: "size", band: "xl" },
        { kind: "age", band: "8-30" },
        { kind: "state", state: "waiting" },
        { kind: "waiting", reviewer: "devon" },
      ],
      sort: { key: "age", dir: "desc" },
    },
    pr: "PR_kwDO123",
  },
  { ...DEFAULT_STATE, tab: "setup" },
];

describe("the report's URL", () => {
  it("captures the whole view, so a link or a reload shows the same thing [rule 11]", () => {
    for (const view of views) expect(readState(writeState(view))).toEqual(view);
  });

  it("keeps names that need escaping, such as a team with spaces and an ampersand", () => {
    const view = {
      ...DEFAULT_STATE,
      selection: { ...DEFAULT_STATE.selection, team: ["R&D / Mobile", "No team"] },
    };
    expect(readState(writeState(view))).toEqual(view);
  });

  it("reads a link from an older or hand-edited URL as the nearest valid view", () => {
    const state = readState("#tab=nope&w=45d&stat=p33&who=robots&set=x&sort=-x&f=size~huge&by=z");
    expect(state.tab).toBe(DEFAULT_STATE.tab);
    expect(state.window).toBe(DEFAULT_STATE.window);
    expect(state.percentile).toBe(0.5);
    expect(state.contributors).toBe("all");
    expect(state.list.filters).toEqual([]);
    expect(state.by).toBeNull();
  });

  it("names every tab once", () => {
    const keys = TABS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("statistic labels", () => {
  it("come from one function: median for P50, P75 otherwise [rule 11]", () => {
    expect(statLabel(0.5)).toBe("median");
    expect(PERCENTILES.map(statLabel)).toEqual(["median", "P75"]);
    expect(statLabel(0.9)).toBe("P90");
  });
});
