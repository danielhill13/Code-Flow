import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isMap, parseDocument, stringify } from "yaml";
import { parseConfig } from "../config/load.ts";
import { ORG_FILES, ORG_NAME } from "../config/workspace.ts";
import { CodeflowError } from "../errors.ts";

export type InitOptions = {
  config: string;
  /** The new org's name. Default: the first owner's, or the first repo's owner. */
  org?: string;
  owner?: string[];
  repo?: string[];
  /** Azure DevOps sources: "organization" or "organization/project", or the source itself. */
  ado?: (string | AdoSourceInput)[];
  since?: string;
  force?: boolean;
};

const WORKSPACE_HEADER = [
  "# codeflow workspace: the orgs it measures. Each org lives in orgs/<name>/ (org.yml, groups.yml)",
  "# and keeps its data in .codeflow/<name>/. docs/configuration.md describes every option.",
].join("\n");

/**
 * Adds an org to the workspace, creating the workspace if there is none: the workspace file,
 * then orgs/<name>/org.yml with what to measure and a commented groups.yml to fill in.
 */
export async function init(options: InitOptions): Promise<void> {
  const owners = options.owner ?? [];
  const repos = options.repo ?? [];
  const ado = (options.ado ?? []).map((source) =>
    typeof source === "string" ? adoSourceOf(source) : source,
  );
  if (owners.length + repos.length + ado.length === 0) {
    throw new CodeflowError(
      "Say what to measure: --owner <org-or-user> or --repo <owner/name> on GitHub, or " +
        "--ado <organization[/project]> on Azure DevOps. Each can repeat.",
    );
  }
  const name =
    options.org ?? orgNameFrom(owners[0] ?? repos[0]?.split("/")[0] ?? ado[0]?.organization ?? "");
  if (!ORG_NAME.test(name)) {
    throw new CodeflowError(
      `"${name}" can't name an org: use lowercase letters, digits, - and _ (--org acme).`,
    );
  }
  const orgText = renderConfig({ owners, repos, ado, since: options.since ?? defaultSince() });
  parseConfig(orgText, ORG_FILES.org); // never write a config that loading would reject

  const workspace = resolve(options.config);
  const dir = join(dirname(workspace), "orgs", name);
  await addToWorkspace(workspace, name, options.force ?? false);
  await mkdir(dir, { recursive: true });
  const orgFile = join(dir, ORG_FILES.org);
  await write(orgFile, orgText, options.force ?? false);
  const peopleFile = join(dir, ORG_FILES.people);
  if (!existsSync(peopleFile)) await writeFile(peopleFile, PEOPLE_TEMPLATE);
  const groupsFile = join(dir, ORG_FILES.groups);
  if (!existsSync(groupsFile)) await writeFile(groupsFile, GROUPS_TEMPLATE);
  const rulesFile = join(dir, ORG_FILES.rules);
  if (!existsSync(rulesFile)) await writeFile(rulesFile, RULES_TEMPLATE);

  const shown = (path: string) => relative(process.cwd(), path) || path;
  console.log(`Wrote org "${name}" in ${shown(dir)}: org.yml, people.yml, groups.yml, rules.yml.`);
  console.log(`Next: codeflow doctor --org ${name}`);
}

/** Lists the org in the workspace file, keeping the file's comments and other orgs. */
async function addToWorkspace(path: string, name: string, force: boolean): Promise<void> {
  if (!existsSync(path)) {
    await writeFile(path, `${WORKSPACE_HEADER}\n\norgs:\n  ${name}: {}\n`);
    return;
  }
  const doc = parseDocument(await readFile(path, "utf8"));
  const orgs = isMap(doc.contents) ? doc.get("orgs") : undefined;
  if (!isMap(orgs)) {
    throw new CodeflowError(
      `${path} is a single-org config, from before workspaces. ` +
        "Run `codeflow migrate` to turn it into a workspace, then add orgs with init.",
    );
  }
  if (orgs.has(name) && !force) {
    throw new CodeflowError(
      `${path} already has an org called "${name}". Use --force to rewrite its org.yml.`,
    );
  }
  if (!orgs.has(name)) {
    const entry = doc.createNode({});
    entry.flow = true;
    orgs.set(name, entry);
    await writeFile(path, doc.toString());
  }
}

