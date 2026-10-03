import { useCallback, useEffect, useState } from "preact/hooks";
import { statLabel } from "../core/format.ts";
import {
  breakdowns,
  type Choices,
  type Contributors,
  type Dimension,
  defaultBreakdown,
  selectionName,
  validSelection,
} from "../core/selection.ts";
import type { DataSource, Meta } from "../core/source.ts";
import type { ViewQuery } from "../core/views/context.ts";
import { DEFAULT_SORT, type PrSet } from "../core/views/prs.ts";
import { grainOf, type WindowKey, windowOf } from "../core/windows.ts";
import { Drawer } from "./drawer.tsx";
import { tabHref } from "./links.ts";
import { SelectionBar } from "./selector.tsx";
import { type ReportState, readState, TABS, writeState } from "./state.ts";
import { Compare, CompareControls, comparePick } from "./tabs/compare.tsx";
import { Flow } from "./tabs/flow.tsx";
import { Overview } from "./tabs/overview.tsx";
import { PullRequests } from "./tabs/prs.tsx";
import { Review } from "./tabs/review.tsx";
import { Speed } from "./tabs/speed.tsx";
import { type BreakdownChoice, Segmented, when } from "./ui.tsx";

const WINDOWS: readonly { value: WindowKey; label: string }[] = [
  { value: "30d", label: "30 d" },
  { value: "60d", label: "60 d" },
  { value: "90d", label: "90 d" },
  { value: "ytd", label: "YTD" },
];

const STATISTICS: readonly { value: number; label: string }[] = [
  { value: 0.5, label: "Median" },
  { value: 0.75, label: "P75" },
];

const WHO: readonly { value: Contributors; label: string }[] = [
  { value: "all", label: "All" },
  { value: "internal", label: "Internal" },
  { value: "external", label: "External" },
];

const PAGE = 50;

export function App(props: { source: DataSource }) {
  const meta = useAsync(() => props.source.meta(), "meta");
  if (!meta) return <p class="wrap">Loading…</p>;
  return <Report source={props.source} meta={meta} />;
}

