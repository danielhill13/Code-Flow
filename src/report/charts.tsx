import type { MetricValue, Phase, PhaseShare } from "../core/aggregate.ts";
import { formatValue, PHASE_LABELS, percent, statLabel, valueNote } from "../core/format.ts";
import type { Metric } from "../core/metrics.ts";

/** One period on a trend: its value, or why it has none. */
export type TrendPoint = {
  key: string;
  label: string;
  /** Null for a gap: hidden, no PRs, or before the data begins. */
  value: MetricValue | null;
};

const WIDTH = 240;
const HEIGHT = 64;
const PAD = 5;

/**
 * A metric over periods: a line through the periods that have a value, broken where one doesn't
 * (rule 4: a gap, never a zero). Hover a point for its value and how many PRs it rests on; click
 * it for those PRs.
 */
export function TrendChart(props: {
  metric: Metric;
  points: readonly TrendPoint[];
  percentile: number;
  selected: string | null;
  onPick: (periodKey: string) => void;
}) {
  const { metric, points } = props;
  const values = points.map((point) => point.value?.value ?? null);
  const present = values.filter((value): value is number => value !== null);
  // Shares always run 0–100%; everything else from 0 to its largest value.
  const max = metric.kind === "share" ? 1 : Math.max(...present, 0) || 1;
  const x = (i: number) => PAD + (i * (WIDTH - 2 * PAD)) / Math.max(1, points.length - 1);
  const y = (value: number) => HEIGHT - PAD - (value / max) * (HEIGHT - 2 * PAD);

  const segments: string[] = [];
  let path = "";
  values.forEach((value, i) => {
    if (value === null) {
      if (path) segments.push(path);
      path = "";
    } else {
      path += `${path ? "L" : "M"}${x(i).toFixed(1)},${y(value).toFixed(1)}`;
    }
  });
  if (path) segments.push(path);

  const scale = (value: number) =>
    formatValue({ metric, value, n: 0, notApplicable: 0 } satisfies MetricValue);

  return (
    <figure class="trend">
      <figcaption>
        {metric.label}
        {metric.kind === "distribution" && (
          <span class="muted"> · {statLabel(props.percentile)}</span>
        )}
      </figcaption>
      <div class="trend-body">
        {/* biome-ignore lint/a11y/useSemanticElements: SVG has no <fieldset>; "group" keeps the points reachable, where "img" would hide them */}
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="group"
          aria-label={`${metric.label} by period`}
        >
          <line class="baseline" x1={PAD} x2={WIDTH - PAD} y1={y(0)} y2={y(0)} />
          {segments.map((d) => (
            <path key={d} d={d} />
          ))}
          {points.map((point, i) => {
            const value = values[i] ?? null;
            const tip = point.value
              ? `${point.label}: ${formatValue(point.value)} (${point.value.n} PRs)${valueNote(point.value) ? ` · ${valueNote(point.value)}` : ""}`
              : `${point.label}: before the synced data`;
            return value === null ? (
              <circle key={point.key} class="gap" cx={x(i)} cy={y(0)} r={2}>
                <title>{tip}</title>
              </circle>
            ) : (
              // biome-ignore lint/a11y/useSemanticElements: SVG has no <button>; this circle is one, with keyboard support
              <circle
                key={point.key}
                class={point.key === props.selected ? "point selected" : "point"}
                cx={x(i)}
                cy={y(value)}
                r={point.key === props.selected ? 4 : 3}
                role="button"
                tabIndex={0}
                aria-label={`${tip}. Show its PRs`}
                onClick={() => props.onPick(point.key)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    props.onPick(point.key);
                  }
                }}
              >
                <title>{tip}</title>
              </circle>
            );
          })}
        </svg>
        <div class="scale muted">
          <span>{scale(max)}</span>
          <span>{scale(0)}</span>
        </div>
      </div>
      <div class="axis muted">
        <span>{points[0]?.label}</span>
        <span>{points.at(-1)?.label}</span>
      </div>
    </figure>
  );
}

/** Each period's cycle hours by phase, newest first. Shares of summed hours add up; medians don't. */
export function PhaseBars(props: {
  rows: readonly { label: string; phases: PhaseShare[] | null }[];
}) {
  return (
    <div class="phases">
      <div class="legend">
        {(Object.keys(PHASE_LABELS) as Phase[]).map((phase) => (
          <span key={phase}>
            <i class={`swatch ${phase}`} /> {PHASE_LABELS[phase]}
          </span>
        ))}
      </div>
      {props.rows.map(({ label, phases }) => (
        <div class="phase-row" key={label}>
          <span class="phase-label">{label}</span>
          {phases ? (
            <span class="bar">
              {phases.map((phase) => (
                <span
                  key={phase.phase}
                  class={`segment ${phase.phase}`}
                  style={{ width: `${phase.share * 100}%` }}
                  title={`${PHASE_LABELS[phase.phase]}: ${percent(phase.share)} of cycle hours`}
                />
              ))}
            </span>
          ) : (
            <span class="muted">no merged PRs</span>
          )}
        </div>
      ))}
    </div>
  );
}
