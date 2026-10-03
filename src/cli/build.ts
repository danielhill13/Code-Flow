import { existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadConfig } from "../config/load.ts";
import type { ReportData } from "../core/source.ts";
import { CodeflowError } from "../errors.ts";
import { deriveFacts } from "../pipeline/derive.ts";
import { readTemplate, renderReport, reportData } from "../pipeline/report.ts";
import { Store } from "../store/store.ts";
import { plural, status } from "./format.ts";
import { databasePath } from "./session.ts";

export type BuildOptions = { config: string; out?: string; dataOnly?: boolean };

/** Writes the report: one HTML file with every PR's facts inside, viewable offline. */
export async function build(options: BuildOptions): Promise<number> {
  const config = await loadConfig(options.config);
  const dbPath = databasePath(options.config, config);
  if (!existsSync(dbPath)) throw new CodeflowError("Nothing synced yet. Run: codeflow sync");

  let data: ReportData;
  const store = Store.open(dbPath);
  try {
    deriveFacts(store, config);
    data = reportData(store);
  } finally {
    store.close();
  }

  // --data-only feeds the development server (npm run report:dev) instead of writing a page.
  const out =
    options.out ??
    (options.dataOnly ? join(dirname(dbPath), "report-data.json") : "codeflow-report.html");
  await writeFile(
    out,
    options.dataOnly ? JSON.stringify(data) : renderReport(readTemplate(), data),
  );
  const megabytes = (statSync(out).size / 1024 / 1024).toFixed(1);
  console.log(
    status(
      "ok",
      "Report",
      `${out} (${megabytes} MB): ${plural(data.facts.length, "PR")} from ${data.repos.join(", ")}`,
    ),
  );
  return 0;
}
