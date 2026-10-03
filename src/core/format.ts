// How values read, everywhere they are shown: the CLI and the report share these, so the same
// number never appears two ways (rule 11).
import type { MetricValue, Phase } from "./aggregate.ts";

export const PHASE_LABELS: Record<Phase, string> = {
  coding: "coding",
  pickup: "pickup",
  review: "review",
  mergeWait: "merge wait",
};

export const num = (n: number) => n.toLocaleString("en-US");

/** "45 min", "4.5 h", "2.1 d". */
export function duration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} d`;
}

/** "78%", or one decimal under 10%: "1.2%". */
export const percent = (share: number) =>
  share > 0 && share < 0.1 ? `${(share * 100).toFixed(1)}%` : `${Math.round(share * 100)}%`;

/** The name of a statistic: "median" for P50, "P75" and so on otherwise. */
export const statLabel = (p: number) => (p === 0.5 ? "median" : `P${Math.round(p * 100)}`);

/** A metric's value in its unit, or "—" when there is none. */
export function formatValue(value: MetricValue): string {
  if (value.value === null) return "—";
  const { metric } = value;
  if (metric.kind === "count") return num(value.value);
  if (metric.kind === "share") return percent(value.value);
  switch (metric.unit) {
    case "hours":
      return duration(value.value);
    case "lines":
      return `${num(Math.round(value.value))} lines`;
    case "count":
      return Number.isInteger(value.value) ? num(value.value) : value.value.toFixed(1);
  }
}

/** Why a value is missing or what it rests on, in a few words; "" when nothing needs saying. */
export function valueNote(value: MetricValue): string {
  if (value.hidden) return value.hidden;
  if (value.metric.key === "reverted" && value.notApplicable > 0) {
    return `${num(value.notApplicable)} merged too recently to tell`;
  }
  if (value.n === 0) return "no PRs";
  return "";
}
