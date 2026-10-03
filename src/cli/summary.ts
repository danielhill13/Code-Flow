import { existsSync } from "node:fs";
import picomatch from "picomatch";
import { loadConfig } from "../config/load.ts";
import { type Measurement, type MetricValue, measure, type Phase } from "../core/aggregate.ts";
import { METRICS } from "../core/metrics.ts";
import { isComplete, lastCompletePeriod, type Period, parsePeriod } from "../core/periods.ts";
import { CodeflowError } from "../errors.ts";
import { deriveFacts } from "../pipeline/derive.ts";
import { Store } from "../store/store.ts";
import { bold, dim, num, plural, status, table } from "./format.ts";
import { databasePath, type Print } from "./session.ts";

export type SummaryOptions = {
  config: string;
  period?: string;
  repo?: string;
  percentile?: string;
  explain?: boolean;
  json?: boolean;
};

const PHASES: Record<Phase, string> = {
  coding: "coding",
  pickup: "pickup",
  review: "review",
  mergeWait: "merge wait",
};

/** A phase holding this share of its hours in one PR gets a warning: one PR moved the number. */
const CONCENTRATION_WARNING = 0.25;

/** Metrics for one period, from local data only (no network). */
export async function summary(options: SummaryOptions): Promise<number> {
  const print: Print = (line = "") => console.log(line);
  const config = await loadConfig(options.config);
  const dbPath = databasePath(options.config, config);
  if (!existsSync(dbPath)) throw new CodeflowError("Nothing synced yet. Run: codeflow sync");

  const store = Store.open(dbPath);
  try {
    deriveFacts(store, config);
    const through = store.dataThrough();
    if (!through) {
      throw new CodeflowError(
        "No sync has finished cleanly yet, so the data has no as-of date. Run: codeflow sync",
      );
    }
    const asOf = new Date(through);
    const period = options.period ? parsePeriod(options.period) : lastCompletePeriod("month", asOf);
    if (!period) {
      throw new CodeflowError(
        `Can't read the period "${options.period}". Use 2026-09, 2026-Q3 or 2026.`,
      );
    }

    let facts = store.facts();
    if (options.repo) {
      const matches = picomatch(options.repo, { nocase: true });
      facts = facts.filter((fact) => matches(fact.repo));
      if (facts.length === 0) {
        const known = store
          .repos()
          .map((repo) => repo.fullName)
          .join(", ");
        throw new CodeflowError(`No synced repo matches ${options.repo}. Synced: ${known}`);
      }
    }
    const repos = [...new Set(facts.map((fact) => fact.repo))].sort();
    checkCoverage(store, repos, period);
    const result = measure(facts, period, {
      asOf,
      percentile: parsePercentile(options.percentile),
    });

    if (options.json) {
      print(JSON.stringify(toJson(result, repos), null, 2));
    } else {
      printSummary(result, repos, isComplete(period, asOf), print);
      if (options.explain) printDefinitions(print);
    }
    return 0;
  } finally {
    store.close();
  }
}

/**
 * Sync stores every PR updated since `since`, so any period from then on is complete. An
 * earlier period would hold only the stragglers that happened to be updated later: refuse it
 * rather than show numbers that look real and aren't.
 */
function checkCoverage(store: Store, repos: readonly string[], period: Period): void {
  const selected = store.repoSummaries().filter((repo) => repos.includes(repo.fullName));
  const unfinished = selected.filter((repo) => repo.coveredSince === null);
  if (unfinished.length > 0) {
    const names = unfinished.map((repo) => repo.fullName).join(", ");
    throw new CodeflowError(
      `The first sync of ${names} hasn't finished. Run codeflow sync to finish it.`,
    );
  }
  const from = selected.reduce((latest, repo) => {
    const since = repo.coveredSince ?? "";
    return since > latest ? since : latest;
  }, "");
  if (period.start < from) {
    throw new CodeflowError(
      `${period.label} starts before ${from}, where the synced data begins, so PRs would be missing. ` +
        "Pick a later period, or move `since` earlier in codeflow.yml and sync again.",
    );
  }
}

