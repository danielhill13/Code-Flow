import type { PhaseShare } from "../../core/aggregate.ts";
import { change, changeShort } from "../../core/compare.ts";
import { formatValue, num, PHASE_LABELS, percent, statLabel } from "../../core/format.ts";
import { type MetricGroup, metricOf } from "../../core/metrics.ts";
import {
  isComplete,
  lastCompletePeriod,
  type Period,
  type PeriodKind,
  periodKey,
  periodsCovered,
  type Span,
} from "../../core/periods.ts";
import type { CompareModel } from "../../core/views/compare.ts";
import { listHref, metricList } from "../links.ts";
import type { CompareState, Grain, ReportState } from "../state.ts";
import { capital, Segmented } from "../ui.tsx";

/** The two spans the Compare tab is set to: periods of the chosen kind, or custom dates. */
export type ComparePick = {
  a: Span | null;
  b: Span | null;
  /** Periods to step through, oldest first; empty for custom dates. */
  periods: Period[];
  aIndex: number;
  bIndex: number;
  /** Custom dates, as YYYY-MM-DD, inclusive. */
  dates: { a: [string, string]; b: [string, string] };
};

const DAY_MS = 86_400_000;

/** Resolves the Compare state against the data: B defaults to the last complete period, A to the one before. */
export function comparePick(compare: CompareState, coveredFrom: string, asOf: Date): ComparePick {
  const kind: PeriodKind = compare.grain === "custom" ? "quarter" : compare.grain;
  const periods = periodsCovered(kind, coveredFrom, asOf).reverse();
  const keys = periods.map(periodKey);
  const lastComplete = keys.indexOf(periodKey(lastCompletePeriod(kind, asOf)));
  const fallbackB = lastComplete >= 0 ? lastComplete : periods.length - 1;
  const bIndex = compare.b && keys.includes(compare.b) ? keys.indexOf(compare.b) : fallbackB;
  const aIndex = compare.a && keys.includes(compare.a) ? keys.indexOf(compare.a) : bIndex - 1;
  const dates = {
    a: customDates(compare.a) ?? spanDates(periods[aIndex]),
    b: customDates(compare.b) ?? spanDates(periods[bIndex]),
  };
  if (compare.grain === "custom") {
    return {
      a: customSpan(dates.a),
      b: customSpan(dates.b),
      periods: [],
      aIndex: -1,
      bIndex: -1,
      dates,
    };
  }
  return { a: periods[aIndex] ?? null, b: periods[bIndex] ?? null, periods, aIndex, bIndex, dates };
}

function customDates(text: string | null): [string, string] | null {
  const match = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(text ?? "");
  return match ? [match[1] ?? "", match[2] ?? ""] : null;
}

function spanDates(period: Period | undefined): [string, string] {
  if (!period) return ["", ""];
  const last = new Date(Date.parse(period.end) - DAY_MS).toISOString().slice(0, 10);
  return [period.start, last];
}

function customSpan([from, to]: [string, string]): Span | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from)
    return null;
  const end = new Date(Date.parse(to) + DAY_MS).toISOString().slice(0, 10);
  const label = (iso: string, year: boolean) =>
    new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: year ? "numeric" : undefined,
      timeZone: "UTC",
    });
  return { start: from, end, label: `${label(from, false)} – ${label(to, true)}` };
}

const GRAINS: readonly { value: Grain; label: string }[] = [
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" },
  { value: "custom", label: "Custom" },
];

const GROUPS: readonly MetricGroup[] = ["Speed", "Throughput", "Review", "Stability", "Flow"];

