// What the web app's setup asks of the workspace as a whole (decision D39): is GitHub connected,
// what would these sources measure, and adding, converting or removing an org. Each writes the
// same files `codeflow init` and `migrate` do, so the web app and the files never disagree.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, parseDocument } from "yaml";
import { type AdoSourceInput, defaultSince, init, orgNameFrom } from "../cli/init.ts";
import { migrate } from "../cli/migrate.ts";
import { adoWhoAmI, connectAdo, type GitHubCheck, openGitHub } from "../cli/session.ts";
import { formatIssues, parseConfig } from "../config/load.ts";
import { type AdoSource, type Config, isGitHub, SourcesDraftSchema } from "../config/schema.ts";
import { ORG_FILES } from "../config/workspace.ts";
import { CodeflowError } from "../errors.ts";
import { discoverAdo } from "../providers/ado/discover.ts";
import { discoverRepos, sourceName } from "../providers/github/discover.ts";
import { countPrsToSync, estimateBackfill, prPageCost } from "../providers/github/estimate.ts";

export const DEFAULT_GITHUB = { api_url: "https://api.github.com", token_env: "GITHUB_TOKEN" };
export const DEFAULT_ADO = { url: "https://dev.azure.com", token_env: "AZURE_DEVOPS_TOKEN" };

export type AdoCheck =
  | { ok: true; who: string; source: string; kind: string; organization: string }
  | { ok: false; error: string };

/**
 * Whether codeflow can read an Azure DevOps organization with the token it finds, and as whom;
 * never throws. Without an organization, only whether a token is there.
 */
