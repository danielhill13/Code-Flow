import { existsSync, readFileSync } from "node:fs";
import type { Config } from "../config/schema.ts";
import type { ReportData } from "../core/source.ts";
import { CodeflowError } from "../errors.ts";
import type { Store } from "../store/store.ts";
import { coveredFrom } from "./coverage.ts";
import { groupsOf } from "./derive.ts";

/**
 * The report's page, built by Vite (npm run build:report) with an empty data slot. The path is
 * the same from src/pipeline and dist/pipeline, so it works in development and once published.
 */
const TEMPLATE = new URL("../../dist/report/index.html", import.meta.url);

/** Where the template leaves room for the data. */
const DATA_SLOT = '<script id="codeflow-data" type="application/json">null</script>';

/** Everything a report needs, from the store's current facts. */
export function reportData(
  store: Store,
  config: Config,
  org: string | null = null,
  now = new Date(),
): ReportData {
  const asOf = store.dataThrough();
  if (!asOf) {
    throw new CodeflowError(
      "No sync has finished cleanly yet, so the data has no as-of date. Run: codeflow sync",
    );
  }
  const repos = store.repos().map((repo) => repo.fullName);
  return {
    org,
    builtAt: now.toISOString(),
    asOf,
    coveredFrom: coveredFrom(store, repos),
    repos,
    groups: groupsOf(config, repos),
    facts: store.facts(),
    settings: { staleAfterDays: config.stale_after_days, peopleViews: config.people_views },
  };
}

export function readTemplate(): string {
  if (!existsSync(TEMPLATE)) {
    throw new CodeflowError(
      "The report page hasn't been built. In a clone of codeflow, run: npm run build:report",
    );
  }
  return readFileSync(TEMPLATE, "utf8");
}

/**
 * The report: the template with the data in its slot. Every `<` in the JSON is escaped, so no
 * PR title can end the script element early; JSON.parse reads `<` back as `<`.
 */
export function renderReport(template: string, data: ReportData): string {
  if (!template.includes(DATA_SLOT)) throw new Error("The report template has no data slot.");
  const json = JSON.stringify(data).replaceAll("<", "\\u003c");
  return template.replace(
    DATA_SLOT,
    () => `<script id="codeflow-data" type="application/json">${json}</script>`,
  );
}
