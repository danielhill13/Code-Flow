import { duration, formatValue, num, PHASE_LABELS, percent, statLabel } from "../../core/format.ts";
import { metricOf } from "../../core/metrics.ts";
import { SLOW_END, type SpeedModel } from "../../core/views/speed.ts";
import { listHref, metricList } from "../links.ts";
import type { ReportState } from "../state.ts";
import { Card, capital, changeLine, MetricTile } from "../ui.tsx";

export function Speed({ model, state }: { model: SpeedModel; state: ReportState }) {
  const stat = statLabel(state.percentile);
  const slow = statLabel(SLOW_END);
  const unit = model.window.grain;
  return (
    <>
      <div class="grid split">
        <section class="card">
          <div class="card-head">
            <h2>Cycle time</h2>
            <span class="note">
              bar = {stat} · dashed outline = {slow}, shown where a {unit} has enough PRs · hollow =
              still in progress · click a bar for its PRs
            </span>
          </div>
          <CycleChart model={model} state={state} />
        </section>
        <Predictability model={model} />
      </div>

      <div class="grid tiles-5">
        {model.phases.map(({ tile, share }) => {
          const label = capital(PHASE_LABELS[tile.key as keyof typeof PHASE_LABELS]);
          const largest = model.largest === tile.key;
          return (
            <MetricTile
              key={tile.key}
              tile={tile}
              label={label}
              small
              accent={largest}
              swatch={`phase-${tile.key}`}
              aside={share === null ? "" : `${percent(share)} of time`}
              href={listHref(state, metricList(tile.key, tile.span, `Speed › ${label}`))}
            >
              {largest && <div class="tile-tag">Most of the cycle time</div>}
            </MetricTile>
          );
        })}
        <MetricTile
          tile={model.approval}
          label="Time to approval"
          small
          href={listHref(
            state,
            metricList("timeToApproval", model.approval.span, "Speed › Time to approval"),
          )}
        />
      </div>

      <div class="grid halves">
        <SizeCard model={model} state={state} />
        <Throughput model={model} state={state} />
      </div>
    </>
  );
}

