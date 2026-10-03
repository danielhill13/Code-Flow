#!/usr/bin/env node
import { Command } from "commander";
import { DEFAULT_CONFIG_FILE } from "../config/load.ts";
import { CodeflowError } from "../errors.ts";
import { VERSION } from "../version.ts";
import { type BuildOptions, build } from "./build.ts";
import { type DoctorOptions, doctor } from "./doctor.ts";
import { type InitOptions, init } from "./init.ts";
import { type MigrateOptions, migrate } from "./migrate.ts";
import { type PrOptions, showPr } from "./pr.ts";
import { listRules, type RulesOptions, type RulesTestOptions, testRules } from "./rules.ts";
import { type ServeOptions, serve } from "./serve.ts";
import { type StatusOptions, showStatus } from "./status.ts";
import { type SummaryOptions, summary } from "./summary.ts";
import { type SyncOptions, sync } from "./sync.ts";
import { type ExportOptions, exportConfig, type ImportOptions, importConfig } from "./transfer.ts";

const program = new Command("codeflow")
  .description("Code flow metrics for GitHub: first commit, through review, to merge.")
  .version(VERSION)
  .option("--debug", "show stack traces for unexpected errors");

program
  .command("init")
  .description("add an org to the workspace, creating the workspace if there is none")
  .option("--org <name>", "the org's name (default: from the first owner)")
  .option("--owner <login...>", "measure every repo an organization or user owns")
  .option("--repo <owner/name...>", "measure one repository")
  .option("--since <date>", "first day to measure, YYYY-MM-DD (default: a year ago)")
  .option("-c, --config <path>", "workspace file", DEFAULT_CONFIG_FILE)
  .option("--force", "rewrite the org's org.yml if it exists")
  .action((options: InitOptions) => init(options));

program
  .command("migrate")
  .description("turn a single-file config into a workspace with one org, moving its data")
  .option("--org <name>", "the org's name (default: from the first source)")
  .option("-c, --config <path>", "the config file to turn into a workspace", DEFAULT_CONFIG_FILE)
  .action((options: MigrateOptions) => migrate(options));

program
  .command("doctor")
  .description("check the token and selected repos, and estimate the first sync (read-only)")
  .option("-c, --config <path>", "workspace or config file", DEFAULT_CONFIG_FILE)
  .option("--org <name>", "only this org; needed by some commands when there are several")
  .option("--all", "list every repo, including skipped ones")
  .action(async (options: DoctorOptions) => {
    process.exitCode = await doctor(options);
  });

program
  .command("sync")
  .description("fetch pull requests changed since the last sync; resumes if interrupted")
  .option("-c, --config <path>", "workspace or config file", DEFAULT_CONFIG_FILE)
  .option("--org <name>", "only this org; needed by some commands when there are several")
  .action(async (options: SyncOptions) => {
    process.exitCode = await sync(options);
  });

program
  .command("status")
  .description("show what is synced locally and how the last sync went (no network)")
  .option("-c, --config <path>", "workspace or config file", DEFAULT_CONFIG_FILE)
  .option("--org <name>", "only this org; needed by some commands when there are several")
  .action(async (options: StatusOptions) => {
    process.exitCode = await showStatus(options);
  });

program
  .command("summary")
  .description("metrics for a period, from synced data (no network)")
  .option("-p, --period <period>", "2026-09, 2026-Q3 or 2026 (default: the last complete month)")
  .option("-r, --repo <owner/name>", "only this repo; globs work")
  .option("--percentile <n>", "show this percentile instead of the median, e.g. 75")
  .option("--explain", "print each metric's definition")
  .option("--json", "print JSON instead of a table")
  .option("-c, --config <path>", "workspace or config file", DEFAULT_CONFIG_FILE)
  .option("--org <name>", "only this org; needed by some commands when there are several")
  .action(async (options: SummaryOptions) => {
    process.exitCode = await summary(options);
  });

