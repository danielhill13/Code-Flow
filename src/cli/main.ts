#!/usr/bin/env node
import { Command } from "commander";
import { DEFAULT_CONFIG_FILE } from "../config/load.ts";
import { CodeflowError } from "../errors.ts";
import { VERSION } from "../version.ts";
import { type DoctorOptions, doctor } from "./doctor.ts";
import { type InitOptions, init } from "./init.ts";
import { type StatusOptions, showStatus } from "./status.ts";
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
