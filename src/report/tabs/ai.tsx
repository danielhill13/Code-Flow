// AI insights (decision D57): how much of the work shows an AI tool's traces, who uses them,
// which traces, in which repos month by month, and how AI-assisted PRs compare with the rest.
// Essential mode keeps the two headline numbers, the trend and a short comparison.
import { Fragment } from "preact";
import type { MetricValue } from "../../core/aggregate.ts";
import { AI_MARKER_HELP, AI_MARKER_LABELS } from "../../core/ai.ts";
import { change } from "../../core/compare.ts";
import { formatValue, num, percent, prs } from "../../core/format.ts";
import { metricOf } from "../../core/metrics.ts";
import type { Span } from "../../core/periods.ts";
import type { AiModel, ImpactCell, PeopleShare } from "../../core/views/ai.ts";
import type { PrFilter } from "../../core/views/prs.ts";
import { listHref, metricList, setList } from "../links.ts";
import type { ReportState } from "../state.ts";
import { Card, capital, MetricTile, Spark } from "../ui.tsx";
import { PeriodsMenu } from "../window-menu.tsx";

const FROM = "AI insights";
const ANY: PrFilter = { kind: "ai", marker: "any" };
const NONE: PrFilter = { kind: "ai", marker: "none" };

/** What essential mode's comparison keeps: speed, size and stability. */
const ESSENTIAL_IMPACT = ["merged", "cycle", "size", "reverted"];

export function AiInsights(props: {
  model: AiModel;
  state: ReportState;
  from: string;
  asOf: Date;
  essential: boolean;
  onPeriods: (periods: ReportState["aiPeriods"]) => void;
}) {
  const { model, state, essential } = props;
  const span = model.window.current;
  return (
    <>
      <div class="grid tiles-3">
        <MetricTile
          tile={model.share}
          label="AI-assisted share of PRs"
          href={listHref(state, metricList("aiAssisted", span, `${FROM} › AI-assisted`))}
          more={` · ${num(model.assisted.value)} of merged PRs`}
        />
        <PeopleTile model={model} state={state} />
        {!essential && (
          <a
            class="tile"
            href={listHref(state, metricList("merged", span, `${FROM} › AI-assisted`, [ANY]))}
          >
            <div class="tile-label">
              <span>AI-assisted PRs merged</span>
            </div>
            <div class="tile-value">{num(model.assisted.value)}</div>
            <div class="tile-change">
              {model.assisted.previous === null
                ? "no earlier data"
                : `${num(model.assisted.previous)} in ${model.window.previous.label}`}
            </div>
            <Spark
              points={model.trend.map(({ bucket, counts }) => ({
                value: counts?.ai ?? null,
                partial: bucket.partial,
                title: `${capital(bucket.label)}: ${counts === null ? "before the synced data" : `${num(counts.ai)} AI-assisted`}`,
              }))}
            />
          </a>
        )}
      </div>

      <Trend model={model} state={state} />
      <Impact {...props} />
      {!essential && (
        <>
          <div class="grid halves">
            <Markers model={model} state={state} />
            <Tools model={model} state={state} />
          </div>
          <Adoption model={model} state={state} />
        </>
      )}
      <section class="notes">
        <h2>Notes on the data</h2>
        <p>
          <span>
            A PR is AI-assisted when it shows at least one marker: a trace a tool leaves by default.
            One with none may still have had help, so the share is a floor, not a count of AI use.{" "}
            {model.partial > 0 &&
              `${prs(model.partial)} merged in this window had file or commit lists the host cut short, so some markers may be missing. `}
            Differences between AI-assisted PRs and the rest describe the PRs, not what caused them.
          </span>
        </p>
      </section>
    </>
  );
}

/** Contributors with an AI-assisted PR merged, of everyone with a PR merged. */
function PeopleTile({ model, state }: { model: AiModel; state: ReportState }) {
  const { people } = model;
  const moved =
    people.previous?.share != null && people.share !== null
      ? (people.share - people.previous.share) * 100
      : null;
  return (
    <a
      class="tile"
      href={listHref(
        state,
        metricList("merged", model.window.current, `${FROM} › Contributors using AI`, [ANY]),
      )}
    >
      <div class="tile-label">
        <span>Contributors using AI</span>
        <span class="n num">
          {num(people.using)} of {num(people.people)}
        </span>
      </div>
      <div class="tile-value">{people.share === null ? "—" : percent(people.share)}</div>
      <div class="tile-change">
        {people.share === null
          ? "no PRs"
          : moved === null
            ? "no earlier data"
            : Math.abs(moved) < 0.5
              ? `same as before (${percent(people.previous?.share ?? 0)})`
              : `${Math.abs(moved).toFixed(1)} pts ${moved > 0 ? "increase" : "decrease"} from ${percent(people.previous?.share ?? 0)}`}
        {" · people with a PR merged, not bots"}
      </div>
      <Spark
        points={people.series.map(({ bucket, value }) => ({
          value: value?.share ?? null,
          partial: bucket.partial,
          title: `${capital(bucket.label)}: ${peopleText(value)}`,
        }))}
      />
    </a>
  );
}