function printSummary(result: Measurement, repos: string[], complete: boolean, print: Print): void {
  const scope = repos.length <= 3 ? repos.join(", ") : `${plural(repos.length, "repo")}`;
  print(
    status(
      "ok",
      "Summary",
      `${scope} · ${result.period.label} · data through ${when(result.asOf)}`,
    ),
  );
  if (!complete) {
    print(status("warn", "", "This period isn't over: counts and totals will still grow."));
  }
  print();

  const statName = result.percentile === 0.5 ? "median" : `P${Math.round(result.percentile * 100)}`;
  const rows: string[][] = [];
  let group = "";
  for (const value of result.values) {
    if (value.metric.group !== group) {
      group = value.metric.group;
      rows.push([group, "", "", ""]);
    }
    rows.push([`  ${value.metric.label}`, format(value), num(value.n), note(value)]);
  }
  print(table(["", statName, "PRs", ""], rows, { rightAlign: [1, 2] }));
  print();

  if (result.phases) {
    const split = result.phases
      .map((p) => `${PHASES[p.phase]} ${Math.round(p.share * 100)}%`)
      .join(" · ");
    print(`Where the time went: ${split}`);
    for (const phase of result.phases) {
      if (phase.largestShare >= CONCENTRATION_WARNING) {
        print(
          dim(
            `  #${phase.largestPr} alone is ${Math.round(phase.largestShare * 100)}% of all ` +
              `${PHASES[phase.phase]} time: one PR, not a habit`,
          ),
        );
      }
    }
  }
  const { count, drafts, medianAgeDays } = result.open;
  const age = medianAgeDays === null ? "" : `, median age ${Math.round(medianAgeDays)} days`;
  print(`Open now: ${plural(count, "PR")} (${num(drafts)} drafts)${age}`);

  const excluded = [
    result.excluded.base &&
      `${plural(result.excluded.base, "PR")} into branches that aren't measured`,
    result.excluded.promotion &&
      `${plural(result.excluded.promotion, "promotion")} between long-lived branches`,
    result.excluded.bot && `${plural(result.excluded.bot, "PR")} by bots`,
  ].filter(Boolean);
  if (excluded.length > 0)
    print(dim(`Not counted, though merged in the period: ${excluded.join(", ")}`));
  if (result.truncated.length > 0) {
    print(
      dim(
        `GitHub sent incomplete data for ${plural(result.truncated.length, "PR")} ` +
          `(${result.truncated.map((n) => `#${n}`).join(", ")}): see codeflow pr <number>`,
      ),
    );
  }
}

function printDefinitions(print: Print): void {
  print();
  print(bold("Definitions"));
  for (const metric of METRICS) print(`  ${metric.label}: ${metric.definition}`);
}

/** A value in its unit: "4.5 h", "2.1 d", "64 lines", "78%". */
export function format(value: MetricValue): string {
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

function note(value: MetricValue): string {
  if (value.hidden) return value.hidden;
  if (value.metric.key === "reverted" && value.notApplicable > 0) {
    return `${num(value.notApplicable)} merged too recently to tell`;
  }
  if (value.n === 0) return "no PRs";
  return "";
}

export function duration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} d`;
}

const percent = (share: number) =>
  share > 0 && share < 0.1 ? `${(share * 100).toFixed(1)}%` : `${Math.round(share * 100)}%`;

const when = (iso: string) =>
  new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

function parsePercentile(text: string | undefined): number {
  if (text === undefined) return 0.5;
  const p = Number(text.replace(/^p/i, ""));
  if (!Number.isFinite(p) || p <= 0 || p >= 100) {
    throw new CodeflowError(
      `--percentile takes a number between 1 and 99, like 75 (got "${text}").`,
    );
  }
  return p / 100;
}

function toJson(result: Measurement, repos: string[]) {
  return {
    repos,
    period: result.period,
    asOf: result.asOf,
    percentile: result.percentile,
    metrics: result.values.map(({ metric, value, n, hidden, notApplicable }) => ({
      key: metric.key,
      label: metric.label,
      group: metric.group,
      kind: metric.kind,
      unit: "unit" in metric ? metric.unit : metric.kind === "share" ? "share" : "prs",
      value,
      n,
      notApplicable,
      ...(hidden && { hidden }),
    })),
    phases: result.phases,
    open: result.open,
    excluded: result.excluded,
    truncated: result.truncated,
  };
}