export async function checkAdo(
  settings: Partial<typeof DEFAULT_ADO> & { organization?: string },
): Promise<AdoCheck> {
  const { organization, ...rest } = settings;
  const config = { azure_devops: { ...DEFAULT_ADO, ...clean(rest) } } as Config;
  try {
    const ado = await connectAdo(config, () => {}, { quiet: true });
    if (!organization?.trim()) {
      return {
        ok: true,
        who: "",
        source: ado.token.source,
        kind: ado.token.kind,
        organization: "",
      };
    }
    const who = await adoWhoAmI(ado.client(organization.trim()));
    return { ok: true, who, source: ado.token.source, kind: ado.token.kind, organization };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Whether codeflow can reach GitHub with a token, and as whom; never throws. */
export async function checkGitHub(
  github: Partial<typeof DEFAULT_GITHUB> = {},
): Promise<GitHubCheck> {
  try {
    return (await openGitHub({ ...DEFAULT_GITHUB, ...clean(github) })).check;
  } catch (err) {
    if (err instanceof CodeflowError) return { ok: false, error: err.message };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type SourcesPreview = {
  /** Null when no source is on GitHub. */
  github: GitHubCheck | null;
  sources: {
    name: string;
    ownerType: string | null;
    error: string | null;
    repos: {
      fullName: string;
      defaultBranch: string | null;
      archived: boolean;
      fork: boolean;
      /** Null for Azure DevOps, which can't count PRs without reading them. */
      prs: { open: number; merged: number; closed: number } | null;
      lastPrActivity: string | null;
    }[];
    skipped: { repo: string; reason: string }[];
  }[];
  /** What the first sync would fetch, and roughly how long it takes; null with no repos. */
  firstSync: { prs: number; olderOpen: number; seconds: number; shareOfHour: number } | null;
};

/** A typical page's latency: the preview skips timing one, to answer in a second or two. */
const SECONDS_PER_PAGE = 1.5;

/**
 * What a set of sources would measure: each source's repos, those it skips and why, and an
 * estimate of the first sync. Reads GitHub; writes nothing.
 */
export async function previewSources(input: unknown): Promise<SourcesPreview> {
  const parsed = SourcesDraftSchema.safeParse(input);
  if (!parsed.success) {
    throw new CodeflowError(
      `That isn't something to measure:\n${formatIssues(parsed.error.issues)}`,
    );
  }
  const { since, github } = parsed.data;
  const sources = parsed.data.sources.filter(isGitHub);
  const adoSources = parsed.data.sources.filter((s): s is AdoSource => s.kind === "ado");
  const adoResults: SourcesPreview["sources"] = [];
  if (adoSources.length > 0) {
    const ado = await connectAdo({ azure_devops: parsed.data.azure_devops } as Config, () => {}, {
      quiet: true,
    });
    for (const source of adoSources) {
      const result = await discoverAdo(ado.client(source.organization), source);
      adoResults.push({
        name: sourceName(source),
        ownerType: null,
        error: result.error ?? null,
        repos: result.repos.map((repo) => ({
          fullName: repo.fullName,
          defaultBranch: repo.defaultBranch,
          archived: repo.disabled,
          fork: repo.fork,
          prs: null,
          lastPrActivity: null,
        })),
        skipped: result.skipped,
      });
    }
  }
  if (sources.length === 0) return { github: null, sources: adoResults, firstSync: null };
  const { client, check } = await openGitHub(github);
  const results = await discoverRepos(client, sources);
  const repos = results.flatMap((result) => result.repos);
  let firstSync: SourcesPreview["firstSync"] = null;
  const busiest = repos.reduce<(typeof repos)[number] | null>(
    (a, b) => (a === null || total(b) > total(a) ? b : a),
    null,
  );
  if (busiest) {
    const counts = await countPrsToSync(client, repos, since);
    const estimate = estimateBackfill({
      ...counts,
      repos: repos.length,
      pageCost: await prPageCost(client, busiest),
      hourlyLimit: check.limit,
      secondsPerPage: SECONDS_PER_PAGE,
    });
    firstSync = {
      prs: counts.updated,
      olderOpen: counts.olderOpen,
      seconds: estimate.seconds ?? 0,
      shareOfHour: estimate.shareOfHour,
    };
  }
  return {
    github: check,
    sources: [
      ...results.map((result) => ({
        name: sourceName(result.source),
        ownerType: result.ownerType ?? null,
        error: result.error ?? null,
        repos: result.repos.map((repo) => ({
          fullName: repo.fullName,
          defaultBranch: repo.defaultBranch,
          archived: repo.archived,
          fork: repo.fork,
          prs: repo.prs,
          lastPrActivity: repo.lastPrActivity,
        })),
        skipped: result.skipped,
      })),
      ...adoResults,
    ],
    firstSync,
  };
}

const total = (repo: { prs: { open: number; merged: number; closed: number } }) =>
  repo.prs.open + repo.prs.merged + repo.prs.closed;

export type NewOrg = {
  /** Default: from the first owner. */
  name?: string;
  owners?: string[];
  repos?: string[];
  /** Azure DevOps organizations, each optionally narrowed to a project and repo names. */
  ado?: AdoSourceInput[];
  since?: string;
  /** Only for GitHub Enterprise, or a token in another variable. */
  github?: Partial<typeof DEFAULT_GITHUB>;
  /** Only for Azure DevOps Server, or a token in another variable. */
  azure_devops?: Partial<typeof DEFAULT_ADO>;
};

/**
 * Adds an org, as `codeflow init` does: the workspace file if there is none, and the org's folder
 * of files. Returns its name.
 */
export async function createOrg(workspacePath: string, input: NewOrg): Promise<string> {
  const owners = (input.owners ?? []).map((o) => o.trim()).filter(Boolean);
  const repos = (input.repos ?? []).map((r) => r.trim()).filter(Boolean);
  const ado = (input.ado ?? []).filter((source) => source.organization?.trim());
  const name =
    input.name?.trim() ||
    orgNameFrom(owners[0] ?? repos[0]?.split("/")[0] ?? ado[0]?.organization ?? "");
  await init({
    config: workspacePath,
    org: name,
    owner: owners,
    repo: repos,
    ado: ado.map((source) => ({
      organization: source.organization.trim(),
      ...(source.project?.trim() && { project: source.project.trim() }),
      ...(source.include?.length && { include: source.include }),
    })),
    since: input.since || defaultSince(),
  });
  const file = join(workspacePath, "..", "orgs", name, ORG_FILES.org);
  const doc = parseDocument(await readFile(file, "utf8"));
  let changed = false;
  for (const [key, given, defaults] of [
    ["github", input.github, DEFAULT_GITHUB],
    ["azure_devops", input.azure_devops, DEFAULT_ADO],
  ] as const) {
    const custom = Object.entries(clean(given ?? {})).filter(
      ([field, value]) => (defaults as Record<string, string>)[field] !== value,
    );
    if (custom.length > 0) {
      doc.set(key, Object.fromEntries(custom));
      changed = true;
    }
  }
  if (changed) {
    // Never write what loading would reject: the org's file is checked as a whole first.
    parseConfig(doc.toString(), ORG_FILES.org);
    await writeFile(file, doc.toString());
  }
  return name;
}

/** Turns a single-file config into a workspace whose one org is `name`, as `migrate` does. */
export async function convertWorkspace(workspacePath: string, name: string): Promise<void> {
  await migrate({ config: workspacePath, org: name });
}

/**
 * Takes an org off the workspace's list. Its folder of files and its data stay where they are,
 * so adding it back to codeflow.yml restores it: nothing is deleted.
 */
export async function removeOrg(workspacePath: string, name: string): Promise<void> {
  if (!existsSync(workspacePath)) throw new CodeflowError("There is no workspace yet.");
  const doc = parseDocument(await readFile(workspacePath, "utf8"));
  const orgs = isMap(doc.contents) ? doc.get("orgs") : undefined;
  if (!isMap(orgs) || !orgs.has(name)) throw new CodeflowError(`No org called "${name}".`);
  if (orgs.items.length === 1) {
    throw new CodeflowError(`${name} is the only org: add another before taking it off the list.`);
  }
  orgs.delete(name);
  await writeFile(workspacePath, doc.toString());
}

/** Drops empty values, so a form's blank field means "the default". */
function clean<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  ) as Partial<T>;
}