const peopleText = (value: PeopleShare | null) =>
  value === null
    ? "before the synced data"
    : value.share === null
      ? "no PRs"
      : `${num(value.using)} of ${num(value.people)} (${percent(value.share)})`;

/** Merged PRs per point, the AI-assisted part dark. */
function Trend({ model, state }: { model: AiModel; state: ReportState }) {
  const max = Math.max(...model.trend.map((t) => (t.counts ? t.counts.ai + t.counts.none : 0)), 0);
  return (
    <Card
      title="AI-assisted PRs over time"
      note={`PRs merged per ${model.window.grain}: AI-assisted in green, the rest in grey. Click a bar for its PRs.`}
    >
      <div class="ai-trend">
        {model.trend.map(({ bucket, counts }) => {
          const total = counts ? counts.ai + counts.none : 0;
          const label = `${capital(bucket.label)}: ${
            counts === null
              ? "before the synced data"
              : `${num(counts.ai)} of ${num(total)} AI-assisted${total ? ` (${percent(counts.ai / total)})` : ""}`
          }${bucket.partial ? " (so far)" : ""}`;
          return (
            <a
              key={bucket.start}
              class={counts === null ? "missing" : bucket.partial ? "partial" : ""}
              href={listHref(state, metricList("merged", bucket, `${FROM} › Over time`))}
              title={label}
              style={{
                height:
                  counts === null ? "14%" : `${max > 0 ? Math.max(2, (total / max) * 100) : 2}%`,
              }}
            >
              <span
                class="ai-part"
                style={{ height: total ? `${((counts?.ai ?? 0) / total) * 100}%` : "0" }}
              />
              <span class="visually-hidden">{label}</span>
            </a>
          );
        })}
      </div>
      <div class="ai-trend-axis">
        {model.trend.map(({ bucket }) => (
          <span key={bucket.start} class="ai-tick">
            {bucket.short}
          </span>
        ))}
      </div>
      <div class="legend">
        <span>
          <span class="swatch ai-swatch" />
          <span class="soft">AI-assisted</span>
        </span>
        <span>
          <span class="swatch" style={{ background: "var(--bar)" }} />
          <span class="soft">No markers</span>
        </span>
      </div>
    </Card>
  );
}

function Markers({ model, state }: { model: AiModel; state: ReportState }) {
  const max = Math.max(...model.markers.map((m) => m.prs), 0);
  const span = model.window.current;
  const cols = "minmax(110px,1fr) minmax(40px,1.4fr) 44px 44px";
  return (
    <Card
      title="Which markers were seen"
      note="Merged PRs showing each marker; a PR can show several. Alone: the only marker it shows."
    >
      <div class="row head" style={{ "--cols": cols }}>
        <span>Marker</span>
        <span />
        <span>PRs</span>
        <span>Alone</span>
      </div>
      {model.markers.map((row) => (
        <a
          key={row.marker}
          class="row"
          style={{ "--cols": cols, padding: "6px 0" }}
          href={listHref(
            state,
            metricList("merged", span, `${FROM} › ${AI_MARKER_LABELS[row.marker]}`, [
              { kind: "ai", marker: row.marker },
            ]),
          )}
          title={AI_MARKER_HELP[row.marker]}
        >
          <span>{AI_MARKER_LABELS[row.marker]}</span>
          <div
            class="hbar ai-bar"
            style={{ width: max ? `${Math.max(row.prs ? 2 : 0, (row.prs / max) * 100)}%` : "0" }}
          />
          <span class="num">{num(row.prs)}</span>
          <span class="num soft">{num(row.only)}</span>
        </a>
      ))}
      <div class="ai-depth">
        {model.depth.map((d) => (
          <a
            key={d.markers}
            href={listHref(
              state,
              metricList(
                "merged",
                span,
                `${FROM} › Markers per PR`,
                d.markers === 0 ? [NONE] : [ANY],
              ),
            )}
          >
            <span class="soft">
              {d.markers === 0 ? "None" : d.markers === 3 ? "3 or more" : `${d.markers}`}
            </span>
            <b class="num">{num(d.prs)}</b>
          </a>
        ))}
      </div>
      <span class="muted" style={{ fontSize: "12px" }}>
        PRs by how many markers they show.
      </span>
    </Card>
  );
}

