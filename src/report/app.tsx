import { useEffect, useState } from "preact/hooks";
import { CONCENTRATION_SHARE, type Measurement } from "../core/aggregate.ts";
import { num, PHASE_LABELS, percent } from "../core/format.ts";
import { METRICS } from "../core/metrics.ts";
import {
  isComplete,
  type PeriodKind,
  periodContaining,
  periodKey,
  periodsCovered,
  periodsEnding,
  previousPeriod,
} from "../core/periods.ts";
import type { DataSource, Meta, Query } from "../core/source.ts";
import { PhaseBars, TrendChart } from "./charts.tsx";
import { OpenTable, PrTable, SummaryTable } from "./tables.tsx";

/** What the page shows. It lives in the URL, so any view can be shared as a link. */
type View = {
  kind: PeriodKind;
  /** Key of the selected period, e.g. "2026-09"; null for the default. */
  period: string | null;
  /** One repo, or null for all of them. */
  repo: string | null;
  percentile: number;
  /** The metric whose PRs are listed. */
  metric: string;
  /** The period those PRs come from, when a trend point picked one. */
  at: string | null;
};

const KINDS: PeriodKind[] = ["month", "quarter", "year"];
const PERCENTILES = [0.5, 0.75, 0.9];
const TREND_LENGTH: Record<PeriodKind, number> = { month: 12, quarter: 8, year: 4 };
const DEFAULT_VIEW: View = {
  kind: "month",
  period: null,
  repo: null,
  percentile: 0.5,
  metric: "merged",
  at: null,
};

export function App(props: { source: DataSource }) {
  const meta = useAsync(() => props.source.meta(), [props.source]);
  return meta ? <Report source={props.source} meta={meta} /> : <p>Loading…</p>;
}