function CycleChart({ model, state }: { model: SpeedModel; state: ReportState }) {
  const tops = model.cycle.map((c) => c.slow?.value ?? c.point.value?.value ?? 0);
  const max = Math.max(...tops, 0);
  const stat = statLabel(state.percentile);
  return (
    <div class="chart">
      <div class="chart-axis num">
        <span>{max > 0 ? duration(max) : ""}</span>
        <span>{max > 0 ? duration(max / 2) : ""}</span>
        <span>0</span>
      </div>
      <div class="chart-bars">
        {model.cycle.map(({ point, slow }) => {
          const value = point.value?.value ?? null;
          const outer = slow?.value ?? value;
          const title = [
            capital(point.bucket.label),
            point.value ? `${num(point.value.n)} PRs` : "before the synced data",
            value !== null ? `${stat} ${duration(value)}` : (point.value?.hidden ?? ""),
            slow?.value != null ? `${statLabel(SLOW_END)} ${duration(slow.value)}` : "",
            point.bucket.partial ? "in progress" : "",
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <a
              key={point.bucket.start}
              href={listHref(state, metricList("cycle", point.span, "Speed › Cycle time"))}
              title={title}
            >
              <div class="chart-plot">
                {value === null || outer === null || max === 0 ? (
                  <div class="chart-bar missing" />
                ) : (
                  <div
                    class={`chart-outline${slow?.value == null ? " none" : ""}`}
                    style={{ height: `${(outer / max) * 100}%` }}
                  >
                    <div
                      class={`chart-bar${point.bucket.partial ? " partial" : ""}`}
                      style={{ height: `${Math.min(100, (value / outer) * 100)}%` }}
                    />
                  </div>
                )}
              </div>
              <div class="chart-label">
                {point.bucket.partial && model.window.grain === "week"
                  ? "this week"
                  : point.bucket.short}
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

function Predictability({ model }: { model: SpeedModel }) {
  const { median, slow, spread, previousSpread } = model.predictability;
  const moved =
    spread === null || previousSpread === null
      ? ""
      : Math.abs(spread - previousSpread) < 0.1
        ? "about the same as before"
        : `${spread < previousSpread ? "narrower" : "wider"}, from ${previousSpread.toFixed(1)}×`;
  return (
    <section class="card">
      <h2 style={{ fontSize: "14px", fontWeight: 600 }}>Predictability</h2>
      <div>
        <div class="soft" style={{ fontSize: "13px" }}>
          Half of changes merge within
        </div>
        <div class="big">{formatValue(median)}</div>
        {median.hidden && (
          <div class="muted" style={{ fontSize: "12px" }}>
            {median.hidden}
          </div>
        )}
      </div>
      <div>
        <div class="soft" style={{ fontSize: "13px" }}>
          {Math.round(SLOW_END * 100)}% merge within
        </div>
        <div class="big">{formatValue(slow)}</div>
        {slow.hidden && (
          <div class="muted" style={{ fontSize: "12px" }}>
            {slow.hidden}
          </div>
        )}
      </div>
      <div
        class="soft"
        style={{ borderTop: "1px solid var(--line)", paddingTop: "10px", fontSize: "12.5px" }}
      >
        Spread ({statLabel(SLOW_END)} ÷ median):{" "}
        <b style={{ color: "var(--text)" }}>{spread === null ? "—" : `${spread.toFixed(1)}×`}</b>
        {moved && <div class="muted">{moved}</div>}
      </div>
    </section>
  );
}

function SizeCard({ model, state }: { model: SpeedModel; state: ReportState }) {
  const max = Math.max(...model.sizes.map((s) => s.cycle.value ?? 0), 0);
  const cols = "120px 50px minmax(0,1fr) 90px";
  return (
    <Card
      title="PR size vs cycle time"
      note={`lines of product code · ${statLabel(state.percentile)} cycle per size`}
    >
      <div class="row head" style={{ "--cols": cols, padding: "0" }}>
        <span>Size</span>
        <span>PRs</span>
        <span>Cycle</span>
        <span />
      </div>
      {model.sizes.map(({ band, count, cycle }) => (
        <a
          key={band.key}
          class="row"
          style={{ "--cols": cols, padding: "6px 0" }}
          href={listHref(
            state,
            metricList("cycle", model.window.current, "Speed › PR size", [
              { kind: "size", band: band.key },
            ]),
          )}
        >
          <span>{band.label}</span>
          <span class="soft">{formatValue(count)}</span>
          <div
            class="hbar"
            style={{
              width:
                cycle.value === null || max === 0
                  ? "0"
                  : `${Math.max(2, (cycle.value / max) * 100)}%`,
            }}
          />
          <span style={{ textAlign: "right" }} title={cycle.hidden}>
            {cycle.value === null ? (count.value ? "— too few" : "—") : formatValue(cycle)}
          </span>
        </a>
      ))}
    </Card>
  );
}

function Throughput({ model, state }: { model: SpeedModel; state: ReportState }) {
  const { merged, size, withinSize, linesMerged } = model.throughput;
  const max = Math.max(...merged.series.map((p) => p.value?.value ?? 0), 0);
  return (
    <Card title="Throughput" note={`PRs merged per ${model.window.grain}`}>
      <div class="throughput">
        {merged.series.map((point) => {
          const value = point.value?.value ?? null;
          const kind = value === null ? "missing" : point.bucket.partial ? "partial" : "";
          const label = `${capital(point.bucket.label)}: ${value === null ? "before the synced data" : `${num(value)} merged`}${point.bucket.partial ? " (so far)" : ""}`;
          return (
            <a
              key={point.bucket.start}
              class={kind}
              style={{
                height:
                  value === null ? "14%" : `${max > 0 ? Math.max(2, (value / max) * 100) : 2}%`,
              }}
              href={listHref(state, metricList("merged", point.span, "Speed › Throughput"))}
              title={label}
            >
              <span class="visually-hidden">{label}</span>
            </a>
          );
        })}
      </div>
      <div class="stats four">
        {[
          { tile: merged, label: "PRs merged" },
          { tile: size, label: `PR size (${statLabel(state.percentile)})` },
          { tile: withinSize, label: `Within ${num(model.sizeTargetLines)} lines` },
          { tile: linesMerged, label: "Lines merged" },
        ].map(({ tile, label }) => (
          <a
            key={tile.key}
            href={listHref(
              state,
              metricList(tile.key, tile.span, `Speed › ${metricOf(tile.key).label}`),
            )}
          >
            <span class="soft" style={{ fontSize: "12px" }}>
              {label}
            </span>
            <span class="value">{formatValue(tile.value)}</span>
            <span class="muted" style={{ fontSize: "11.5px" }}>
              {changeLine(tile.value, tile.previous)}
            </span>
          </a>
        ))}
      </div>
    </Card>
  );
}
