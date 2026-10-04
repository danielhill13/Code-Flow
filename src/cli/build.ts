import { existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ReportData } from "../core/source.ts";
import { CodeflowError } from "../errors.ts";
import { deriveFacts } from "../pipeline/derive.ts";
import { readTemplate, renderReport, reportData } from "../pipeline/report.ts";
import { Store } from "../store/store.ts";
import { plural, status } from "./format.ts";
import { type OrgOptions, orgsFor } from "./session.ts";

export type BuildOptions = OrgOptions & { out?: string; dataOnly?: boolean };

/** Above this, a static report is slow to open: `build` suggests `serve` instead. */
const HEAVY_BYTES = 2 * 1024 * 1024;

/**
 * Writes the report: one HTML file per org with that org's PRs inside, viewable offline. A file
 * never holds, or names, another org.
 */
export async function build(options: BuildOptions): Promise<number> {
  const { workspace, orgs } = await orgsFor(options);
  if (options.out && orgs.length > 1) {
    throw new CodeflowError("--out names one file: say which org with --org.");
  }
  let built = 0;
  for (const org of orgs) {
    if (!existsSync(org.dbPath)) {
      if (orgs.length === 1) throw new CodeflowError("Nothing synced yet. Run: codeflow sync");
      console.log(status("warn", "Report", `${org.name}: nothing synced yet, so no report`));
      continue;
    }
    let data: ReportData;
    const store = Store.open(org.dbPath);
    try {
      deriveFacts(store, org.config);
      data = reportData(store, org.config, workspace.single ? null : org.name);
    } finally {
      store.close();
    }
    // --data-only feeds the development server (npm run report:dev) instead of writing a page.
    const out =
      options.out ??
      (options.dataOnly
        ? join(dirname(org.dbPath), "report-data.json")
        : workspace.single
          ? "codeflow-report.html"
          : `codeflow-report-${org.name}.html`);
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
    if (!options.dataOnly && statSync(out).size > HEAVY_BYTES) {
      console.log(
        status(
          "info",
          "",
          "This file carries every PR so it can open offline, which makes it large. For a page " +
            "of about 40 KB that loads each view as you move around, run: codeflow serve",
        ),
      );
    }
    built += 1;
  }
  return built > 0 ? 0 : 1;
}
