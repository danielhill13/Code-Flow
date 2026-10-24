import { useCallback, useEffect, useState } from "preact/hooks";
import { everyMs } from "../core/every.ts";
import { statLabel } from "../core/format.ts";
import { DEFAULT_CHURN_DAYS } from "../core/metrics.ts";
import {
  type Breakdown,
  breakdowns,
  type Choices,
  type Contributors,
  defaultBreakdown,
  selectionName,
  validSelection,
} from "../core/selection.ts";
import type { DataSource, Meta } from "../core/source.ts";
import type { ViewQuery } from "../core/views/context.ts";
import { DEFAULT_SORT, type PrSet } from "../core/views/prs.ts";
import { grainOf, windowOf } from "../core/windows.ts";
import type { AdminApi, SyncStatus } from "./admin/api.ts";
import { Setup } from "./admin/setup.tsx";
import { Drawer } from "./drawer.tsx";
import { tabHref } from "./links.ts";
import { SelectionBar } from "./selector.tsx";
import {
  ESSENTIAL_TABS,
  listPeriods,
  type Mode,
  type ReportState,
  readState,
  TABS,
  type Tab,
  writeState,
} from "./state.ts";
import { AiInsights } from "./tabs/ai.tsx";
import { Compare, CompareControls, comparePick } from "./tabs/compare.tsx";
import { Flow } from "./tabs/flow.tsx";
import { Overview } from "./tabs/overview.tsx";
import { PullRequests } from "./tabs/prs.tsx";
import { Review } from "./tabs/review.tsx";
import { Speed } from "./tabs/speed.tsx";
import { type BreakdownChoice, capital, Segmented, when } from "./ui.tsx";
import { FirstSync } from "./welcome.tsx";
import { PeriodsMenu, WindowMenu } from "./window-menu.tsx";

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

/**
 * The report. Static, it reads the data `codeflow build` embedded. Served by `codeflow serve`, it
 * also gets the server's orgs, to switch between, and `admin`, to edit the org's setup with.
 */
export function App(props: { source: DataSource; admin?: AdminApi; orgs?: readonly string[] }) {
  const { source, admin } = props;
  // Bumped after each save, so the report is read again under the new setup.
  const [revision, setRevision] = useState(0);
  const loaded = useAsync(
    () =>
      source.meta().then(
        (meta): Meta | null => meta,
        (error: unknown) => {
          // A served org that hasn't synced yet can still be set up.
          if (admin) return null;
          throw error;
        },
      ),
    `meta:${revision}`,
  );
  const shell = { admin, orgs: props.orgs, onSaved: () => setRevision((r) => r + 1) };
  // Served, the data can change under the page: a scheduled sync. Check every minute, and when
  // a sync has finished, read the report again, so the view in front of the reader is current.
  const status = useSyncStatus(admin, () => setRevision((r) => r + 1));
  if (loaded === undefined) return <p class="wrap">Loading…</p>;
  if (loaded === null && admin) return <Unsynced {...shell} admin={admin} status={status} />;
  if (loaded === null) return null;
  return <Report source={source} meta={loaded} revision={revision} status={status} {...shell} />;
}

type Shell = {
  admin?: AdminApi;
  orgs?: readonly string[];
  onSaved: () => void;
  status?: SyncStatus | null;
};