function Report({ source, meta }: { source: DataSource; meta: Meta }) {
  const asOf = new Date(meta.asOf);
  const [view, update] = useView();
  const periods = periodsCovered(view.kind, meta.coveredFrom, asOf);
  // The default is the last complete period (rule 7); the running one is there to pick. With
  // no covered period at all, the hooks below still run (on the current one) before saying so.
  const covered =
    periods.find((p) => periodKey(p) === view.period) ??
    periods.find((p) => isComplete(p, asOf)) ??
    periods[0];
  const period = covered ?? periodContaining(view.kind, asOf);

  const repos = view.repo && meta.repos.includes(view.repo) ? [view.repo] : null;
  const query: Query = { period, repos, percentile: view.percentile };
  const before = previousPeriod(period);
  const at =
    (view.at &&
      periodsEnding(period, TREND_LENGTH[view.kind]).find((p) => periodKey(p) === view.at)) ||
    period;
  const metric = METRICS.find((m) => m.key === view.metric) ?? METRICS[0];
  const key = [periodKey(period), repos, view.percentile];

  const current = useAsync(() => source.measure(query), [source, ...key]);
  const previous = useAsync(
    () =>
      before.start >= meta.coveredFrom
        ? source.measure({ ...query, period: before })
        : Promise.resolve(null),
    [source, ...key],
  );
  const trend = useAsync(() => source.trend(query, TREND_LENGTH[view.kind]), [source, ...key]);
  const rows = useAsync(
    () => source.prs({ ...query, period: at }, metric?.key ?? ""),
    [source, ...key, periodKey(at), metric?.key],
  );
  const open = useAsync(() => source.openPrs(repos), [source, repos]);

  const trendPeriods = periodsEnding(period, TREND_LENGTH[view.kind]);
  const showRepo = repos === null && meta.repos.length > 1;
  const complete = isComplete(period, asOf);
  const pick = (metricKey: string, periodKeyPicked: string | null = null) => {
    update({ metric: metricKey, at: periodKeyPicked });
    document.getElementById("prs")?.scrollIntoView({ behavior: "smooth" });
  };

  if (!covered) {
    return (
      <p>
        No {view.kind} is covered yet: the synced data starts {meta.coveredFrom}.
      </p>
    );
  }

  return (
    <>
      <header>
        <h1>Code flow</h1>
        <p class="muted">
          {repos ? repos[0] : meta.repos.join(", ")} · data through {when(meta.asOf)} · measured
          from {meta.coveredFrom}
        </p>
        <form class="controls" onSubmit={(e) => e.preventDefault()}>
          <label>
            Period{" "}
            <select
              value={view.kind}
              onChange={(e) =>
                update({ kind: e.currentTarget.value as PeriodKind, period: null, at: null })
              }
            >
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>{" "}
            <select
              value={periodKey(period)}
              onChange={(e) => update({ period: e.currentTarget.value, at: null })}
            >
              {periods.map((p) => (
                <option key={periodKey(p)} value={periodKey(p)}>
                  {p.label}
                  {isComplete(p, asOf) ? "" : " (so far)"}
                </option>
              ))}
            </select>
          </label>
          {meta.repos.length > 1 && (
            <label>
              Repo{" "}
              <select
                value={repos?.[0] ?? ""}
                onChange={(e) => update({ repo: e.currentTarget.value || null })}
              >
                <option value="">all {meta.repos.length}</option>
                {meta.repos.map((repo) => (
                  <option key={repo} value={repo}>
                    {repo}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Statistic{" "}
            <select
              value={String(view.percentile)}
              onChange={(e) => update({ percentile: Number(e.currentTarget.value) })}
            >
              {PERCENTILES.map((p) => (
                <option key={p} value={String(p)}>
                  {p === 0.5 ? "median" : `P${p * 100}`}
                </option>
              ))}
            </select>
          </label>
        </form>
      </header>

      <section>
        <h2>
          {period.label}
          {complete ? "" : " (so far)"}
        </h2>
        {!complete && (
          <p class="note">This period isn't over: counts and totals will still grow.</p>
        )}
        {current && (
          <>
            <SummaryTable
              current={current}
              previous={previous ?? null}
              complete={complete}
              selected={metric?.key ?? ""}
              onPick={(metricKey) => pick(metricKey)}
            />
            <Notes measurement={current} />
          </>
        )}
      </section>

      <section>
        <h2>Trends</h2>
        <p class="muted">
          The {trendPeriods.length} {view.kind}s up to {period.label}. Hover a point for its value,
          click it for its PRs.
        </p>
        {trend && (
          <div class="grid">
            {METRICS.map((m) => (
              <TrendChart
                key={m.key}
                metric={m}
                percentile={view.percentile}
                selected={m.key === metric?.key ? periodKey(at) : null}
                onPick={(picked) => pick(m.key, picked)}
                points={trendPeriods.map((p, i) => ({
                  key: periodKey(p),
                  label: p.label,
                  value: trend[i]?.values.find((v) => v.metric.key === m.key) ?? null,
                }))}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2>Where the time went</h2>
        <p class="muted">Each phase's share of all cycle hours of the PRs merged in the period.</p>
        {trend && (
          <PhaseBars
            rows={trendPeriods
              .map((p, i) => ({ label: p.label, phases: trend[i]?.phases ?? null }))
              .filter((_, i) => trend[i] !== null)
              .reverse()}
          />
        )}
      </section>

      <section id="prs">
        <h2>
          {metric?.label} · {at.label}
          {rows ? `: ${num(rows.length)} PRs` : ""}
        </h2>
        <p class="muted">
          {metric?.definition} Click a metric above, or a point on a trend, to list other PRs.
        </p>
        {rows && <PrTable rows={rows} showRepo={showRepo} />}
      </section>

      <section>
        <h2>Open now{open ? `: ${num(open.length)}` : ""}</h2>
        <p class="muted">Pull requests still open as of {when(meta.asOf)}, oldest first.</p>
        {open && <OpenTable prs={open} asOf={asOf} showRepo={showRepo} />}
      </section>

      <section>
        <h2>Definitions</h2>
        <dl>
          {METRICS.map((m) => (
            <div key={m.key}>
              <dt>{m.label}</dt>
              <dd>{m.definition}</dd>
            </div>
          ))}
        </dl>
        <p class="muted">
          A PR counts once, where it merges into a measured branch: not bot PRs, not promotions
          between long-lived branches. Bots aren't reviewers, and neither is a PR's author.
          Percentiles need at least five PRs above them to show. Built {when(meta.builtAt)}.
        </p>
      </section>
    </>
  );
}

/** What a reader should know before trusting the period's numbers. */
function Notes({ measurement }: { measurement: Measurement }) {
  const { phases, excluded, truncated } = measurement;
  const notCounted = [
    excluded.base > 0 && `${num(excluded.base)} into branches that aren't measured`,
    excluded.promotion > 0 && `${num(excluded.promotion)} promotions between long-lived branches`,
    excluded.bot > 0 && `${num(excluded.bot)} by bots`,
  ].filter(Boolean);
  const concentrated = (phases ?? []).filter((phase) => phase.largestShare >= CONCENTRATION_SHARE);
  return (
    <ul class="notes">
      {phases && (
        <li>
          Where the time went:{" "}
          {phases
            .map((phase) => `${PHASE_LABELS[phase.phase]} ${percent(phase.share)}`)
            .join(" · ")}
        </li>
      )}
      {concentrated.map((phase) => (
        <li key={phase.phase}>
          #{phase.largestPr} alone is {percent(phase.largestShare)} of all{" "}
          {PHASE_LABELS[phase.phase]} time: one PR, not a habit.
        </li>
      ))}
      {notCounted.length > 0 && (
        <li>Not counted, though merged in the period: {notCounted.join(", ")}.</li>
      )}
      {truncated.length > 0 && (
        <li>
          GitHub sent incomplete data for {truncated.map((n) => `#${n}`).join(", ")}: its numbers
          may be understated.
        </li>
      )}
    </ul>
  );
}

/** The view, read from and written back to the URL's hash. */
function useView(): [View, (patch: Partial<View>) => void] {
  const [view, setView] = useState<View>(() => readHash());
  useEffect(() => {
    const onHashChange = () => setView(readHash());
    addEventListener("hashchange", onHashChange);
    return () => removeEventListener("hashchange", onHashChange);
  }, []);
  const update = (patch: Partial<View>) => {
    const next = { ...view, ...patch };
    history.replaceState(null, "", `#${writeHash(next)}`);
    setView(next);
  };
  return [view, update];
}

function readHash(): View {
  const params = new URLSearchParams(location.hash.slice(1));
  const kind = params.get("kind") as PeriodKind | null;
  const percentile = Number(params.get("p")) / 100;
  const metric = params.get("metric");
  return {
    kind: kind && KINDS.includes(kind) ? kind : DEFAULT_VIEW.kind,
    period: params.get("period"),
    repo: params.get("repo"),
    percentile: PERCENTILES.includes(percentile) ? percentile : DEFAULT_VIEW.percentile,
    metric: metric && METRICS.some((m) => m.key === metric) ? metric : DEFAULT_VIEW.metric,
    at: params.get("at"),
  };
}

function writeHash(view: View): string {
  const params = new URLSearchParams({
    kind: view.kind,
    p: String(Math.round(view.percentile * 100)),
    metric: view.metric,
  });
  if (view.period) params.set("period", view.period);
  if (view.repo) params.set("repo", view.repo);
  if (view.at) params.set("at", view.at);
  return params.toString();
}

/** The value of a promise, re-run whenever `deps` change; undefined until it settles. */
function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): T | undefined {
  const [state, setState] = useState<{ key: string; value: T } | undefined>(undefined);
  const key = JSON.stringify(
    deps.map((dep) => (typeof dep === "object" && dep !== null && !Array.isArray(dep) ? "·" : dep)),
  );
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

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