function Tools({ model, state }: { model: AiModel; state: ReportState }) {
  const max = Math.max(...model.tools.map((t) => t.prs), 0);
  const cols = "minmax(90px,1fr) minmax(40px,1.6fr) 44px";
  return (
    <Card
      title="Tools named"
      note="Merged PRs whose markers name a tool. A thoughts/ folder names none."
    >
      {model.tools.length === 0 ? (
        <p class="muted" style={{ margin: 0 }}>
          — No marker in this window names a tool.
        </p>
      ) : (
        model.tools.map((row) => (
          <a
            key={row.tool}
            class="row"
            style={{ "--cols": cols, padding: "6px 0" }}
            href={listHref(state, setList("merged", `${FROM} › ${row.tool}`, [ANY]))}
          >
            <span>{row.tool}</span>
            <div
              class="hbar ai-bar"
              style={{ width: `${max ? Math.max(2, (row.prs / max) * 100) : 0}%` }}
            />
            <span class="num">{num(row.prs)}</span>
          </a>
        ))
      )}
    </Card>
  );
}

/** Each repo's AI-assisted share, month by month: darker is a larger share. */
function Adoption({ model, state }: { model: AiModel; state: ReportState }) {
  const { months, rows, total, more } = model.adoption;
  const cols = `minmax(180px,1.6fr) repeat(${months.length},minmax(58px,1fr))`;
  const cell = (
    key: string,
    value: AiModel["adoption"]["total"][number],
    span: Span,
    repo: string | null,
  ) => {
    if (value === null)
      return <span key={key} class="ai-cell missing" title="Before the synced data" />;
    if (value.share === null) {
      return (
        <span key={key} class="ai-cell muted">
          ·
        </span>
      );
    }
    const list = metricList("merged", span, `${FROM} › Adoption`, [ANY]);
    const href = listHref(
      repo ? { ...state, selection: { ...state.selection, repo: [repo] } } : state,
      list,
    );
    return (
      <a
        key={key}
        class="ai-cell"
        href={href}
        title={`${repo ?? "All repos"}, ${span.label}: ${num(value.ai)} of ${num(value.merged)} merged PRs AI-assisted`}
        style={{ "--ai-share": value.share }}
      >
        {percent(value.share)}
      </a>
    );
  };
  return (
    <section class="card flush">
      <div class="card-head">
        <h2>Adoption by repo, month by month</h2>
        <span class="note">
          The share of each repo's merged PRs that are AI-assisted; · is a month with none merged.
          Repos with the most PRs first.
        </span>
      </div>
      <div class="table">
        <div class="table-inner" style={{ "--min": `${200 + months.length * 62}px` }}>
          <div class="row head" style={{ "--cols": cols }}>
            <span>Repo</span>
            {months.map((month) => (
              <span key={month.start} class="num">
                {month.short}
                {month.partial ? "*" : ""}
              </span>
            ))}
          </div>
          {rows.map((row) => (
            <div key={row.repo} class="row dense" style={{ "--cols": cols }}>
              <span class="clip" title={row.repo}>
                {row.repo}
              </span>
              {row.cells.map((value, i) =>
                cell(`${row.repo}${i}`, value, months[i] as Span, row.repo),
              )}
            </div>
          ))}
          <div class="row dense" style={{ "--cols": cols, fontWeight: 600 }}>
            <span>All repos{more > 0 ? ` (and ${num(more)} more)` : ""}</span>
            {total.map((value, i) => cell(`total${i}`, value, months[i] as Span, null))}
          </div>
          {rows.length === 0 && <div class="empty">No PRs merged in these months.</div>}
        </div>
      </div>
      {months.some((m) => m.partial) && (
        <span class="muted" style={{ fontSize: "12px", padding: "0 20px 14px" }}>
          * so far: the month is still running.
        </span>
      )}
    </section>
  );
}

/** "+35%", "−4.0 pts", "same": how AI-assisted PRs differ from the rest, in neutral words. */
function difference(cell: ImpactCell): string {
  // Two counts differ by how many PRs each side has, which the counts say already.
  if (metricOf(cell.ai.key).kind === "count") return "";
  const moved = change(cell.ai, cell.none);
  switch (moved.kind) {
    case "relative":
      return `${moved.value > 0 ? "+" : "−"}${Math.round(Math.abs(moved.value) * 100)}%`;
    case "points":
      return `${moved.value > 0 ? "+" : "−"}${Math.abs(moved.value).toFixed(1)} pts`;
    case "absolute":
      return `${moved.value > 0 ? "+" : "−"}${formatValue({ ...cell.ai, value: Math.abs(moved.value) })}`;
    case "same":
      return "same";
    default:
      return "";
  }
}