function Report({
  source,
  meta,
  revision,
  admin,
  orgs,
  onSaved,
  status,
}: Shell & { source: DataSource; meta: Meta; revision: number }) {
  const [state, setState] = useHashState(meta.choices, admin !== undefined);
  const essential = state.mode === "essential";
  // What the tabs read: in essential mode, the median of everyone's PRs, whatever the link said.
  const shown: ReportState = essential ? { ...state, percentile: 0.5, contributors: "all" } : state;
  const [theme, setTheme] = useTheme();
  const [limit, setLimit] = useState(PAGE);
  const asOf = new Date(meta.asOf);
  const query: ViewQuery = {
    selection: state.selection,
    by: breakdownOf(meta.choices, state),
    // Essential mode reads the median of everyone's PRs: its controls aren't offered.
    contributors: essential ? "all" : state.contributors,
    window: state.window,
    percentile: essential ? 0.5 : state.percentile,
  };
  const pick = comparePick(state.compare, meta.coveredFrom, asOf);
  // The columns only change what is shown, not which PRs: they don't reload the list, close the
  // table under the reader, or start it again from the first page.
  const { columns: _shown, ...listData } = state.list;
  const listKey = JSON.stringify([state.selection, state.contributors, listData]);
  useEffect(() => setLimit(PAGE), [listKey]);

  const key = JSON.stringify([
    revision,
    state.tab,
    query,
    state.tab === "compare" ? [pick.a, pick.b] : null,
    state.tab === "prs" ? [listData, limit] : null,
    state.tab === "ai" ? state.aiPeriods : null,
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
      case "ai":
        return source.ai({ ...query, periods: state.aiPeriods });
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
          periods: listPeriods(state),
          sort: state.list.sort,
          limit,
        });
      case "setup":
        return Promise.resolve(null);
    }
  }
  const opened = useAsync(
    () => (state.pr ? source.pr(state.pr) : Promise.resolve(null)),
    `pr:${state.pr}:${revision}`,
  );
  const drawer = opened && opened.id === state.pr ? opened : null;
  const closeDrawer = useCallback(() => setState((s) => ({ ...s, pr: null })), [setState]);
  const update = (patch: Partial<ReportState>) => setState((s) => ({ ...s, ...patch }));

  const question = TABS.find((t) => t.key === state.tab)?.question ?? "";
  const window = windowOf(state.window, asOf);
  const unit = grainOf(window) === "month" ? "monthly" : "weekly";
  const who =
    shown.contributors === "all"
      ? ""
      : shown.contributors === "internal"
        ? " · internal contributors"
        : " · outside contributors";
  const name = selectionName(meta.choices, state.selection);
  const subline =
    state.tab === "setup"
      ? `what ${admin?.org ?? ""} measures, who is who, and what counts`
      : state.tab === "compare"
        ? "two calendar periods"
        : state.tab === "flow"
          ? `open as of ${when(meta.asOf)}`
          : state.tab === "prs"
            ? "the evidence behind every number"
            : state.tab === "ai"
              ? `${window.current.label}, by the traces AI tools leave`
              : `${window.current.label}, compared with ${window.previous.label}`;
  const note =
    state.tab === "setup"
      ? ""
      : state.tab === "compare"
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
          {admin ? (
            <OrgPicker current={admin.org} orgs={orgs ?? [admin.org]} />
          ) : (
            meta.org && <span class="org-name">{meta.org}</span>
          )}
          <span class="divider" />
          {state.tab !== "setup" && <SelectionBar choices={meta.choices} state={state} />}
          <div class="header-right">
            <Freshness asOf={meta.asOf} status={status ?? null} />
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
          {tabsFor(admin, state.mode).map((t) => (
            <a
              key={t.key}
              href={tabHref(state, t.key)}
              class={t.key === state.tab ? "current" : undefined}
              aria-current={t.key === state.tab ? "page" : undefined}
            >
              {t.label}
            </a>
          ))}
          <span class="tabs-end">
            <Segmented
              label="Detail"
              hideLabel
              small
              options={MODES}
              value={state.mode}
              onChange={(mode) => {
                rememberMode(mode);
                update({ mode, tab: tabIn(mode, state.tab) });
              }}
            />
          </span>
        </nav>
      </header>

      <div class="controls" hidden={state.tab === "setup"}>
        <div class="wrap">
          {state.tab !== "compare" && state.tab !== "prs" && (
            <WindowMenu
              value={state.window}
              from={meta.coveredFrom}
              asOf={asOf}
              onChange={(w) => update({ window: w })}
            />
          )}
          {state.tab === "prs" &&
            (listPeriods(state).length > 0 &&
            (state.list.set === "merged" || state.list.set === "abandoned") ? (
              <PeriodsMenu
                value={listPeriods(state)}
                from={meta.coveredFrom}
                asOf={asOf}
                onChange={(periods) => update({ list: { ...state.list, periods } })}
              />
            ) : (
              <span class="controls-note">
                {listPeriods(state).length === 0
                  ? "The span you opened this list from. Remove its filter to choose periods."
                  : "Open and stale PRs are as of now."}
              </span>
            ))}
          {!essential && (
            <>
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
            </>
          )}
          {note && <span class="controls-note">{essential ? `Medians · ${note}` : note}</span>}
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
          data through {when(meta.asOf)} · {statLabel(shown.percentile)}
        </p>
        <div class="heading">
          <h1>{question}</h1>
          <p>
            {state.tab === "setup" ? (
              capital(subline)
            ) : (
              <>
                {name}
                {who} · {subline}
              </>
            )}
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
        {state.tab === "setup" && admin ? (
          <Setup api={admin} meta={meta} onSaved={onSaved} />
        ) : model ? (
          <Body
            tab={state.tab}
            model={model}
            state={shown}
            meta={meta}
            asOf={asOf}
            name={name}
            breakdown={{
              offered: breakdowns(meta.choices, state.selection),
              current: query.by,
              onChange: (by) => update({ by }),
            }}
            onList={(list) => update({ list })}
            onSet={(set: PrSet) =>
              // A new set starts clean: no trail, no filters, the columns it opens with. Its
              // periods stay, as what the reader chose to look at.
              update({
                list: {
                  ...state.list,
                  from: "",
                  set,
                  filters: [],
                  columns: null,
                  sort: DEFAULT_SORT[set],
                },
              })
            }
            onMore={() => setLimit((n) => n + PAGE)}
            onAiPeriods={(aiPeriods) => update({ aiPeriods })}
          />
        ) : state.tab === "compare" ? (
          <p class="muted">
            The data doesn't cover two periods of this kind yet. Try a shorter one, or custom dates.
          </p>
        ) : (
          <p class="muted">Loading…</p>
        )}
      </main>

      {state.pr && drawer && (
        <Drawer
          pr={drawer}
          asOf={asOf}
          staleAfterDays={meta.settings.staleAfterDays}
          churnDays={meta.settings.churnDays ?? DEFAULT_CHURN_DAYS}
          onClose={closeDrawer}
        />
      )}
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
  onAiPeriods: (periods: ReportState["aiPeriods"]) => void;
  breakdown: BreakdownChoice;
  name: string;
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
          name={props.name}
          essential={state.mode === "essential"}
        />
      );
    case "ai":
      return (
        <AiInsights
          model={model as Parameters<typeof AiInsights>[0]["model"]}
          state={state}
          from={props.meta.coveredFrom}
          asOf={asOf}
          essential={state.mode === "essential"}
          onPeriods={props.onAiPeriods}
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
          name={props.name}
        />
      );
    case "flow":
      return (
        <Flow model={model as Parameters<typeof Flow>[0]["model"]} state={state} asOf={asOf} />
      );
    case "compare":
      return <Compare model={model as Parameters<typeof Compare>[0]["model"]} state={state} />;
    case "setup":
      return null;
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

