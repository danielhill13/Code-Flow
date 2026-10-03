// Small pieces every tab uses. Values come formatted from core/format and core/compare, so a
// number reads the same here as in the CLI (rule 11).
import type { ComponentChildren } from "preact";
import type { MetricValue } from "../core/aggregate.ts";
import { change, changeText } from "../core/compare.ts";
import { formatValue, prs } from "../core/format.ts";
import type { Dimension } from "../core/selection.ts";
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
export type BreakdownChoice = { offered: Dimension[]; onChange: (by: Dimension) => void };

const BY_LABEL: Record<Dimension, string> = {
  team: "Team",
  product: "Product",
  repo: "Repo",
  person: "Person",
};

export function BreakdownControl(props: { choice: BreakdownChoice; value: Dimension }) {
  if (props.choice.offered.length < 2) return null;
  return (
    <Segmented
      label="Break down by"
      small
      options={props.choice.offered.map((d) => ({ value: d, label: BY_LABEL[d] }))}
      value={props.value}
      onChange={props.choice.onChange}
    />
  );
}
