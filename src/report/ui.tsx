// Small pieces every tab uses. Values come formatted from core/format and core/compare, so a
// number reads the same here as in the CLI (rule 11).
import type { ComponentChildren } from "preact";
import type { MetricValue } from "../core/aggregate.ts";
import { change, changeText } from "../core/compare.ts";
import { formatValue, prs } from "../core/format.ts";
import type { Breakdown } from "../core/selection.ts";
import type { Point, Tile as TileModel } from "../core/views/context.ts";

export function Segmented<T extends string | number>(props: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  small?: boolean;
  hideLabel?: boolean;
}) {
  return (
    <fieldset class="control">
      <legend class={props.hideLabel ? "visually-hidden" : undefined}>{props.label}</legend>
      <div class={props.small ? "seg small" : "seg"}>
        {props.options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={option.value === props.value}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function Card(props: {
  title: string;
  note?: ComponentChildren;
  end?: ComponentChildren;
  flush?: boolean;
  class?: string;
  children?: ComponentChildren;
}) {
  return (
    <section class={`card${props.flush ? " flush" : ""}${props.class ? ` ${props.class}` : ""}`}>
      <div class="card-head">
        <h2>{props.title}</h2>
        {props.note && <span class="note">{props.note}</span>}
        {props.end && <span class="end">{props.end}</span>}
      </div>
      {props.children}
    </section>
  );
}

export type SparkPoint = { value: number | null; partial: boolean; title: string };

/** Bars: the last whole one dark, one still running hollow, a missing one dashed. */
export function Spark(props: { points: readonly SparkPoint[]; class?: string }) {
  const values = props.points.map((p) => p.value).filter((v): v is number => v !== null);
  const max = Math.max(...values, 0);
  const last = props.points.findLastIndex((p) => !p.partial && p.value !== null);
  return (
    <div class={`spark${props.class ? ` ${props.class}` : ""}`} aria-hidden="true">
      {props.points.map((point, i) => {
        const kind =
          point.value === null ? "missing" : point.partial ? "partial" : i === last ? "last" : "";
        const height =
          point.value === null ? 14 : max > 0 ? Math.max(5, (point.value / max) * 100) : 5;
        return <i key={i} class={kind} style={{ height: `${height}%` }} title={point.title} />;
      })}
    </div>
  );
}

/** A metric's trend as spark points, with a title per point. */
export function seriesPoints(series: readonly Point[]): SparkPoint[] {
  return series.map(({ bucket, value }) => ({
    value: value?.value ?? null,
    partial: bucket.partial,
    title: `${capital(bucket.label)}: ${
      value === null
        ? "before the synced data"
        : value.value === null
          ? (value.hidden ?? "no PRs")
          : formatValue(value)
    }${bucket.partial ? " (so far)" : ""}`,
  }));
}

/** "↑ 8% from 319", or why the value is missing. */
export function changeLine(value: MetricValue, previous: MetricValue | null): string {
  if (value.value === null) return value.hidden ?? (value.n === 0 ? "no PRs" : "");
  return changeText(change(value, previous), previous);
}

export function MetricTile(props: {
  tile: TileModel;
  label: string;
  href: string;
  small?: boolean;
  accent?: boolean;
  /** Text after the change line. */
  more?: ComponentChildren;
  /** Above the value, at the right. Defaults to the PR count. */
  aside?: ComponentChildren;
  swatch?: string;
  children?: ComponentChildren;
}) {
  const { tile } = props;
  return (
    <a class={`tile${props.accent ? " accent" : ""}`} href={props.href}>
      <div class="tile-label">
        <span style={{ display: "flex", alignItems: "center", gap: "7px" }}>
          {props.swatch && <span class={`swatch ${props.swatch}`} />}
          {props.label}
        </span>
        <span class="n num">{props.aside ?? prs(tile.value.n)}</span>
      </div>
      <div class={`tile-value${props.small ? " small" : ""}`}>{formatValue(tile.value)}</div>
      <div class="tile-change">
        {changeLine(tile.value, tile.previous)}
        {props.more}
      </div>
      <Spark points={seriesPoints(tile.series)} class={props.small ? "short" : undefined} />
      {props.children}
    </a>
  );
}

export const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Data through "Oct 2, 2026 at 7:12 PM", in the reader's time zone. */
export function when(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${day} at ${time}`;
}

/** "Sep 18", or "Sep 18, 2025" outside the data's year. */
export function shortDate(iso: string, year?: number): string {
  const date = new Date(iso);
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
  if (year !== undefined && date.getUTCFullYear() !== year) options.year = "numeric";
  return date.toLocaleDateString("en-US", options);
}

/** The breakdowns a selection offers, and switching between them. */
export type BreakdownChoice = {
  offered: Breakdown[];
  /** The breakdown in use: chosen, or the selection's default. */
  current: Breakdown | null;
  onChange: (by: Breakdown) => void;
};

/**
 * Where a breakdown would have one row (every PR here is in one product, say): nothing to
 * tabulate, but the switch stays, to pick another.
 */
export function SingleBreakdown(props: { choice: BreakdownChoice; name: string }) {
  const { current } = props.choice;
  if (current === null || props.choice.offered.length < 2) return null;
  return (
    <section class="card" style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap" }}>
      <span class="muted" style={{ fontSize: "13px" }}>
        Every PR in {props.name} is in one {breakdownLabel(current).toLowerCase()}, so there is
        nothing to break down by it.
      </span>
      <span style={{ marginLeft: "auto" }}>
        <BreakdownControl choice={props.choice} value={current} />
      </span>
    </section>
  );
}

/** "Team", "Repo", or a kind of group: "Product", "Area". */
export function breakdownLabel(by: Breakdown): string {
  if (by === "team") return "Team";
  if (by === "repo") return "Repo";
  return capital(by.slice("group:".length));
}

/** "Teams", "Repos", "Products". */
export const breakdownPlural = (by: Breakdown) => `${breakdownLabel(by)}s`;

export function BreakdownControl(props: { choice: BreakdownChoice; value: Breakdown }) {
  if (props.choice.offered.length < 2) return null;
  return (
    <Segmented
      label="Break down by"
      small
      options={props.choice.offered.map((by) => ({ value: by, label: breakdownLabel(by) }))}
      value={props.value}
      onChange={props.choice.onChange}
    />
  );
}