/** An org that hasn't synced yet, under `codeflow serve`: only its setup, to get it ready. */
function Unsynced({ admin, orgs, onSaved, status }: Shell & { admin: AdminApi }) {
  const [started, setStarted] = useState(false);
  useTheme();
  return (
    <>
      <header class="header">
        <div class="wrap bar-row">
          <span class="logo">codeflow</span>
          <OrgPicker current={admin.org} orgs={orgs ?? [admin.org]} />
          <div class="header-right">
            {status?.running && <span class="through">Syncing now…</span>}
          </div>
        </div>
        <nav class="wrap tabs" aria-label="Tabs">
          <a href="#tab=setup" class="current" aria-current="page">
            Setup
          </a>
        </nav>
      </header>
      <main class="wrap" data-view="#tab=setup" data-ready="true">
        <div class="heading">
          <h1>Nothing synced yet</h1>
          <p>
            The report appears here once {admin.org}'s pull requests are fetched. Meanwhile, set up
            who is who and what counts.
          </p>
        </div>
        <section class="card">
          {started || status?.running || status?.queued ? (
            <FirstSync org={admin.org} onDone={onSaved} />
          ) : (
            <div class="step-actions">
              <button
                type="button"
                class="button primary"
                onClick={async () => {
                  await admin.syncNow();
                  setStarted(true);
                }}
              >
                Sync now
              </button>
              <span class="muted">
                {status?.lastError
                  ? `The last sync stopped: ${status.lastError}`
                  : "Fetches the org's pull requests from GitHub."}
              </span>
            </div>
          )}
        </section>
        <Setup api={admin} meta={null} onSaved={onSaved} />
      </main>
    </>
  );
}

/**
 * How fresh the data is (rule 12): when it runs through, how long ago that was, and served,
 * when the server syncs next. Amber once the data is older than its schedule allows.
 */
function Freshness({ asOf, status }: { asOf: string; status: SyncStatus | null }) {
  const now = Date.now();
  const synced = status?.lastSync ?? asOf;
  const age = now - Date.parse(synced);
  const every = status ? everyMs(status.every) : Number.POSITIVE_INFINITY;
  // Late: two schedules missed, or two days old with no schedule to say otherwise.
  const late = age > (Number.isFinite(every) ? 2 * every : 2 * 86_400_000);
  const next = status?.running
    ? "syncing now…"
    : status?.nextSync
      ? `next sync ${relative(Date.parse(status.nextSync) - now)}`
      : status
        ? "no sync scheduled"
        : "";
  return (
    <span
      class={`through${late ? " late" : ""}`}
      title={`Data through ${when(asOf)}${status?.lastError ? ` · last sync failed: ${status.lastError}` : ""}`}
    >
      Data through {when(asOf)} · {ago(age)}
      {next && ` · ${next}`}
    </span>
  );
}