function Report({ source, meta }: { source: DataSource; meta: Meta }) {
  const [state, setState] = useHashState(meta.choices);
  const [theme, setTheme] = useTheme();
  const [limit, setLimit] = useState(PAGE);
  const asOf = new Date(meta.asOf);
  const query: ViewQuery = {
    selection: state.selection,
    by: breakdownOf(meta.choices, state),
    contributors: state.contributors,
    window: state.window,
    percentile: state.percentile,
  };
  const pick = comparePick(state.compare, meta.coveredFrom, asOf);
  const listKey = JSON.stringify([state.selection, state.contributors, state.list]);
  useEffect(() => setLimit(PAGE), [listKey]);

  const key = JSON.stringify([
    state.tab,
    query,
    state.tab === "compare" ? [pick.a, pick.b] : null,
    state.tab === "prs" ? [state.list, limit] : null,
  ]);
  const loaded = useAsync(async () => ({ key, model: await loadModel() }), key);
  // A model loaded for another tab or query is never shown under this one.
  const model = loaded?.key === key ? loaded.model : undefined;
  function loadModel(): Promise<unknown> {
    switch (state.tab) {
      case "overview":
        return source.overview(query);
      case "speed":
        return source.speed(query);
      case "review":
        return source.review(query);
      case "flow":
        return source.flow(query);
      case "compare":
        return pick.a && pick.b
          ? source.compare({ ...query, a: pick.a, b: pick.b })
          : Promise.resolve(null);
      case "prs":
        return source.prs({
          selection: state.selection,
          contributors: state.contributors,
          set: state.list.set,
          filters: state.list.filters,
          sort: state.list.sort,
          limit,
        });
    }
  }
  const opened = useAsync(
    () => (state.pr ? source.pr(state.pr) : Promise.resolve(null)),
    `pr:${state.pr}`,
  );
  const drawer = opened && opened.id === state.pr ? opened : null;
  const closeDrawer = useCallback(() => setState((s) => ({ ...s, pr: null })), [setState]);
  const update = (patch: Partial<ReportState>) => setState((s) => ({ ...s, ...patch }));

  const question = TABS.find((t) => t.key === state.tab)?.question ?? "";
  const window = windowOf(state.window, asOf);
  const unit = grainOf(window) === "month" ? "monthly" : "weekly";
  const who =
    state.contributors === "all"
      ? ""
      : state.contributors === "internal"
        ? " · internal contributors"
        : " · outside contributors";
  const name = selectionName(meta.choices, state.selection);
  const subline =
    state.tab === "compare"
      ? "two calendar periods"
      : state.tab === "flow"
        ? `open as of ${when(meta.asOf)}`
        : state.tab === "prs"
          ? "the evidence behind every number"
          : `${window.current.label}, compared with ${window.previous.label}`;
  const note =
    state.tab === "compare"
      ? "Calendar periods · choose A and B below"
      : state.tab === "flow"
        ? `Open PRs as of ${when(meta.asOf)} · the window applies to trends and abandoned only`
        : state.tab === "prs"
          ? ""
          : `vs ${window.previous.label} · ${unit} points`;

  return (
    <>
      <header class="header">
        <div class="wrap bar-row">
          <span class="logo">codeflow</span>
          <span class="divider" />
          <SelectionBar choices={meta.choices} state={state} />
          <div class="header-right">
            <span class="through">Data through {when(meta.asOf)}</span>
            <Segmented
              label="Theme"
              hideLabel
              small
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
              value={theme}
              onChange={setTheme}
            />
            <button type="button" class="button" onClick={() => print()}>
              Print
            </button>
          </div>
        </div>
        <nav class="wrap tabs" aria-label="Tabs">
          {TABS.map((t) => (
            <a
              key={t.key}
              href={tabHref(state, t.key)}
              class={t.key === state.tab ? "current" : undefined}
              aria-current={t.key === state.tab ? "page" : undefined}
            >
              {t.label}
            </a>
          ))}
        </nav>
      </header>

      <div class="controls">
        <div class="wrap">
          {state.tab !== "compare" && state.tab !== "prs" && (
            <Segmented
              label="Window"
              options={WINDOWS}
              value={state.window}
              onChange={(w) => update({ window: w })}
            />
          )}
          <Segmented
            label="Statistic"
            options={STATISTICS}
            value={state.percentile}
            onChange={(p) => update({ percentile: p })}
          />
          <Segmented
            label="Contributors"
            options={WHO}
            value={state.contributors}
            onChange={(c) => update({ contributors: c })}
          />
          {note && <span class="controls-note">{note}</span>}
        </div>
      </div>

      <main
        class={`wrap${state.tab === "compare" ? " compare-page" : ""}`}
        // Which view this is, and whether its data has arrived: for tests and anyone automating.
        data-view={writeState(state)}
        data-ready={loaded?.key === key && (!state.pr || drawer !== null) ? "true" : "false"}
      >
        <p class="print-only">
          codeflow · {name}
          {who} ·{" "}
          {state.tab === "compare" || state.tab === "prs" ? "" : `${window.current.label} · `}
          data through {when(meta.asOf)} · {statLabel(state.percentile)}
        </p>
        <div class="heading">
          <h1>{question}</h1>
          <p>
            {name}
            {who} · {subline}
          </p>
        </div>
        {state.tab === "compare" && (
          <CompareControls
            state={state}
            pick={pick}
            asOf={asOf}
            onChange={(compare) => update({ compare })}
          />
        )}
        {model ? (
          <Body
            tab={state.tab}
            model={model}
            state={state}
            meta={meta}
            asOf={asOf}
            breakdown={{
              offered: breakdowns(meta.choices, state.selection),
              onChange: (by) => update({ by }),
            }}
            onList={(list) => update({ list })}
            onSet={(set: PrSet) =>
              update({
                list: {
                  from: "",
                  set,
                  filters: set === "open" ? [] : [{ kind: "span", ...window.current }],
                  sort: DEFAULT_SORT[set],
                },
              })
            }
            onMore={() => setLimit((n) => n + PAGE)}
          />
        ) : state.tab === "compare" ? (
          <p class="muted">
            The data doesn't cover two periods of this kind yet. Try a shorter one, or custom dates.
          </p>
        ) : (
          <p class="muted">Loading…</p>
        )}
      </main>

      {state.pr && drawer && <Drawer pr={drawer} asOf={asOf} onClose={closeDrawer} />}
    </>
  );
}

