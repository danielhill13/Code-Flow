import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import {
  applyImport,
  describeChanges,
  exportBundle,
  formatOf,
  parseParts,
  planImport,
  readBundle,
  renderBundle,
} from "../config/bundle.ts";
import { CodeflowError } from "../errors.ts";
import { dim, plural, status } from "./format.ts";
import { type OrgOptions, orgsFor } from "./session.ts";

export type ExportOptions = OrgOptions & { only?: string; format?: string; out?: string };

/** Writes an org's people, groups and rules (or the parts asked for) as a bundle. */
export async function exportConfig(options: ExportOptions): Promise<number> {
  const {
    orgs: [org],
  } = await orgsFor(options, true);
  if (!org) throw new CodeflowError("No org to export.");
  const parts = parseParts(options.only);
  const format = formatOf(options.out ?? "", options.format);
  if (format === "csv" && !parts.includes("groups")) {
    throw new CodeflowError("CSV holds teams: include groups in --only.");
  }
  const text = renderBundle(await exportBundle(org, parts), format);
  if (options.out) {
    await writeFile(options.out, text);
    console.error(status("ok", "Exported", `${org.name}'s ${parts.join(", ")} to ${options.out}`));
  } else {
    process.stdout.write(text);
  }
  return 0;
}

export type ImportOptions = OrgOptions & {
  only?: string;
  format?: string;
  mode?: string;
  dryRun?: boolean;
};

/**
 * Brings a bundle (or a CSV of teams) into an org: checks the result as a whole, says what
 * changes, and writes only when everything is valid and --dry-run isn't given.
 */
export async function importConfig(file: string, options: ImportOptions): Promise<number> {
  const {
    orgs: [org],
  } = await orgsFor(options, true);
  if (!org) throw new CodeflowError("No org to import into.");
  const mode = options.mode ?? "merge";
  if (mode !== "merge" && mode !== "replace") {
    throw new CodeflowError(`--mode takes merge or replace; not ${mode}.`);
  }
  const format = formatOf(file, options.format);
  const bundle = readBundle(await readFile(file, "utf8"), format, file);
  // A CSV holds teams (and names): import those, whatever --only says by default.
  const parts =
    format === "csv" ? parseParts(options.only ?? "people,groups") : parseParts(options.only);
  const plan = await planImport(org, bundle, parts, mode);

  const from = bundle.org ? ` (exported from ${bundle.org})` : "";
  console.log(status("ok", "Import", `${file}${from} into ${org.name}, ${mode} mode`));
  if (plan.changes.length === 0) {
    console.log(status("ok", "", "nothing would change"));
    return 0;
  }
  for (const line of describeChanges(plan.changes)) console.log(`  ${line}`);
  if (options.dryRun) {
    console.log(dim("Dry run: nothing written. Run again without --dry-run to apply."));
    return 0;
  }
  const written = await applyImport(org, plan);
  console.log(
    status(
      "ok",
      "Written",
      `${plural(plan.changes.length, "change")} in ${written.map(shown).join(", ")}`,
    ),
  );
  return 0;
}

/** A path from here when it's below here; otherwise in full. */
function shown(path: string): string {
  const near = relative(process.cwd(), path);
  return near && !near.startsWith("..") ? near : path;
}
