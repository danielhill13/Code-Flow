// A workspace holds one or more orgs (decision D29). An org is a tenant: its own sources (GitHub
// organizations and repos today; Azure DevOps and Jira later), people, groups and rules, in a
// folder of YAML files, and its own database. Nothing is shared between orgs.
//
//   codeflow.yml               orgs: { acme: {} }
//   orgs/acme/org.yml          sources, since, github, branches, promotions, bots, paths
//   orgs/acme/people.yml       people and their logins
//   orgs/acme/groups.yml       teams and groups (products, areas…)
//   orgs/acme/rules.yml        the org's rules
//   .codeflow/acme/codeflow.db the org's data
//
// A single-file codeflow.yml, as before workspaces, still loads: as one org, its data where it
// always was.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { CodeflowError } from "../errors.ts";
import { DEFAULT_CONFIG_FILE, formatIssues } from "./load.ts";
import { type Config, ConfigSchema } from "./schema.ts";

/** Lowercase letters, digits, `-` and `_`: an org's name goes into file names and URLs. */
export const ORG_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** What each file of an org holds. Anything not listed here goes in org.yml. */
export const ORG_FILES = {
  org: "org.yml",
  people: "people.yml",
  groups: "groups.yml",
  rules: "rules.yml",
} as const;

export type OrgPart = keyof typeof ORG_FILES;

const PART_OF_KEY: Record<string, OrgPart> = {
  people: "people",
  teams: "groups",
  groups: "groups",
  products: "groups",
  rules: "rules",
};

/** The file of an org a top-level config key belongs in. */
export const partOfKey = (key: string): OrgPart => PART_OF_KEY[key] ?? "org";

export type Org = {
  name: string;
  /** The folder holding the org's files (for a single-file config, that file's folder). */
  dir: string;
  /** The file each part of the config is read from and written to. */
  files: Record<OrgPart, string>;
  config: Config;
  /** The org's SQLite database. No other org's data is ever in it. */
  dbPath: string;
};

export type Workspace = {
  /** The workspace file, or for a single-file config, the config itself. */
  path: string;
  /** True for a single-file config from before workspaces: one org, called `default`. */
  single: boolean;
  orgs: Org[];
};

/** The name a single-file config's org goes by. */
export const SINGLE_ORG = "default";

const WorkspaceSchema = z.strictObject({
  orgs: z
    .record(
      z.string(),
      z
        .strictObject({
          /** The org's folder, relative to the workspace file. Default: orgs/<name>. */
          dir: z.string().min(1).optional(),
        })
        .prefault({}),
    )
    .refine((orgs) => Object.keys(orgs).length > 0, { message: "list at least one org" })
    // Checked here rather than on the key: Zod reports a bad key only as "Invalid key in record".
    .superRefine((orgs, ctx) => {
      for (const name of Object.keys(orgs)) {
        if (!ORG_NAME.test(name)) {
          ctx.addIssue({
            code: "custom",
            path: [name],
            message: "org names use lowercase letters, digits, - and _, as they name folders",
          });
        }
      }
    }),
});

export async function loadWorkspace(path = DEFAULT_CONFIG_FILE): Promise<Workspace> {
  const text = await readText(
    path,
    `${path} not found. Create one with \`codeflow init --owner <org>\`, or point to it with --config.`,
  );
  const doc = parseDocument(text);
  const [yamlError] = doc.errors;
  if (yamlError) throw new CodeflowError(`${path}: ${yamlError.message}`);
  const raw = doc.toJS() as unknown;
  const root = dirname(resolve(path));

  if (!isRecord(raw) || !("orgs" in raw)) {
    const config = parse(raw, { [path]: Object.keys(isRecord(raw) ? raw : {}) }, path);
    return {
      path,
      single: true,
      orgs: [
        {
          name: SINGLE_ORG,
          dir: root,
          files: {
            org: resolve(path),
            people: resolve(path),
            groups: resolve(path),
            rules: resolve(path),
          },
          config,
          dbPath: resolve(root, config.data_dir ?? ".codeflow", "codeflow.db"),
        },
      ],
    };
  }

  const result = WorkspaceSchema.safeParse(raw);
  if (!result.success) {
    throw new CodeflowError(`${path} is not valid:\n${formatIssues(result.error.issues)}`);
  }
  const orgs: Org[] = [];
  for (const [name, entry] of Object.entries(result.data.orgs)) {
    orgs.push(await loadOrg(name, resolve(root, entry.dir ?? join("orgs", name)), root));
  }
  return { path, single: false, orgs };
}

