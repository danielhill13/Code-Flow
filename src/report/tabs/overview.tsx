import type { MetricValue } from "../../core/aggregate.ts";
import { change, changeArrow } from "../../core/compare.ts";
import { formatValue, num, PHASE_LABELS, percent, prs, statLabel } from "../../core/format.ts";
import { REVERT_WINDOW_DAYS } from "../../core/metrics.ts";
import type { Note, OverviewModel, PhaseSplit } from "../../core/views/overview.ts";
import { listHref, metricList, prHref, selectionHref, setList, tabHref } from "../links.ts";
import { dimensionLabel } from "../selector.tsx";
import type { ReportState } from "../state.ts";
import {
  type BreakdownChoice,
  BreakdownControl,
  Card,
  capital,
  MetricTile,
  Spark,
  seriesPoints,
} from "../ui.tsx";

const TILE_LABELS: Record<string, string> = {
  cycle: "Cycle time",
  merged: "PRs merged",
  pickup: "Pickup (wait for first review)",
  reverted: `Reverted within ${REVERT_WINDOW_DAYS} d`,
};

export function Overview(props: {
  model: OverviewModel;
  state: ReportState;
  breakdown: BreakdownChoice;
}) {
  const { model, state } = props;
  const unit = model.window.grain === "month" ? "monthly" : "weekly";
  return (
    <>
      <div class="grid tiles-4">
        {model.tiles.map((tile) => (
          <MetricTile
            key={tile.key}
            tile={tile}
            label={TILE_LABELS[tile.key] ?? tile.key}
            href={listHref(
              state,
              metricList(tile.key, tile.span, `Overview › ${TILE_LABELS[tile.key]}`),
            )}
            more={
              tile.key === "reverted"
                ? ` · of PRs merged ${tile.span.label}, old enough to tell`
                : ""
            }
          />
        ))}
      </div>

      <Card
        title="Where the time went"
        note="Each phase's share of all cycle hours for PRs merged in the window. Click a phase to open Speed."
      >
        {model.phases ? (
          <PhaseShareBar phases={model.phases} state={state} percentile={state.percentile} />
        ) : (
          <p class="muted" style={{ margin: 0 }}>
            — No PRs merged in this window, so there is no time to split.
          </p>
        )}
      </Card>

      {model.rows.length > 0 && (
        <ScopeTable model={model} state={state} unit={unit} breakdown={props.breakdown} />
      )}

      <Notes model={model} state={state} />
    </>
  );
}

export function PhaseShareBar(props: {
  phases: readonly PhaseSplit[];
  state: ReportState;
  percentile: number;
}) {
  return (
    <>
      <div class="share-bar">
        {props.phases.map((p) => (
          <a
            key={p.phase}
            class={`phase-${p.phase}`}
            style={{ width: `${p.share * 100}%` }}
            href={tabHref(props.state, "speed")}
            title={`${capital(PHASE_LABELS[p.phase])}: ${percent(p.share)} of cycle hours`}
          >
            {p.share > 0.09 ? `${capital(PHASE_LABELS[p.phase])} ${percent(p.share)}` : ""}
          </a>
        ))}
      </div>
      <div class="legend">
        {props.phases.map((p) => (
          <span key={p.phase}>
            <span class={`swatch phase-${p.phase}`} />
            <span class="soft">{capital(PHASE_LABELS[p.phase])}</span>
            <b class="num">{percent(p.share)}</b>
            <span class="muted num">
              {statLabel(props.percentile)} {formatValue(p.value)}
            </span>
          </span>
        ))}
      </div>
    </>
  );
}