async function write(path: string, text: string, force: boolean): Promise<void> {
  try {
    await writeFile(path, text, { flag: force ? "w" : "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CodeflowError(`${path} already exists. Use --force to replace it.`);
    }
    throw err;
  }
}

/** "Acme Corp" → "acme-corp": an org name from a GitHub owner's. */
export function orgNameFrom(owner: string): string {
  return owner
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type AdoSourceInput = { organization: string; project?: string; include?: string[] };

/** "contoso/Platform" → an Azure DevOps source for project Platform of organization contoso. */
export function adoSourceOf(text: string): AdoSourceInput {
  const [organization = "", ...project] = text.trim().split("/");
  return project.length > 0 ? { organization, project: project.join("/") } : { organization };
}

export function renderConfig(input: {
  owners: string[];
  repos: string[];
  ado?: AdoSourceInput[];
  since: string;
}): string {
  return [
    "# What this org measures. docs/configuration.md describes every option.",
    "",
    "sources:",
    ...input.owners.map((owner) => `  - owner: ${scalar(owner)}`),
    ...input.repos.map((repo) => `  - repo: ${scalar(repo)}`),
    ...(input.ado ?? []).flatMap((source) => [
      `  - ado: ${scalar(source.organization)}           # Azure DevOps`,
      ...(source.project ? [`    project: ${scalar(source.project)}`] : []),
      ...(source.include?.length
        ? [`    include: [${source.include.map((p) => scalar(p)).join(", ")}]`]
        : []),
    ]),
    "",
    "# Measure pull requests active on or after this date.",
    `since: ${scalar(input.since)}`,
    "",
  ].join("\n");
}

export const PEOPLE_TEMPLATE = `# People, when one person has several GitHub logins, or config should say something about them.
# Anyone not listed is still measured, as their login. docs/configuration.md describes this.
#
# people:
#   ana:
#     name: Ana Ruiz
#     github: [ana-r, ana-old-login]   # every login they use; default: the key
#   deploy:
#     github: [deploy-svc]
#     bot: true                        # a service account: not counted, not a reviewer
#   jo:
#     internal: true                   # staff whose org membership GitHub hides
`;

export const GROUPS_TEMPLATE = `# Teams and groups, for looking at the report by team, product, area, repo or person.
# docs/configuration.md describes them. Remove the # marks to start.
#
# teams:                       # who works together; a PR counts for its author's team
#   Platform:
#     people: [mika, { login: devon, to: 2026-05-31 }]
#   Payments:
#     people: [ana, { login: devon, from: 2026-06-01 }]
#
# groups:                      # anything else: repos, teams and people; groups may overlap
#   Checkout:
#     kind: product
#     repos: ["your-org/cart-*"]
#     teams: [Payments]
#   Mobile:
#     kind: area
#     people: [mika]
`;

export const RULES_TEMPLATE = `# This org's rules: what counts, how its repos are read, how its people are treated.
# docs/configuration.md describes them; \`codeflow rules\` lists them, and
# \`codeflow rules test <file>\` shows what a draft would change. Remove the # marks to start.
#
# rules:
#   - id: no-chores
#     description: Housekeeping PRs aren't delivery.
#     scope: { teams: [Platform] }          # leave out for the whole org
#     when: { labels: [chore] }             # optional: which PRs
#     then: { count: false }
#
#   - id: legacy-branches
#     scope: { repos: ["your-org/legacy-*"] }
#     then: { measured_branches: [develop] }
#
#   - id: deploy-account
#     scope: { people: [deploy-svc] }
#     then: { bot: true }
`;

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