/** Reads an org's folder: org.yml is required, the other files are optional. */
async function loadOrg(name: string, dir: string, root: string): Promise<Org> {
  const files = {
    org: join(dir, ORG_FILES.org),
    people: join(dir, ORG_FILES.people),
    groups: join(dir, ORG_FILES.groups),
    rules: join(dir, ORG_FILES.rules),
  } satisfies Record<OrgPart, string>;
  const merged: Record<string, unknown> = {};
  const origin: Record<string, string[]> = {};
  for (const [part, file] of Object.entries(files) as [OrgPart, string][]) {
    if (part !== "org" && !existsSync(file)) continue;
    const text = await readText(
      file,
      `Org "${name}" has no ${ORG_FILES.org} at ${file}. Create it with \`codeflow init --org ${name}\`.`,
    );
    const doc = parseDocument(text);
    const [yamlError] = doc.errors;
    if (yamlError) throw new CodeflowError(`${file}: ${yamlError.message}`);
    const content = (doc.toJS() as unknown) ?? {};
    if (!isRecord(content)) throw new CodeflowError(`${file} must hold keys and values.`);
    for (const [key, value] of Object.entries(content)) {
      const home = partOfKey(key);
      if (home !== part) {
        throw new CodeflowError(
          `${file}: \`${key}\` belongs in ${ORG_FILES[home]}, next to it, not in ${ORG_FILES[part]}.`,
        );
      }
      merged[key] = value;
      origin[file] = [...(origin[file] ?? []), key];
    }
  }
  const config = parse(merged, origin, `org "${name}"`);
  return {
    name,
    dir,
    files,
    config,
    dbPath: config.data_dir
      ? resolve(dir, config.data_dir, "codeflow.db")
      : resolve(root, ".codeflow", name, "codeflow.db"),
  };
}

/**
 * Validates a config, naming the file each problem is in: an org's keys come from several files.
 */
function parse(raw: unknown, origin: Record<string, string[]>, label: string): Config {
  const result = ConfigSchema.safeParse(raw);
  if (result.success) return result.data;
  const byFile = new Map<string, z.core.$ZodIssue[]>();
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? "");
    const file =
      Object.entries(origin).find(([, keys]) => keys.includes(key))?.[0] ??
      Object.keys(origin)[0] ??
      label;
    byFile.set(file, [...(byFile.get(file) ?? []), issue]);
  }
  const parts = [...byFile].map(
    ([file, issues]) => `${file} is not valid:\n${formatIssues(issues)}`,
  );
  throw new CodeflowError(parts.join("\n"));
}

/**
 * The orgs a command works on: the one `--org` names, or every org. Commands about one org at a
 * time pass `one`, and then a workspace of several orgs needs `--org`.
 */
export function pickOrgs(workspace: Workspace, name: string | undefined, one = false): Org[] {
  if (name !== undefined) {
    const org = workspace.orgs.find((o) => o.name === name);
    if (!org) {
      const known = workspace.orgs.map((o) => o.name).join(", ");
      throw new CodeflowError(`No org called "${name}" in ${workspace.path}. Orgs: ${known}.`);
    }
    return [org];
  }
  if (one && workspace.orgs.length > 1) {
    const known = workspace.orgs.map((o) => o.name).join(", ");
    throw new CodeflowError(`${workspace.path} has several orgs: say which with --org (${known}).`);
  }
  return workspace.orgs;
}

async function readText(path: string, missing: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new CodeflowError(missing);
    throw err;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