function ScopeTable({
  model,
  state,
  unit,
  breakdown,
}: {
  model: OverviewModel;
  state: ReportState;
  unit: string;
  breakdown: BreakdownChoice;
}) {
  const cols = "minmax(200px,1.6fr) repeat(6,minmax(84px,1fr)) 120px";
  const dimension = model.rows[0]?.dimension ?? "team";
  return (
    <section class="card flush">
      <div class="card-head">
        <h2>{dimensionLabel(dimension).plural}</h2>
        <span class="note">
          A–Z, not ranked · arrows compare with the previous window · click a row to open it
        </span>
        <span class="end">
          <BreakdownControl choice={breakdown} value={dimension} />
        </span>
      </div>
      <div class="table">
        <div class="table-inner" style={{ "--cols": cols }}>
          <div class="row head" style={{ "--cols": cols }}>
            <span>Name</span>
            <span>Merged</span>
            <span>Cycle</span>
            <span>Pickup</span>
            <span>Review</span>
            <span>Re-pushed</span>
            <span>Open now</span>
            <span>Cycle trend</span>
          </div>
          {model.rows.map((row) => (
            <a
              key={row.name}
              class="row"
              style={{ "--cols": cols }}
              href={selectionHref(state, row.selection)}
            >
              <div>
                <div style={{ fontWeight: 500 }}>{row.name}</div>
                {row.cycle.value.hidden && (
                  <div class="muted" style={{ fontSize: "11.5px" }}>
                    too few PRs for{" "}
                    {state.percentile === 0.5 ? "medians" : statLabel(state.percentile)} (
                    {num(row.merged.value.value ?? 0)})
                  </div>
                )}
              </div>
              <Cell pair={row.merged} />
              <Cell pair={row.cycle} />
              <Cell pair={row.pickup} />
              <Cell pair={row.review} />
              <span>{formatValue(row.repushed)}</span>
              <span>{num(row.open)}</span>
              <Spark points={seriesPoints(row.cycleSeries)} class="tiny" />
            </a>
          ))}
        </div>
      </div>
      <span class="visually-hidden">Trend points are {unit}.</span>
    </section>
  );
}

function Cell({ pair }: { pair: { value: MetricValue; previous: MetricValue | null } }) {
  const arrow = changeArrow(change(pair.value, pair.previous));
  return (
    <span title={pair.value.hidden}>
      {formatValue(pair.value)}
      {arrow && <span class="arrow">{arrow}</span>}
    </span>
  );
}

function Notes({ model, state }: { model: OverviewModel; state: ReportState }) {
  if (model.notes.length === 0) return null;
  return (
    <section class="notes">
      <h2>Notes on the data</h2>
      {model.notes.map((note, i) => (
        <p key={i}>
          <span>
            <NoteLine note={note} state={state} />
          </span>
        </p>
      ))}
    </section>
  );
}

function NoteLine({ note, state }: { note: Note; state: ReportState }) {
  const stat = state.percentile === 0.5 ? "medians" : statLabel(state.percentile);
  switch (note.kind) {
    case "excluded": {
      const parts = [
        note.base > 0 && `${prs(note.base)} merged into branches that aren't measured`,
        note.promotion > 0 && `${prs(note.promotion)} promoting work between long-lived branches`,
        note.bot > 0 && `${prs(note.bot)} by bots`,
      ].filter(Boolean);
      return <>Not counted: {parts.join(", ")}.</>;
    }
    case "concentration":
      return (
        <>
          <a href={prHref(state, note.pr.id)}>#{note.pr.number}</a> alone is {percent(note.share)}{" "}
          of all {PHASE_LABELS[note.phase]} time in this window: one PR, not a pattern.
        </>
      );
    case "outside":
      return (
        <>
          <a href={listHref(state, setList("open", "Overview › Open PRs"))}>
            {num(note.external)} of {num(note.open)} open PRs
          </a>{" "}
          are from outside contributors. Use the Contributors filter to separate them.
        </>
      );
    case "tooFew":
      return (
        <>
          {note.rows.map((r) => `${r.name} (${num(r.merged)} merged)`).join(", ")}: too few PRs for{" "}
          {stat}, so they show as —.
        </>
      );
    case "overlap":
      return (
        <>
          {prs(note.prs)} merged in this window count for more than one{" "}
          {dimensionLabel(note.dimension).one.toLowerCase()}, so the rows add up to more than the
          total. The total counts each PR once.
        </>
      );
    case "revertLag":
      return (
        <>
          Reverts look {REVERT_WINDOW_DAYS} days back: they are measured on PRs merged{" "}
          {note.span.label}, because newer PRs are too recent to tell.
        </>
      );
    case "truncated":
      return (
        <>
          GitHub sent incomplete data for{" "}
          {note.prs.map((pr, i) => (
            <span key={pr.id}>
              {i > 0 && ", "}
              <a href={prHref(state, pr.id)}>#{pr.number}</a>
            </span>
          ))}
          : their numbers may be understated.
        </>
      );
  }
}
