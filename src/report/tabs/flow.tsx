import type { PrFact } from "../../core/facts.ts";
import { duration, num, prs, waitingOnText } from "../../core/format.ts";
import { isInternal } from "../../core/selection.ts";
import { ageDays, type FlowModel, OPEN_STATES } from "../../core/views/flow.ts";
import { OPEN_STATE_LABELS } from "../../core/views/prs.ts";
import { listHref, metricList, prHref, setList } from "../links.ts";
import type { ReportState } from "../state.ts";
import { capital, MetricTile, Spark, shortDate } from "../ui.tsx";

export function Flow(props: { model: FlowModel; state: ReportState; asOf: Date }) {
  const { model, state, asOf } = props;
  const { open } = model;
  const since = (iso: string | null) =>
    iso === null
      ? "none"
      : `oldest waiting ${duration((asOf.getTime() - Date.parse(iso)) / 3_600_000)}`;
  const start = model.window.current.start;
  return (
    <>
      <div class="grid tiles-4">
        <a class="tile" href={listHref(state, setList("open", "Flow › Open now"))}>
          <div class="tile-label">
            <span>Open now</span>
          </div>
          <div class="tile-value">{num(open.now)}</div>
          <div class="tile-change">
            {open.atStart === null
              ? "the data doesn't reach the window's start"
              : open.atStart === open.now
                ? `same as on ${shortDate(start)}`
                : `${open.now > open.atStart ? "↑" : "↓"} from ${num(open.atStart)} on ${shortDate(start)}`}
          </div>
          <Spark
            points={open.series.map(({ bucket, count }) => ({
              value: count,
              partial: false,
              title: `${capital(bucket.label)}: ${count === null ? "before the synced data" : `${num(count)} open at its end`}`,
            }))}
            class="short"
          />
        </a>
        <a
          class="tile"
          href={listHref(
            state,
            setList("open", "Flow › Waiting for first review", [
              { kind: "state", state: "waiting" },
            ]),
          )}
        >
          <div class="tile-label">
            <span>Waiting for first review</span>
          </div>
          <div class="tile-value">{num(model.waiting.count)}</div>
          <div class="tile-change">{since(model.waiting.oldestSince)}</div>
        </a>
        <a
          class="tile"
          href={listHref(
            state,
            setList("open", "Flow › Approved, not merged", [{ kind: "state", state: "approved" }]),
          )}
        >
          <div class="tile-label">
            <span>Approved, not merged</span>
          </div>
          <div class="tile-value">{num(model.approved.count)}</div>
          <div class="tile-change">{since(model.approved.oldestSince)}</div>
        </a>
        <MetricTile
          tile={model.abandoned}
          label={`Abandoned · ${model.window.current.label}`}
          aside={`${prs(model.abandoned.value.n)} ended`}
          small
          href={listHref(state, metricList("abandoned", model.abandoned.span, "Flow › Abandoned"))}
        />
      </div>

      <Ages model={model} state={state} />
      <Oldest model={model} state={state} asOf={asOf} />
    </>
  );
}

function Ages({ model, state }: { model: FlowModel; state: ReportState }) {
  const max = Math.max(...model.ages.map((a) => a.total), 1);
  const cols = "120px minmax(0,1fr) 50px";
  return (
    <section class="card">
      <div class="card-head">
        <h2>How old, and in what state</h2>
        <span class="note">Open pull requests by age. Click a row to list them.</span>
        <span class="end legend" style={{ gap: "6px 14px" }}>
          {OPEN_STATES.map((s) => (
            <span key={s} class="soft" style={{ fontSize: "12px", gap: "6px" }}>
              <span class={`swatch state-${s}`} />
              {OPEN_STATE_LABELS[s]}
            </span>
          ))}
        </span>
      </div>
      {model.ages.map(({ band, total, states }) => (
        <a
          key={band.key}
          class="row"
          style={{ "--cols": cols, padding: "5px 0", borderTop: "none" }}
          href={listHref(state, setList("open", "Flow › Age", [{ kind: "age", band: band.key }]))}
        >
          <span class="soft">{band.label}</span>
          <div class="stack">
            {OPEN_STATES.filter((s) => states[s] > 0).map((s) => (
              <i
                key={s}
                class={`stack-part state-${s}`}
                style={{ width: `${(states[s] / max) * 100}%` }}
                title={`${OPEN_STATE_LABELS[s]}: ${num(states[s])}`}
              />
            ))}
          </div>
          <span style={{ textAlign: "right" }}>{num(total)}</span>
        </a>
      ))}
    </section>
  );
}

function Oldest(props: { model: FlowModel; state: ReportState; asOf: Date }) {
  const { model, state, asOf } = props;
  const cols = "70px minmax(260px,1fr) 110px 80px 150px minmax(200px,.8fr)";
  return (
    <section class="card flush">
      <div class="card-head">
        <h2>Oldest first</h2>
        <span class="note">"Waiting on" shows whose move it is.</span>
        <a
          class="end link"
          style={{ fontSize: "12.5px" }}
          href={listHref(state, setList("open", "Flow › Oldest first"))}
        >
          Show all {num(model.open.now)} ›
        </a>
      </div>
      <div class="table">
        <div class="table-inner">
          <div class="row head" style={{ "--cols": cols }}>
            <span>#</span>
            <span>Pull request</span>
            <span>Author</span>
            <span>Age</span>
            <span>State</span>
            <span>Waiting on</span>
          </div>
          {model.oldest.map((pr) => (
            <OpenRow
              key={pr.id}
              pr={pr}
              cols={cols}
              href={prHref(state, pr.id)}
              asOf={asOf}
              outside={!isInternal(pr)}
            />
          ))}
          {model.oldest.length === 0 && <div class="empty">No pull requests are open.</div>}
        </div>
      </div>
    </section>
  );
}

function OpenRow(props: { pr: PrFact; cols: string; href: string; asOf: Date; outside: boolean }) {
  const { pr } = props;
  return (
    <a class="row dense" style={{ "--cols": props.cols }} href={props.href}>
      <span class="mono soft">#{pr.number}</span>
      <span class="cell-title">
        <span>{pr.title}</span>
        <span class="sub">
          {pr.repo}
          {props.outside ? " · outside contributor" : ""}
        </span>
      </span>
      <span class="soft">{pr.author}</span>
      <span>{duration(ageDays(pr, props.asOf) * 24)}</span>
      <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        {pr.openState && <span class={`dot state-${pr.openState}`} />}
        {pr.openState ? OPEN_STATE_LABELS[pr.openState] : ""}
      </span>
      <span class="soft">{waitingOnText(pr, props.asOf)}</span>
    </a>
  );
}