export function CompareControls(props: {
  state: ReportState;
  pick: ComparePick;
  asOf: Date;
  onChange: (compare: CompareState) => void;
}) {
  const { state, pick, asOf, onChange } = props;
  const { compare } = state;
  const keyAt = (index: number) => {
    const period = pick.periods[index];
    return period ? periodKey(period) : null;
  };
  const step = (which: "a" | "b", by: number) =>
    onChange({
      ...compare,
      a: keyAt(pick.aIndex + (which === "a" ? by : 0)),
      b: keyAt(pick.bIndex + (which === "b" ? by : 0)),
    });
  const label = (span: Span | null) =>
    span === null ? "—" : `${span.label}${isComplete(span, asOf) ? "" : " (so far)"}`;
  const setDate = (which: "a" | "b", end: 0 | 1, value: string) => {
    const dates = { ...pick.dates };
    const range: [string, string] = [...dates[which]];
    range[end] = value;
    dates[which] = range;
    onChange({ ...compare, a: `${dates.a[0]}..${dates.a[1]}`, b: `${dates.b[0]}..${dates.b[1]}` });
  };
  return (
    <section
      class="card"
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "14px 22px",
        padding: "16px 20px",
      }}
    >
      <Segmented
        label="Compare by"
        hideLabel
        options={GRAINS}
        value={compare.grain}
        onChange={(grain) => onChange({ grain, a: null, b: null })}
      />
      {compare.grain === "custom" ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            flexWrap: "wrap",
            fontSize: "13px",
          }}
        >
          {(["a", "b"] as const).map((which) => (
            <span key={which} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              {which === "b" && <span class="muted">vs</span>}
              <span
                class="swatch"
                style={{ background: which === "a" ? "var(--bar)" : "var(--accent)" }}
              />
              {which.toUpperCase()}
              <input
                type="date"
                aria-label={`${which.toUpperCase()} from`}
                value={pick.dates[which][0]}
                onChange={(e) => setDate(which, 0, e.currentTarget.value)}
              />
              <span class="muted">to</span>
              <input
                type="date"
                aria-label={`${which.toUpperCase()} to`}
                value={pick.dates[which][1]}
                onChange={(e) => setDate(which, 1, e.currentTarget.value)}
              />
            </span>
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          {(["a", "b"] as const).map((which) => {
            const index = which === "a" ? pick.aIndex : pick.bIndex;
            return (
              <span key={which} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                {which === "b" && <span class="muted">vs</span>}
                <span
                  class="swatch"
                  style={{ background: which === "a" ? "var(--bar)" : "var(--accent)" }}
                />
                <span class="muted" style={{ fontSize: "12px" }}>
                  {which.toUpperCase()}
                </span>
                <span class="stepper">
                  <button
                    type="button"
                    class="step"
                    aria-label={`Earlier ${which.toUpperCase()}`}
                    disabled={index <= 0}
                    onClick={() => step(which, -1)}
                  >
                    ‹
                  </button>
                  <span>{label(which === "a" ? pick.a : pick.b)}</span>
                  <button
                    type="button"
                    class="step"
                    aria-label={`Later ${which.toUpperCase()}`}
                    disabled={index >= pick.periods.length - 1}
                    onClick={() => step(which, 1)}
                  >
                    ›
                  </button>
                </span>
              </span>
            );
          })}
        </div>
      )}
      <span class="controls-note">
        {statLabel(state.percentile)} of each period · click a value to see its PRs
      </span>
    </section>
  );
}