function Body(props: {
  tab: ReportState["tab"];
  model: unknown;
  state: ReportState;
  meta: Meta;
  asOf: Date;
  onList: (list: ReportState["list"]) => void;
  onSet: (set: PrSet) => void;
  onMore: () => void;
  breakdown: BreakdownChoice;
}) {
  const { model, state, asOf } = props;
  // The model is the one the tab asked for: useAsync keys it by tab and query.
  switch (props.tab) {
    case "overview":
      return (
        <Overview
          model={model as Parameters<typeof Overview>[0]["model"]}
          state={state}
          breakdown={props.breakdown}
        />
      );
    case "speed":
      return <Speed model={model as Parameters<typeof Speed>[0]["model"]} state={state} />;
    case "review":
      return (
        <Review
          model={model as Parameters<typeof Review>[0]["model"]}
          state={state}
          breakdown={props.breakdown}
        />
      );
    case "flow":
      return (
        <Flow model={model as Parameters<typeof Flow>[0]["model"]} state={state} asOf={asOf} />
      );
    case "compare":
      return <Compare model={model as Parameters<typeof Compare>[0]["model"]} state={state} />;
    case "prs":
      return (
        <PullRequests
          model={model as Parameters<typeof PullRequests>[0]["model"]}
          state={state}
          asOf={asOf}
          onList={props.onList}
          onSet={props.onSet}
          onMore={props.onMore}
        />
      );
  }
}

/** The breakdown asked for, if the selection offers it, or else the selection's default. */
function breakdownOf(choices: Choices, state: ReportState): Dimension | null {
  const offered = breakdowns(choices, state.selection);
  return state.by !== null && offered.includes(state.by)
    ? state.by
    : defaultBreakdown(choices, state.selection);
}

/** The state in the URL. Links change it by navigating; controls replace it in place. */
function useHashState(
  choices: Choices,
): [ReportState, (update: (s: ReportState) => ReportState) => void] {
  const read = () => {
    const state = readState(location.hash);
    return { ...state, selection: validSelection(choices, state.selection) };
  };
  const [state, setState] = useState<ReportState>(read);
  useEffect(() => {
    const onHash = () => {
      setState(read());
      scrollTo(0, 0);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const update = useCallback((change: (s: ReportState) => ReportState) => {
    setState((current) => {
      const next = change(current);
      history.replaceState(null, "", writeState(next));
      return next;
    });
  }, []);
  return [state, update];
}

type Theme = "light" | "dark";

/** Light or dark: the system's choice until the viewer picks one, which this browser remembers. */
function useTheme(): [Theme, (theme: Theme) => void] {
  const system = (): Theme =>
    matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem("codeflow-theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      // Storage can be blocked; the system's choice will do.
    }
    return system();
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const choose = (next: Theme) => {
    setTheme(next);
    try {
      localStorage.setItem("codeflow-theme", next);
    } catch {
      // Not remembered, then.
    }
  };
  return [theme, choose];
}

/**
 * The value of a promise, loaded again whenever `key` changes. The last value stays until the
 * next one arrives, so switching views doesn't flash empty.
 */
function useAsync<T>(load: () => Promise<T>, key: string): T | undefined {
  const [state, setState] = useState<{ key: string; value: T } | undefined>(undefined);
  useEffect(() => {
    let live = true;
    load().then((value) => {
      if (live) setState({ key, value });
    });
    return () => {
      live = false;
    };
  }, [key]);
  return state?.value;
}
