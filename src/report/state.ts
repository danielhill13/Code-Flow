// The report's state lives in the URL's hash, so any view (a tab, a selection, a filtered list, an
// open PR) can be shared as a link or printed. Theme is the one exception: it is the viewer's.

import type { OpenState } from "../core/facts.ts";
import {
  type Breakdown,
  CONTRIBUTORS,
  type Contributors,
  DIMENSIONS,
  EVERYTHING,
  type Selection,
} from "../core/selection.ts";
import {
  DEFAULT_SORT,
  PR_SETS,
  type PrColumn,
  type PrFilter,
  type PrSet,
  type PrSort,
} from "../core/views/prs.ts";
import { WINDOW_KEYS, type WindowKey } from "../core/windows.ts";

export type Tab = "overview" | "speed" | "review" | "flow" | "compare" | "prs" | "setup";

export const TABS: readonly { key: Tab; label: string; question: string }[] = [
  { key: "overview", label: "Overview", question: "Are we getting faster or slower?" },
  { key: "speed", label: "Speed", question: "Where does the time go?" },
  { key: "review", label: "Review", question: "Is review holding us up?" },
  { key: "flow", label: "Flow", question: "What's stuck right now?" },
  { key: "compare", label: "Compare", question: "Did the change work?" },
  { key: "prs", label: "Pull requests", question: "Which pull requests are behind this number?" },
  // Only where the report can save: under `codeflow serve` (decision D33).
  { key: "setup", label: "Setup", question: "Who is who, and what counts?" },
];

export type Grain = "month" | "quarter" | "year" | "custom";

export type CompareState = {
  grain: Grain;
  /** A period key ("2026-Q2") or, for custom, "YYYY-MM-DD..YYYY-MM-DD"; null for the default. */
  a: string | null;
  b: string | null;
};

/** The PR list's context: where the reader came from, and what narrows the list. */
export type ListState = {
  /** The trail shown above the list: "Speed › Pickup". Empty when opened directly. */
  from: string;
  set: PrSet;
  filters: PrFilter[];
  sort: PrSort;
};

export type ReportState = {
  tab: Tab;
  selection: Selection;
  /** What breakdowns are by; null for the default (selection.ts, defaultBreakdown). */
  by: Breakdown | null;
  window: WindowKey;
  percentile: number;
  contributors: Contributors;
  compare: CompareState;
  list: ListState;
  /** The PR open in the side panel, by id. */
  pr: string | null;
};

export const PERCENTILES = [0.5, 0.75] as const;

export const DEFAULT_STATE: ReportState = {
  tab: "overview",
  selection: EVERYTHING,
  by: null,
  window: "30d",
  percentile: 0.5,
  contributors: "all",
  compare: { grain: "quarter", a: null, b: null },
  list: { from: "", set: "merged", filters: [], sort: DEFAULT_SORT.merged },
  pr: null,
};

const SEP = "~";

export function readState(hash: string): ReportState {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const get = (key: string) => params.get(key);
  const tab = TABS.find((t) => t.key === get("tab"))?.key ?? DEFAULT_STATE.tab;
  const set = (PR_SETS as readonly string[]).includes(get("set") ?? "")
    ? (get("set") as PrSet)
    : DEFAULT_STATE.list.set;
  const percentile = Number(get("stat")?.replace(/^p/, "")) / 100;
  const grain = get("cmp") as Grain | null;
  return {
    tab,
    selection: {
      team: params.getAll("team"),
      group: params.getAll("group"),
      repo: params.getAll("repo"),
      person: params.getAll("person"),
    },
    by: readBreakdown(get("by")),
    window: (WINDOW_KEYS as readonly string[]).includes(get("w") ?? "")
      ? (get("w") as WindowKey)
      : DEFAULT_STATE.window,
    percentile: (PERCENTILES as readonly number[]).includes(percentile) ? percentile : 0.5,
    contributors: (CONTRIBUTORS as readonly string[]).includes(get("who") ?? "")
      ? (get("who") as Contributors)
      : DEFAULT_STATE.contributors,
    compare: {
      grain: grain && ["month", "quarter", "year", "custom"].includes(grain) ? grain : "quarter",
      a: get("a"),
      b: get("b"),
    },
    list: {
      from: get("from") ?? "",
      set,
      filters: params.getAll("f").flatMap((text) => readFilter(text)),
      sort: readSort(get("sort")) ?? DEFAULT_SORT[set],
    },
    pr: get("pr"),
  };
}

