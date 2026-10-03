import { type Measurement, measure, populations, prValue } from "./aggregate.ts";
import type { PrFact } from "./facts.ts";
import { METRICS } from "./metrics.ts";
import { type Period, periodsEnding } from "./periods.ts";

/** What `codeflow build` puts into a report: enough to compute every view in it. */
export type ReportData = {
  builtAt: string;
  /** When the data was last known complete. */
  asOf: string;
  /** The first day the data fully covers, YYYY-MM-DD: no period may start before it. */
  coveredFrom: string;
  repos: string[];
  facts: PrFact[];
};

export type Meta = Omit<ReportData, "facts">;

export type Query = {
  period: Period;
  /** Null for every repo. */
  repos: readonly string[] | null;
  /** For distributions: 0.5 is the median. */
  percentile: number;
};

/** A PR behind a metric, with its value for that metric. */
export type PrRow = { pr: PrFact; value: number | boolean | null };

/**
 * Everything the report asks for, behind one interface. The static report answers from data
 * embedded in the page (EmbeddedSource); a hosted server will answer the same calls over HTTP.
 * Both compute with core/aggregate, so they can't disagree.
 */
export interface DataSource {
  meta(): Promise<Meta>;
  measure(query: Query): Promise<Measurement>;
  /** The `count` periods ending with the query's, oldest first; null where the data doesn't reach. */
  trend(query: Query, count: number): Promise<(Measurement | null)[]>;
  /** The PRs behind a metric's value in the query's period, sorted by their value for it. */
  prs(query: Query, metricKey: string): Promise<PrRow[]>;
  /** Counted PRs open as of the data, oldest first. */
  openPrs(repos: readonly string[] | null): Promise<PrFact[]>;
}

export class EmbeddedSource implements DataSource {
  readonly #data: ReportData;
  readonly #asOf: Date;

  constructor(data: ReportData) {
    this.#data = data;
    this.#asOf = new Date(data.asOf);
  }

  async meta(): Promise<Meta> {
    const { facts: _, ...meta } = this.#data;
    return meta;
  }

  async measure(query: Query): Promise<Measurement> {
    return this.#measure(query.period, query);
  }

  async trend(query: Query, count: number): Promise<(Measurement | null)[]> {
    return periodsEnding(query.period, count).map((period) =>
      period.start < this.#data.coveredFrom ? null : this.#measure(period, query),
    );
  }

  async prs(query: Query, metricKey: string): Promise<PrRow[]> {
    const metric = METRICS.find((m) => m.key === metricKey);
    if (!metric) return [];
    const ctx = { asOf: this.#asOf };
    const rows = populations(this.#facts(query.repos), query.period)
      [metric.population].map((pr) => ({ pr, value: prValue(metric, pr, ctx) }))
      .filter((row) => row.value !== null);
    // Largest first for numbers, "yes" first for shares, newest first for plain counts.
    return rows.sort((a, b) =>
      typeof a.value === "number" && typeof b.value === "number"
        ? b.value - a.value
        : Number(b.value) - Number(a.value) ||
          (b.pr.mergedAt ?? b.pr.closedAt ?? "").localeCompare(
            a.pr.mergedAt ?? a.pr.closedAt ?? "",
          ),
    );
  }

  async openPrs(repos: readonly string[] | null): Promise<PrFact[]> {
    return this.#facts(repos)
      .filter((pr) => pr.counted && pr.state === "open")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  #measure(period: Period, query: Query): Measurement {
    return measure(this.#facts(query.repos), period, {
      asOf: this.#asOf,
      percentile: query.percentile,
    });
  }

  #facts(repos: readonly string[] | null): readonly PrFact[] {
    return repos === null
      ? this.#data.facts
      : this.#data.facts.filter((pr) => repos.includes(pr.repo));
  }
}
