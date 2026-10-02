import { writeFile } from "node:fs/promises";
import { stringify } from "yaml";
import { parseConfig } from "../config/load.ts";
import { CodeflowError } from "../errors.ts";

export type InitOptions = {
  config: string;
  owner?: string[];
  repo?: string[];
  since?: string;
  force?: boolean;
};

export async function init(options: InitOptions): Promise<void> {
  const owners = options.owner ?? [];
  const repos = options.repo ?? [];
  if (owners.length + repos.length === 0) {
    throw new CodeflowError(
      "Say what to measure: --owner <org-or-user> and/or --repo <owner/name>. Both can repeat.",
    );
  }
  const text = renderConfig({ owners, repos, since: options.since ?? defaultSince() });
  parseConfig(text, options.config); // never write a config that loading would reject

  try {
    await writeFile(options.config, text, { flag: options.force ? "w" : "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CodeflowError(`${options.config} already exists. Use --force to replace it.`);
    }
    throw err;
  }
  console.log(`Wrote ${options.config}. Next: codeflow doctor`);
}

export function renderConfig(input: { owners: string[]; repos: string[]; since: string }): string {
  return [
    "# codeflow configuration. codeflow.example.yml describes every option.",
    "",
    "sources:",
    ...input.owners.map((owner) => `  - owner: ${scalar(owner)}`),
    ...input.repos.map((repo) => `  - repo: ${scalar(repo)}`),
    "",
    "# Measure pull requests active on or after this date.",
    `since: ${scalar(input.since)}`,
    "",
  ].join("\n");
}

/** The first of the month a year back: a full year of history, with no partial first month. */
export function defaultSince(today = new Date()): string {
  return new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

/** YAML for one string, quoted only when needed (an org named `true` or `123` must stay text). */
function scalar(value: string): string {
  return stringify(value).trimEnd();
}