export function writeState(state: ReportState): string {
  const params = new URLSearchParams();
  if (state.tab !== DEFAULT_STATE.tab) params.set("tab", state.tab);
  for (const dimension of DIMENSIONS) {
    for (const value of state.selection[dimension]) params.append(dimension, value);
  }
  if (state.by !== null) params.set("by", state.by);
  if (state.window !== DEFAULT_STATE.window) params.set("w", state.window);
  if (state.percentile !== 0.5) params.set("stat", `p${Math.round(state.percentile * 100)}`);
  if (state.contributors !== "all") params.set("who", state.contributors);
  if (state.tab === "compare") {
    params.set("cmp", state.compare.grain);
    if (state.compare.a) params.set("a", state.compare.a);
    if (state.compare.b) params.set("b", state.compare.b);
  }
  if (state.tab === "prs") {
    if (state.list.from) params.set("from", state.list.from);
    params.set("set", state.list.set);
    for (const filter of state.list.filters) params.append("f", writeFilter(filter));
    params.set("sort", `${state.list.sort.dir === "desc" ? "-" : ""}${state.list.sort.key}`);
  }
  if (state.pr) params.set("pr", state.pr);
  return `#${params.toString()}`;
}

function writeFilter(filter: PrFilter): string {
  switch (filter.kind) {
    case "span":
      return ["span", filter.start, filter.end, filter.label].join(SEP);
    case "applies":
      return ["applies", filter.metric].join(SEP);
    case "is":
      return ["is", filter.metric, filter.value ? "1" : "0"].join(SEP);
    case "size":
      return ["size", filter.band].join(SEP);
    case "age":
      return ["age", filter.band].join(SEP);
    case "state":
      return ["state", filter.state].join(SEP);
    case "waiting":
      return ["waiting", filter.reviewer].join(SEP);
  }
}

/** A filter from the URL, or nothing for one that can't be read: links outlive versions. */
function readFilter(text: string): PrFilter[] {
  const [kind, a = "", b = "", c = ""] = text.split(SEP);
  switch (kind) {
    case "span":
      return a && b ? [{ kind, start: a, end: b, label: c || `${a} – ${b}` }] : [];
    case "applies":
      return a ? [{ kind, metric: a }] : [];
    case "is":
      return a ? [{ kind, metric: a, value: b === "1" }] : [];
    case "size":
      return ["xs", "s", "m", "l", "xl"].includes(a) ? [{ kind, band: a as "xs" }] : [];
    case "age":
      return a ? [{ kind, band: a }] : [];
    case "state":
      return ["draft", "waiting", "in_review", "approved"].includes(a)
        ? [{ kind, state: a as OpenState }]
        : [];
    case "waiting":
      return a ? [{ kind, reviewer: a }] : [];
    default:
      return [];
  }
}

const SORTABLE: readonly PrColumn[] = [
  "number",
  "title",
  "author",
  "merged",
  "closed",
  "age",
  "cycle",
  "coding",
  "pickup",
  "review",
  "mergeWait",
  "timeToApproval",
  "size",
  "reviews",
  "state",
];

function readSort(text: string | null): PrSort | null {
  if (!text) return null;
  const desc = text.startsWith("-");
  const key = (desc ? text.slice(1) : text) as PrColumn;
  return SORTABLE.includes(key) ? { key, dir: desc ? "desc" : "asc" } : null;
}

/** "team", "repo" or "group:<kind>"; anything else is no breakdown chosen. */
function readBreakdown(text: string | null): Breakdown | null {
  if (text === "team" || text === "repo") return text;
  return text?.startsWith("group:") && text.length > "group:".length ? (text as Breakdown) : null;
}