/** "3 h ago", "just now", "2 d ago". */
function ago(ms: number): string {
  if (ms < 60_000) return "just now";
  return `${span(ms)} ago`;
}

/** "in 21 h", "now". */
function relative(ms: number): string {
  return ms <= 60_000 ? "due now" : `in ${span(ms)}`;
}

function span(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

/**
 * The served org's sync status, checked every minute; calls `onSynced` when a sync has finished
 * since the page last looked. Null for the static report, which has no server to ask.
 */
function useSyncStatus(admin: AdminApi | undefined, onSynced: () => void): SyncStatus | null {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  useEffect(() => {
    if (!admin) return;
    let last: string | null | undefined;
    let live = true;
    const check = () =>
      admin.status().then(
        (next) => {
          if (!live) return;
          if (last !== undefined && next.lastSync !== last) onSynced();
          last = next.lastSync;
          setStatus(next);
        },
        () => {},
      );
    check();
    const timer = setInterval(check, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [admin]);
  return status;
}

/**
 * Which org is shown, and the way to add another. Switching loads the other org's page afresh:
 * nothing carries over.
 */
function OrgPicker(props: { current: string; orgs: readonly string[] }) {
  return (
    <select
      class="org-picker"
      aria-label="Org"
      value={props.current}
      onChange={(e) => {
        const value = e.currentTarget.value;
        location.assign(value === ADD_ORG ? "/welcome/" : `/orgs/${encodeURIComponent(value)}/`);
      }}
    >
      {props.orgs.map((org) => (
        <option key={org} value={org}>
          {org}
        </option>
      ))}
      <option value={ADD_ORG}>Add an org…</option>
    </select>
  );
}

const ADD_ORG = "\u0000add";

/** The tabs this report has: Setup only where it can save; essential mode only its few. */
const tabsFor = (admin: AdminApi | undefined, mode: Mode) =>
  TABS.filter(
    (t) => (admin || t.key !== "setup") && (mode === "advanced" || ESSENTIAL_TABS.includes(t.key)),
  );

/** A tab the mode shows: Overview in place of one essential mode leaves out. */
const tabIn = (mode: Mode, tab: Tab): Tab =>
  mode === "essential" && !ESSENTIAL_TABS.includes(tab) ? "overview" : tab;

const MODES: readonly { value: Mode; label: string }[] = [
  { value: "essential", label: "Essential" },
  { value: "advanced", label: "Advanced" },
];

const MODE_KEY = "codeflow-mode";

/** The mode this browser last chose, for links that don't say. */
function rememberedMode(): Mode | null {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    return saved === "essential" || saved === "advanced" ? saved : null;
  } catch {
    return null;
  }
}

function rememberMode(mode: Mode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Not remembered, then: the link still carries it.
  }
}

/** The breakdown asked for, if the selection offers it, or else the selection's default. */
function breakdownOf(choices: Choices, state: ReportState): Breakdown | null {
  const offered = breakdowns(choices, state.selection);
  return state.by !== null && offered.includes(state.by)
    ? state.by
    : defaultBreakdown(choices, state.selection);
}

/** The state in the URL. Links change it by navigating; controls replace it in place. */
function useHashState(
  choices: Choices,
  canSetup: boolean,
): [ReportState, (update: (s: ReportState) => ReportState) => void] {
  const read = () => {
    const state = readState(location.hash);
    // A link that doesn't name a mode opens in the one this browser last chose.
    const mode = /(^|[#&])mode=/.test(location.hash)
      ? state.mode
      : (rememberedMode() ?? state.mode);
    const tab = tabIn(mode, state.tab === "setup" && !canSetup ? "overview" : state.tab);
    return { ...state, mode, tab, selection: validSelection(choices, state.selection) };
  };
  const [state, setState] = useState<ReportState>(() => {
    const first = read();
    // The link said nothing of the mode, or named a tab the mode leaves out: say what is shown.
    if (writeState(first) !== writeState(readState(location.hash))) {
      history.replaceState(null, "", writeState(first));
    }
    return first;
  });
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