export function Compare(props: { model: CompareModel; state: ReportState }) {
  const { model, state } = props;
  const cols = "minmax(190px,1.4fr) 110px 110px minmax(120px,1fr) 150px minmax(170px,1fr)";
  return (
    <>
      <section class="card flush" style={{ paddingTop: "8px" }}>
        <div class="table">
          <div class="table-inner" style={{ "--min": "880px" }}>
            <div class="row head" style={{ "--cols": cols, paddingTop: "10px" }}>
              <span>Metric</span>
              <span>A · {model.a.label}</span>
              <span>B · {model.b.label}</span>
              <span>Change</span>
              <span>PRs A → B</span>
              <span>Middle half of PRs</span>
            </div>
            {GROUPS.map((group) => (
              <div key={group}>
                <div class="row group">{group}</div>
                {model.rows
                  .filter((row) => metricOf(row.key).group === group)
                  .map((row) => (
                    <CompareRow key={row.key} row={row} model={model} state={state} cols={cols} />
                  ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Where the time went, A vs B</h2>
          <span class="note">
            Shows where a gain came from, or whether the wait just moved to another phase.
          </span>
        </div>
        <ShareRow label={`A · ${model.a.label}`} phases={model.phasesA} />
        <ShareRow label={`B · ${model.b.label}`} phases={model.phasesB} />
      </section>
    </>
  );
}

function CompareRow(props: {
  row: CompareModel["rows"][number];
  model: CompareModel;
  state: ReportState;
  cols: string;
}) {
  const { row, model, state, cols } = props;
  const metric = metricOf(row.key);
  const counts = metric.kind === "count" || metric.kind === "sum";
  const n = counts ? "—" : `${num(row.a.n)} → ${num(row.b.n)}`;
  const recent =
    row.key === "reverted" && row.b.notApplicable > 0
      ? ` · ${num(row.b.notApplicable)} too recent`
      : "";
  const scale = Math.max(row.middleA?.[1] ?? 0, row.middleB?.[1] ?? 0) * 1.1;
  const bar = (middle: [number, number] | null, kind: "a" | "b") =>
    middle && scale > 0 ? (
      <i
        class={`middle-bar ${kind}`}
        style={{
          left: `${(middle[0] / scale) * 100}%`,
          width: `${Math.max(1, ((middle[1] - middle[0]) / scale) * 100)}%`,
        }}
      />
    ) : null;
  return (
    <div class="row" style={{ "--cols": cols, padding: "7px 20px", borderTop: "none" }}>
      <span>{metric.label}</span>
      <a
        class="soft"
        href={listHref(state, metricList(row.key, model.a, `Compare › A · ${metric.label}`))}
        title={row.a.hidden}
      >
        {formatValue(row.a)}
      </a>
      <a
        style={{ fontWeight: 600 }}
        href={listHref(state, metricList(row.key, model.b, `Compare › B · ${metric.label}`))}
        title={row.b.hidden}
      >
        {formatValue(row.b)}
      </a>
      <span class="soft">
        {changeShort(
          change(row.b, model.a.covered ? row.a : null, model.b.complete),
          model.a.covered ? row.a : null,
        )}
      </span>
      <span class="muted" style={{ fontSize: "12.5px" }}>
        {n}
        {recent}
      </span>
      {row.middleA || row.middleB ? (
        <div class="middle" title={middleTitle(row)}>
          {bar(row.middleA, "a")}
          {bar(row.middleB, "b")}
        </div>
      ) : (
        <span />
      )}
    </div>
  );
}

function middleTitle(row: CompareModel["rows"][number]): string {
  const range = (m: [number, number] | null) =>
    m
      ? `${formatValue({ ...row.a, value: m[0] })} – ${formatValue({ ...row.a, value: m[1] })}`
      : "too few PRs";
  return `Middle half (P25–P75). A: ${range(row.middleA)}. B: ${range(row.middleB)}.`;
}

function ShareRow({ label, phases }: { label: string; phases: PhaseShare[] | null }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "160px minmax(0,1fr)",
        gap: "12px",
        alignItems: "center",
      }}
    >
      <span class="soft" style={{ fontSize: "13px" }}>
        {label}
      </span>
      <div class="share-bar small">
        {phases ? (
          phases.map((p) => (
            <div
              key={p.phase}
              class={`phase-${p.phase}`}
              style={{ width: `${p.share * 100}%` }}
              title={`${capital(PHASE_LABELS[p.phase])}: ${percent(p.share)}`}
            >
              {p.share > 0.1 ? `${capital(PHASE_LABELS[p.phase])} ${percent(p.share)}` : ""}
            </div>
          ))
        ) : (
          <div style={{ width: "100%", background: "var(--surface2)", color: "var(--text3)" }}>
            no PRs merged
          </div>
        )}
      </div>
    </div>
  );
}
