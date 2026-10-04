// How values read, everywhere they are shown: the CLI and the report share these, so the same
// number never appears two ways (rule 11).
import type { MetricValue, Phase } from "./aggregate.ts";
import type { PrFact } from "./facts.ts";
import { metricOf } from "./metrics.ts";
import { statLabel } from "./stats.ts";

export { statLabel };

export const PHASE_LABELS: Record<Phase, string> = {
  coding: "coding",
  pickup: "pickup",
  review: "review",
  mergeWait: "merge wait",
};

export const num = (n: number) => n.toLocaleString("en-US");

/** "45 min", "4.5 h", "2.1 d", and whole days from 100: "1,064 d". */
export function duration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  if (hours < 2400) return `${(hours / 24).toFixed(1)} d`;
  return `${num(Math.round(hours / 24))} d`;
}

/**
 * Hours written in the unit `like` would be written in, so two values compare at a glance:
 * 31.6 hours next to 3.1 days reads "1.3 d". Minutes and hours stay as duration() writes them.
 */
export function durationLike(hours: number, like: number): string {
  if (like < 1 && hours < 48) return `${Math.round(hours * 60)} min`;
  if (like < 48 && hours >= 1 / 60 && hours < 2400) {
    return hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toFixed(1)} h`;
  }
  if (like >= 48) {
    return hours >= 2400 ? `${num(Math.round(hours / 24))} d` : `${(hours / 24).toFixed(1)} d`;
  }
  return duration(hours);
}

/** "78%", or one decimal under 10%: "1.2%". */
export const percent = (share: number) =>
  share > 0 && share < 0.1 ? `${(share * 100).toFixed(1)}%` : `${Math.round(share * 100)}%`;

/** "1 PR", "12 PRs". */
export const prs = (count: number) => `${num(count)} ${count === 1 ? "PR" : "PRs"}`;

/** A metric's value in its unit, or "—" when there is none. */
export function formatValue(value: MetricValue): string {
  if (value.value === null) return "—";
  const metric = metricOf(value.key);
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
  if (value.key === "reverted" && value.notApplicable > 0) {
    return `${num(value.notApplicable)} merged too recently to tell`;
  }
  if (value.n === 0) return "no PRs";
  return "";
}

/** Names, the first few of them: "ana.r, devon +3". Teams read "@slug". */
export function names(people: readonly string[], teams: readonly string[] = [], max = 2): string {
  const all = [...people, ...teams.map((team) => `@${team}`)];
  return all.length <= max + 1
    ? all.join(", ")
    : `${all.slice(0, max).join(", ")} +${all.length - max}`;
}

/** Whose move it is on an open PR, in a few words: "ana.r, devon · asked 12.0 d ago". */
export function waitingOnText(pr: Pick<PrFact, "waitingOn" | "waitingSince">, asOf: Date): string {
  const { waitingOn } = pr;
  if (waitingOn === null) return "";
  const ago =
    pr.waitingSince === null
      ? ""
      : ` ${duration(Math.max(0, asOf.getTime() - Date.parse(pr.waitingSince)) / 3_600_000)} ago`;
  switch (waitingOn.why) {
    case "draft":
      return "author · draft";
    case "changes_requested":
      return `author · changes asked${ago}`;
    case "review_comments":
      return `author · reviewed${ago}`;
    case "requested":
      return `${names(waitingOn.people, waitingOn.teams)} · asked${ago}`;
    case "unassigned":
      return "no reviewer asked";
    case "re_review":
      return `${names(waitingOn.people, waitingOn.teams)} · pushed again${ago}`;
    case "approved":
      return `merge · approved${ago}`;
  }
}