program
  .command("build")
  .description("write the report: one HTML file that opens offline (no network)")
  .option("-o, --out <file>", "where to write it (default: codeflow-report.html)")
  .option("--data-only", "write just the report's data, for the development server")
  .option("-c, --config <path>", "workspace or config file", DEFAULT_CONFIG_FILE)
  .option("--org <name>", "only this org; needed by some commands when there are several")
  .action(async (options: BuildOptions) => {
    process.exitCode = await build(options);
  });

program
  .command("export")
  .description("write an org's people, groups and rules as a bundle, to move, keep or share")
  .option("-c, --config <path>", "workspace or config file", DEFAULT_CONFIG_FILE)
  .option("--org <name>", "which org; needed when there are several")
  .option("--only <parts>", "any of settings,people,groups,rules (default: people,groups,rules)")
  .option("--format <format>", "yaml, json, or csv for teams (default: from --out, else yaml)")
  .option("-o, --out <file>", "where to write it (default: standard output)")
  .action(async (options: ExportOptions) => {
    process.exitCode = await exportConfig(options);
  });

program
  .command("import")
  .description("bring a bundle or a CSV of teams into an org, checking it first")
  .argument(
    "<file>",
    "a bundle (.yml, .json) or a CSV of teams (team,login,from,to,secondary,name)",
  )
  .option("-c, --config <path>", "workspace or config file", DEFAULT_CONFIG_FILE)
  .option("--org <name>", "which org; needed when there are several")
  .option("--only <parts>", "any of settings,people,groups,rules (default: people,groups,rules)")
  .option(
    "--mode <mode>",
    "merge: add and update entries; replace: the bundle's keys replace the org's",
    "merge",
  )
  .option("--format <format>", "yaml, json or csv (default: from the file's extension)")
  .option("--dry-run", "say what would change, and write nothing")
  .action(async (file: string, options: ImportOptions) => {
    process.exitCode = await importConfig(file, options);
  });

const rules = program
  .command("rules")
  .description("an org's rules: list them (the default), or test a draft");

rules
  .command("list", { isDefault: true })
  .description("list an org's rules, where each came from and how many PRs it applies to")
  .option("-c, --config <path>", "workspace or config file", DEFAULT_CONFIG_FILE)
  .option("--org <name>", "which org; needed when there are several")
  .action(async (options: RulesOptions) => {
    process.exitCode = await listRules(options);
  });

rules
  .command("test")
  .description("show what the rules in a file would change, without saving anything")
  .argument("<file>", "a rules file, in rules.yml's form, to try in place of the org's")
  .option("-c, --config <path>", "workspace or config file", DEFAULT_CONFIG_FILE)
  .option("--org <name>", "which org; needed when there are several")
  .option("--limit <n>", "PRs to list per change", "10")
  .action(async (file: string, options: RulesTestOptions) => {
    process.exitCode = await testRules(file, options);
  });

program
  .command("serve")
  .description("the report as a web app on this machine, with every org's config editable")
  .option("-c, --config <path>", "workspace or config file", DEFAULT_CONFIG_FILE)
  .option("-p, --port <port>", "port to listen on", "4317")
  .option(
    "--host <host>",
    "address to listen on; anything but this machine has no sign-in yet",
    "127.0.0.1",
  )
  .action((options: ServeOptions) => serve(options));

program
  .command("pr")
  .description("show how codeflow reads one pull request, to check it against GitHub")
  .argument("<pr>", "owner/name#123, or just 123")
  .option("-c, --config <path>", "workspace or config file", DEFAULT_CONFIG_FILE)
  .option("--org <name>", "only this org; needed by some commands when there are several")
  .action(async (target: string, options: PrOptions) => {
    process.exitCode = await showPr(target, options);
  });

try {
  await program.parseAsync();
} catch (err) {
  process.exitCode = 1;
  if (err instanceof CodeflowError) {
    console.error(`error: ${err.message}`);
  } else if (program.opts().debug) {
    console.error(err);
  } else {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    console.error("Run again with --debug for details.");
  }
}
