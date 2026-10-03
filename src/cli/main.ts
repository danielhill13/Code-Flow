#!/usr/bin/env node
import { Command } from "commander";
import { DEFAULT_CONFIG_FILE } from "../config/load.ts";
import { CodeflowError } from "../errors.ts";
import { VERSION } from "../version.ts";
import { type DoctorOptions, doctor } from "./doctor.ts";
import { type InitOptions, init } from "./init.ts";
import { type PrOptions, showPr } from "./pr.ts";
import { type StatusOptions, showStatus } from "./status.ts";
import { type SummaryOptions, summary } from "./summary.ts";
import { type SyncOptions, sync } from "./sync.ts";

const program = new Command("codeflow")
  .description("Code flow metrics for GitHub: first commit, through review, to merge.")
  .version(VERSION)
  .option("--debug", "show stack traces for unexpected errors");

program
  .command("init")
  .description("write a starter codeflow.yml")
  .option("--owner <login...>", "measure every repo an organization or user owns")
  .option("--repo <owner/name...>", "measure one repository")
  .option("--since <date>", "first day to measure, YYYY-MM-DD (default: a year ago)")
  .option("-c, --config <path>", "config file to write", DEFAULT_CONFIG_FILE)
  .option("--force", "replace an existing config file")
  .action((options: InitOptions) => init(options));

program
  .command("doctor")
  .description("check the token and selected repos, and estimate the first sync (read-only)")
  .option("-c, --config <path>", "config file", DEFAULT_CONFIG_FILE)
  .option("--all", "list every repo, including skipped ones")
  .action(async (options: DoctorOptions) => {
    process.exitCode = await doctor(options);
  });

program
  .command("sync")
  .description("fetch pull requests changed since the last sync; resumes if interrupted")
  .option("-c, --config <path>", "config file", DEFAULT_CONFIG_FILE)
  .action(async (options: SyncOptions) => {
    process.exitCode = await sync(options);
  });

program
  .command("status")
  .description("show what is synced locally and how the last sync went (no network)")
  .option("-c, --config <path>", "config file", DEFAULT_CONFIG_FILE)
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
  .option("-c, --config <path>", "config file", DEFAULT_CONFIG_FILE)
  .action(async (options: SummaryOptions) => {
    process.exitCode = await summary(options);
  });

program
  .command("pr")
  .description("show how codeflow reads one pull request, to check it against GitHub")
  .argument("<pr>", "owner/name#123, or just 123")
  .option("-c, --config <path>", "config file", DEFAULT_CONFIG_FILE)
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