function Impact(props: {
  model: AiModel;
  state: ReportState;
  from: string;
  asOf: Date;
  essential: boolean;
  onPeriods: (periods: ReportState["aiPeriods"]) => void;
}) {
  const { model, state, essential } = props;
  const periods = essential ? model.impact.periods.slice(-1) : model.impact.periods;
  const offset = model.impact.periods.length - periods.length;
  // A metric with no PRs anywhere (lines rewritten, without a local copy) is left out.
  const rows = model.impact.rows.filter(
    (row) =>
      (!essential || ESSENTIAL_IMPACT.includes(row.key)) &&
      row.cells.some((cell) => cell.ai.n + cell.none.n > 0),
  );
  const cols = `minmax(170px,1.3fr) repeat(${periods.length},minmax(84px,1fr) minmax(84px,1fr) 64px)`;
  const value = (v: MetricValue, span: Span, filter: PrFilter, period: string) => (
    <a
      class="num"
      href={listHref(state, metricList(v.key, span, `${FROM} › Impact › ${period}`, [filter]))}
      title={`${prs(v.n)}${v.hidden ? ` · ${v.hidden}` : ""}${v.notApplicable ? ` · ${num(v.notApplicable)} too recent or unknown` : ""}`}
    >
      {formatValue(v)}
      {metricOf(v.key).kind !== "count" && <span class="muted ai-n"> {num(v.n)}</span>}
    </a>
  );
  return (
    <section class="card flush">
      <div class="card-head">
        <h2>
          {essential ? "AI-assisted PRs and the rest" : "Impact: AI-assisted PRs and the rest"}
        </h2>
        <span class="note">
          {essential
            ? `Merged ${periods[0]?.label ?? ""}. Small numbers are PR counts. A difference describes the PRs; it doesn't prove AI caused it.`
            : "Each metric for AI-assisted PRs and for PRs with no markers, period by period; Diff. is AI-assisted against the rest. Small numbers are PR counts. A difference describes the PRs; it doesn't prove AI caused it."}
        </span>
        {!essential && (
          <span class="end">
            <PeriodsChoice {...props} />
          </span>
        )}
      </div>
      <div class="table">
        <div class="table-inner" style={{ "--min": `${190 + periods.length * 240}px` }}>
          <div class="row head" style={{ "--cols": cols }}>
            <span />
            {periods.map((period) => (
              <span key={period.start} class="ai-period" style={{ gridColumn: "span 3" }}>
                {capital(period.label)}
                {period.complete ? "" : " (so far)"}
              </span>
            ))}
          </div>
          <div class="row head" style={{ "--cols": cols }}>
            <span>Metric</span>
            {periods.map((period) => (
              <Fragment key={period.start}>
                <span>AI-assisted</span>
                <span>No markers</span>
                <span>Diff.</span>
              </Fragment>
            ))}
          </div>
          {rows.map((row) => (
            <div key={row.key} class="row dense" style={{ "--cols": cols }}>
              <span title={metricOf(row.key).definition}>{metricOf(row.key).label}</span>
              {row.cells.slice(offset).map((cell, i) => {
                const period = periods[i];
                if (!period) return null;
                return (
                  <Fragment key={period.start}>
                    {value(cell.ai, period, ANY, period.label)}
                    {value(cell.none, period, NONE, period.label)}
                    <span class="soft num">{difference(cell)}</span>
                  </Fragment>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * The periods compared: the window and the one before until the reader picks, then theirs.
 * Picking starts from the window, so the first tick adds a period to it.
 */
function PeriodsChoice(props: {
  state: ReportState;
  from: string;
  asOf: Date;
  onPeriods: (periods: ReportState["aiPeriods"]) => void;
}) {
  const { state } = props;
  return (
    <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <PeriodsMenu
        value={state.aiPeriods.length > 0 ? state.aiPeriods : [state.window]}
        from={props.from}
        asOf={props.asOf}
        onChange={props.onPeriods}
      />
      {state.aiPeriods.length === 0 && (
        <span class="muted" style={{ fontSize: "12px" }}>
          showing the window and the one before
        </span>
      )}
      {state.aiPeriods.length > 0 && (
        <button type="button" class="link-button" onClick={() => props.onPeriods([])}>
          Window and the one before
        </button>
      )}
    </span>
  );
}
