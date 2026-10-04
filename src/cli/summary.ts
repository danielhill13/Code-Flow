import { existsSync } from "node:fs";
import picomatch from "picomatch";
import { CONCENTRATION_SHARE, type Measurement, measure } from "../core/aggregate.ts";
import { formatValue, PHASE_LABELS, statLabel, valueNote } from "../core/format.ts";
import { METRICS, metricOf } from "../core/metrics.ts";
import { isComplete, lastCompletePeriod, parsePeriod } from "../core/periods.ts";
import { CodeflowError } from "../errors.ts";
import { assertCovered, coveredFrom } from "../pipeline/coverage.ts";
import { deriveFacts } from "../pipeline/derive.ts";
import { Store } from "../store/store.ts";
import { branchWarnings } from "./branches.ts";
import { bold, dim, num, plural, status, table } from "./format.ts";
import { type OrgOptions, orgsFor, type Print } from "./session.ts";

export type SummaryOptions = OrgOptions & {
  period?: string;
  repo?: string;
  percentile?: string;
  explain?: boolean;
  json?: boolean;
};

/** Metrics for one period, from local data only (no network). */
export async function summary(options: SummaryOptions): Promise<number> {
  const print: Print = (line = "") => console.log(line);
  const {
    orgs: [org],
  } = await orgsFor(options, true);
  if (!org) throw new CodeflowError("No org to read.");
  const { config, dbPath } = org;
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
    assertCovered(period, coveredFrom(store, repos));
    const result = measure(facts, period, {
      asOf,
      percentile: parsePercentile(options.percentile),
      staleAfterDays: config.stale_after_days,
    });

    const warnings = branchWarnings(store, org, asOf);
    if (options.json) {
      print(JSON.stringify(toJson(result, repos), null, 2));
    } else {
      printSummary(result, repos, isComplete(period, asOf), print, config.stale_after_days);
      if (warnings.length > 0) print();
      for (const line of warnings) print(line);
      if (options.explain) printDefinitions(print);
    }
    return 0;
  } finally {
    store.close();
  }
}

function printSummary(
  result: Measurement,
  repos: string[],
  complete: boolean,
  print: Print,
  staleAfterDays: number,
): void {
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

  const statName = statLabel(result.percentile);
  const rows: string[][] = [];
  let group = "";
  for (const value of result.values) {
    const metric = metricOf(value.key);
    if (metric.group !== group) {
      group = metric.group;
      rows.push([group, "", "", ""]);
    }
    rows.push([`  ${metric.label}`, formatValue(value), num(value.n), valueNote(value)]);
  }
  print(table(["", statName, "PRs", ""], rows, { rightAlign: [1, 2] }));
  print();

  if (result.phases) {
    const split = result.phases
      .map((p) => `${PHASE_LABELS[p.phase]} ${Math.round(p.share * 100)}%`)
      .join(" · ");
    print(`Where the time went: ${split}`);
    for (const phase of result.phases) {
      if (phase.largestShare >= CONCENTRATION_SHARE) {
        print(
          dim(
            `  #${phase.largestPr} alone is ${Math.round(phase.largestShare * 100)}% of all ` +
              `${PHASE_LABELS[phase.phase]} time: one PR, not a habit`,
          ),
        );
      }
    }
  }
  const { count, drafts, medianAgeDays, stale } = result.open;
  const age = medianAgeDays === null ? "" : `, median age ${Math.round(medianAgeDays)} days`;
  print(`Open now: ${plural(count, "PR")} (${num(drafts)} drafts)${age}`);
  if (stale > 0) {
    print(
      `Stale: ${plural(stale, "open PR")} with no activity for more than ${staleAfterDays} days`,
    );
  }

  const excluded = [
    result.excluded.base &&
      `${plural(result.excluded.base, "PR")} into branches that aren't measured`,
    result.excluded.promotion &&
      `${plural(result.excluded.promotion, "promotion")} between long-lived branches`,
    result.excluded.bot && `${plural(result.excluded.bot, "PR")} by bots`,
    result.excluded.rule && `${plural(result.excluded.rule, "PR")} left out by the org's rules`,
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
    metrics: result.values.map(({ key, value, n, hidden, notApplicable }) => {
      const metric = metricOf(key);
      return {
        key,
        label: metric.label,
        group: metric.group,
        kind: metric.kind,
        unit: "unit" in metric ? metric.unit : metric.kind === "share" ? "share" : "prs",
        value,
        n,
        notApplicable,
        ...(hidden && { hidden }),
      };
    }),
    phases: result.phases,
    open: result.open,
    excluded: result.excluded,
    truncated: result.truncated,
  };
}
