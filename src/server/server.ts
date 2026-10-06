// `codeflow serve`: the report as a web app on this machine, with every org's config editable
// (decision D33). Node's own http module, no framework. Every API path names its org, and each
// org is loaded on its own, so no response can hold another org's data.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { brotliCompressSync, gzipSync, constants as zlibConstants } from "node:zlib";
import { defaultSince } from "../cli/init.ts";
import {
  applyImport,
  type Bundle,
  describeChanges,
  exportBundle,
  formatOf,
  type Part,
  parseParts,
  planImport,
  readBundle,
  readRaw,
  renderBundle,
} from "../config/bundle.ts";
import { formatIssues } from "../config/load.ts";
import { asRule, BUNDLE_VERSION, RulesFileSchema } from "../config/schema.ts";
import type { Org, OrgPart } from "../config/workspace.ts";
import { unmeasuredBranches } from "../core/branches.ts";
import { botsOf, identitiesOf, type PersonRaw, suggestMerges } from "../core/identities.ts";
import { ruleImpact } from "../core/preview.ts";
import { ruleProblems } from "../core/rules.ts";
import { CodeflowError } from "../errors.ts";
import { copyOf, copyStatuses, removeUnwantedCopies } from "../pipeline/copies.ts";
import { deriveFacts, deriveWith, measuredBranches } from "../pipeline/derive.ts";
import { forgetRepos, pruneRepos, unmeasuredRepos } from "../pipeline/prune.ts";
import { gitVersion, removeCopy } from "../providers/git/git.ts";
import { Store } from "../store/store.ts";
import {
  checkAdo,
  checkGitHub,
  convertWorkspace,
  createOrg,
  type NewOrg,
  previewSources,
  removeOrg,
} from "./admin.ts";
import { NotFound, partVersion, type Registry } from "./registry.ts";
import type { Scheduler, SyncStatus } from "./scheduler.ts";

/** The parts of an org's config the app edits, and the keys each holds. */
export const EDITABLE = {
  people: ["people"],
  groups: ["teams", "groups", "products"],
  rules: ["rules"],
  /** Everything in org.yml but where its data lives: what to measure and how. */
  settings: [
    "sources",
    "since",
    "github",
    "branches",
    "promotions",
    "bots",
    "paths",
    "sync_every",
    "stale_after_days",
    "people_views",
    "churn_window_days",
    "size_target_lines",
    "local_copies",
    "ticket_pattern",
    "duplicates_by_work_item",
  ],
} as const satisfies Record<string, readonly string[]>;

/** The file each editable part lives in. */
const FILE_OF: Record<keyof typeof EDITABLE, OrgPart> = {
  people: "people",
  groups: "groups",
  rules: "rules",
  settings: "org",
};

/** Requests that change anything carry this header, which a page on another site can't send. */
export const WRITE_HEADER = "x-codeflow";

export type ServeOptions = {
  /** The report page, built without data. */
  template: string;
  /**
   * Only requests addressed to these host names, on the port the server listens on, are
   * answered (DNS rebinding); null for any.
   */
  hosts: readonly string[] | null;
  /** Keeps the orgs' data fresh; absent when serve runs without a schedule. */
  scheduler?: Scheduler;
};

class Conflict extends Error {}
class Forbidden extends Error {}

export function createServer(registry: Registry, options: ServeOptions): Server {
  return createHttpServer((req, res) => {
    handle(registry, options, req, res).catch((err: unknown) => fail(res, err));
  });
}

async function handle(
  registry: Registry,
  options: ServeOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const host = (req.headers.host ?? "").toLowerCase();
  if (options.hosts) {
    const allowed = options.hosts.map((name) => `${name}:${req.socket.localPort}`);
    if (!allowed.includes(host)) {
      throw new Forbidden(`This server answers only on ${allowed.join(", ")}.`);
    }
  }
  if (req.method !== "GET" && req.headers[WRITE_HEADER] !== "1") {
    throw new Forbidden(`Requests that change anything need the ${WRITE_HEADER} header.`);
  }
  const path = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  // The page: one per org, at /orgs/<name>/, so a link or a bookmark names its org; and the
  // first steps at /welcome/, where a new workspace starts and more orgs are added.
  if (path.length === 0) {
    const [first] = await registry.names();
    return redirect(res, first ? `/orgs/${encodeURIComponent(first)}/` : "/welcome/");
  }
  if ((path[0] === "orgs" && path.length === 2) || (path[0] === "welcome" && path.length === 1)) {
    if (path[0] === "orgs") await registry.org(path[1] ?? "");
    if (!url.pathname.endsWith("/")) return redirect(res, `${url.pathname}/`);
    return send(res, 200, options.template, "text/html; charset=utf-8");
  }
  if (path[0] !== "api") throw new NotFound("Not found.");
  if (path[1] === "workspace" || path[1] === "github" || path[1] === "ado") {
    return workspaceRoute(registry, `${req.method} ${path.slice(1).join("/")}`, req, res);
  }
  if (path[1] !== "orgs") throw new NotFound("Not found.");
  if (path.length === 2) return json(res, { orgs: await registry.names() });

  const name = path[2] ?? "";
  const route = path.slice(3);
  const loaded = await registry.org(name);
  const { org } = loaded;
  const source = () => {
    if (!loaded.source) {
      throw new NotFound(`Nothing synced yet for ${name}. Run: codeflow sync --org ${name}`);
    }
    return loaded.source;
  };

  switch (`${req.method} ${route[0] ?? ""}`) {
    case "GET meta":
      return json(res, { meta: loaded.source ? await loaded.source.meta() : null });
    case "POST sync": {
      if (!options.scheduler) throw new NotFound("This server doesn't sync.");
      await options.scheduler.syncNow(name);
      return json(res, await options.scheduler.status(name));
    }
    case "POST remove":
      await removeOrg(registry.path, name);
      registry.forget(name);
      return json(res, { removed: name });
    case "GET repos":
      return json(res, reposOf(org));
    case "GET unmeasured":
      return json(res, { repos: withStore(org, (store) => unmeasuredRepos(store, org.config)) });
    case "POST refetch": {
      if (!options.scheduler) throw new NotFound("This server doesn't sync.");
      const { repos } = (await body(req)) as { repos?: unknown };
      if (
        !Array.isArray(repos) ||
        repos.length === 0 ||
        !repos.every((r) => typeof r === "string")
      ) {
        throw new CodeflowError("Name the repos to fetch again.");
      }
      const cleared = withStore(org, (store) => forgetRepos(store, repos as string[]));
      await options.scheduler.syncNow(name);
      return json(res, { cleared });
    }
    case "POST prune": {
      const removed = withStore(org, (store) => pruneRepos(store, org.config));
      for (const repo of removed) await removeCopy(copyOf(org, repo.id));
      return json(res, { removed });
    }
    case "GET copies": {
      if (!existsSync(org.dbPath)) return json(res, { git: await gitVersion(), copies: [] });
      const store = Store.open(org.dbPath);
      try {
        return json(res, { git: await gitVersion(), copies: await copyStatuses(org, store) });
      } finally {
        store.close();
      }
    }
    case "POST copies-clean": {
      if (!existsSync(org.dbPath)) return json(res, { removed: [] });
      const store = Store.open(org.dbPath);
      try {
        return json(res, { removed: await removeUnwantedCopies(org, store) });
      } finally {
        store.close();
      }
    }
    case "GET identities":
      return json(res, await identitiesFor(org));
    case "GET status": {
      const meta = loaded.source ? await loaded.source.meta() : null;
      const status: SyncStatus = options.scheduler
        ? await options.scheduler.status(name)
        : {
            every: "off",
            lastSync: meta?.asOf ?? null,
            nextSync: null,
            running: false,
            queued: false,
            lastError: null,
            log: [],
            progress: null,
          };
      return json(res, status);
    }
    case "POST views": {
      const query = (await body(req)) as never;
      const s = source();
      const views = {
        overview: () => s.overview(query),
        speed: () => s.speed(query),
        review: () => s.review(query),
        flow: () => s.flow(query),
        compare: () => s.compare(query),
        prs: () => s.prs(query),
      } as const;
      const view = views[route[1] as keyof typeof views];
      if (!view) throw new NotFound(`No view called "${route[1]}".`);
      return json(res, await view());
    }
    case "GET prs":
      return json(res, await source().pr(route[1] ?? ""));
    case "GET config": {
      const part = editable(route[1]);
      const raw = await readRaw(org);
      // Settings show their effective values, defaults included; the rest, what the file holds.
      const config = org.config as unknown as Record<string, unknown>;
      const value = Object.fromEntries(
        EDITABLE[part].map((key) => [
          key,
          part === "settings" ? (raw[key] ?? config[key]) : (raw[key] ?? emptyOf(key)),
        ]),
      );
      return json(res, { value, version: partVersion(org, FILE_OF[part]) });
    }
    case "PUT config": {
      const part = editable(route[1]);
      const { value, version } = (await body(req)) as {
        value: Record<string, unknown>;
        version: string;
      };
      const file = FILE_OF[part];
      if (version !== partVersion(org, file)) {
        throw new Conflict(
          `${org.files[file]} changed since you opened it. Reload to see the change, then edit again.`,
        );
      }
      // Settings replace the org.yml keys the request names, and leave the rest; the other parts
      // replace what their file holds.
      const bundle = (
        part === "settings"
          ? { codeflow: BUNDLE_VERSION, settings: pickSet(value, EDITABLE.settings) }
          : { codeflow: BUNDLE_VERSION, ...pick(value, EDITABLE[part]) }
      ) as Bundle;
      const plan = await planImport(org, bundle, [part as Part], "replace");
      if (plan.changes.length > 0) await applyImport(org, plan);
      registry.forget(name);
      return json(res, { version: partVersion(org, file), changes: describeChanges(plan.changes) });
    }
    case "POST rules":
      if (route[1] !== "preview") throw new NotFound("Not found.");
      return json(res, preview(org, await body(req)));
    case "GET export": {
      const parts = parseParts(url.searchParams.get("only") ?? undefined);
      const format = formatOf("", url.searchParams.get("format") ?? "yaml");
      const text = renderBundle(await exportBundle(org, parts), format);
      res.setHeader(
        "content-disposition",
        `attachment; filename="${name}.${format === "yaml" ? "yml" : format}"`,
      );
      return send(
        res,
        200,
        text,
        format === "json" ? "application/json" : "text/plain; charset=utf-8",
      );
    }
    case "POST import": {
      const mode = url.searchParams.get("mode") === "replace" ? "replace" : "merge";
      const format = formatOf("", url.searchParams.get("format") ?? "yaml");
      const { text } = (await body(req)) as { text: string };
      const bundle = readBundle(text, format, "the file");
      const parts = parseParts(
        url.searchParams.get("only") ?? (format === "csv" ? "people,groups" : undefined),
      );
      const plan = await planImport(org, bundle, parts, mode);
      const apply = url.searchParams.get("dryRun") !== "1";
      if (apply && plan.changes.length > 0) {
        await applyImport(org, plan);
        registry.forget(name);
      }
      return json(res, { changes: describeChanges(plan.changes), applied: apply });
    }
    default:
      throw new NotFound("Not found.");
  }
}

/** What a draft list of rules would change, against the org's rules now. */
function preview(org: Awaited<ReturnType<Registry["org"]>>["org"], input: unknown) {
  const parsed = RulesFileSchema.safeParse(input);
  if (!parsed.success)
    throw new CodeflowError(`The rules aren't valid:\n${formatIssues(parsed.error.issues)}`);
  const { config } = org;
  const problems = ruleProblems(
    parsed.data.rules.map((rule) => asRule(rule, "draft")),
    {
      teams: Object.keys(config.teams),
      groups: [...Object.keys(config.groups), ...Object.keys(config.products)],
    },
  );
  if (problems.length > 0) throw new CodeflowError(problems.join("\n"));
  if (!existsSync(org.dbPath)) return { synced: false };
  const store = Store.open(org.dbPath);
  try {
    deriveFacts(store, config);
    const impact = ruleImpact(
      store.facts(),
      deriveWith(store, { ...config, rules: parsed.data.rules }),
    );
    const first = (changes: typeof impact.leftOut) => ({
      count: changes.length,
      examples: changes
        .slice(0, 5)
        .map(({ id, repo, number, title }) => ({ id, repo, number, title })),
    });
    return {
      synced: true,
      leftOut: first(impact.leftOut),
      broughtIn: first(impact.broughtIn),
      internal: first(impact.internal),
      external: first(impact.external),
      applied: impact.applied,
    };
  } finally {
    store.close();
  }
}

/** The routes that aren't about one org: the workspace, and GitHub before an org exists. */
async function workspaceRoute(
  registry: Registry,
  route: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  switch (route) {
    case "GET workspace": {
      const workspace = await registry.workspace();
      return json(res, {
        exists: existsSync(registry.path),
        single: workspace.single,
        orgs: workspace.orgs.map((org) => ({ name: org.name, synced: existsSync(org.dbPath) })),
        since: defaultSince(),
      });
    }
    case "POST workspace/orgs": {
      const name = await createOrg(registry.path, (await body(req)) as NewOrg);
      return json(res, { name });
    }
    case "POST workspace/convert": {
      const { name } = (await body(req)) as { name?: string };
      if (!name) throw new CodeflowError("Name the org the config becomes.");
      await convertWorkspace(registry.path, name);
      return json(res, { name });
    }
    case "POST github/check":
      return json(res, await checkGitHub((await body(req)) as Record<string, string>));
    case "POST ado/check":
      return json(res, await checkAdo((await body(req)) as Record<string, string>));
    case "POST github/preview":
      return json(res, await previewSources(await body(req)));
    default:
      throw new NotFound("Not found.");
  }
}

/** Runs `fn` on the org's store, or gives nothing when the org has no data yet. */
function withStore<T>(org: Org, fn: (store: Store) => T[]): T[] {
  if (!existsSync(org.dbPath)) return [];
  const store = Store.open(org.dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/** Every account the org's PRs show, and which look like one person on both hosts (D42). */
async function identitiesFor(org: Org) {
  const people = ((await readRaw(org)).people ?? {}) as Record<string, PersonRaw>;
  if (!existsSync(org.dbPath)) return { identities: [], suggestions: [], bots: [] };
  const store = Store.open(org.dbPath);
  try {
    deriveFacts(store, org.config);
    const hosts = new Map(store.repos().map((repo) => [repo.id, repo.provider]));
    const facts = store.facts();
    const identities = identitiesOf(
      facts,
      (repoId) => (hosts.get(repoId) === "ado" ? "ado" : "github"),
      people,
    );
    return { identities, suggestions: suggestMerges(identities), bots: botsOf(facts) };
  } finally {
    store.close();
  }
}

/**
 * The org's synced repos: each one's default branch, the branches measured, and advice; and every
 * branch PRs went into, with how many, for Setup to offer.
 */
function reposOf(org: Org) {
  if (!existsSync(org.dbPath)) return { repos: [], advice: [], branches: [] };
  const store = Store.open(org.dbPath);
  try {
    const facts = store.facts();
    const advice = unmeasuredBranches(facts, new Date(store.dataThrough() ?? Date.now()));
    const into = new Map<string, number>();
    for (const pr of facts) into.set(pr.baseBranch, (into.get(pr.baseBranch) ?? 0) + 1);
    return {
      branches: [...into]
        .map(([name, prs]) => ({ name, prs }))
        .sort((a, b) => b.prs - a.prs || a.name.localeCompare(b.name)),
      repos: store.repos().map((repo) => ({
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch,
        measured: measuredBranches(org.config, repo),
      })),
      advice,
    };
  } finally {
    store.close();
  }
}

function editable(part: string | undefined): keyof typeof EDITABLE {
  if (part && part in EDITABLE) return part as keyof typeof EDITABLE;
  throw new NotFound(
    `No config part called "${part}". Parts: ${Object.keys(EDITABLE).join(", ")}.`,
  );
}

/** The keys of `value` that are set, leaving the rest as the file has them. */
function pickSet(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.filter((key) => value[key] !== undefined).map((k) => [k, value[k]]),
  );
}

const emptyOf = (key: string) => (key === "rules" ? [] : {});

function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, value[key] ?? emptyOf(key)]));
}

const LIMIT = 5 * 1024 * 1024;

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > LIMIT) throw new CodeflowError("That request is larger than 5 MB.");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new CodeflowError("The request body isn't JSON.");
  }
}

function json(res: ServerResponse, value: unknown): void {
  send(res, 200, JSON.stringify(value), "application/json");
}

/**
 * Sends text, compressed when the browser accepts it: the page and every answer stay small on
 * the wire (decision D38). The page itself is revalidated by its ETag rather than sent again;
 * answers about data are never cached, since a sync can change them at any time.
 */
function send(res: ServerResponse, status: number, text: string, type: string): void {
  const page = type.startsWith("text/html");
  res.statusCode = status;
  res.setHeader("content-type", type);
  res.setHeader("cache-control", page ? "no-cache" : "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("vary", "accept-encoding");
  const accepts = String(res.req?.headers["accept-encoding"] ?? "");
  if (page) {
    const etag = `"${createHash("sha256").update(text).digest("base64url").slice(0, 22)}"`;
    res.setHeader("etag", etag);
    if (res.req?.headers["if-none-match"] === etag) {
      res.statusCode = 304;
      res.end();
      return;
    }
  }
  if (text.length < COMPRESS_FROM) {
    res.end(text);
    return;
  }
  const encoding = /\bbr\b/.test(accepts) ? "br" : /\bgzip\b/.test(accepts) ? "gzip" : null;
  if (!encoding) {
    res.end(text);
    return;
  }
  res.setHeader("content-encoding", encoding);
  res.end(compressed(text, encoding, page));
}

/** Smaller than this, compressing costs more than it saves. */
const COMPRESS_FROM = 1024;

/** The page is the same for every request: compress it once, as hard as it goes. */
const pageCache = new Map<string, Buffer>();

function compressed(text: string, encoding: "br" | "gzip", page: boolean): Buffer {
  const key = `${encoding}:${text.length}:${text.slice(0, 64)}`;
  const cached = page ? pageCache.get(key) : undefined;
  if (cached) return cached;
  const result =
    encoding === "br"
      ? brotliCompressSync(text, {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: page ? 11 : 4 },
        })
      : gzipSync(text, { level: page ? 9 : 6 });
  if (page) pageCache.set(key, result);
  return result;
}

function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 302;
  res.setHeader("location", location);
  res.end();
}

function fail(res: ServerResponse, err: unknown): void {
  const status =
    err instanceof NotFound
      ? 404
      : err instanceof Forbidden
        ? 403
        : err instanceof Conflict
          ? 409
          : err instanceof CodeflowError
            ? 400
            : 500;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 500) console.error(err);
  if (!res.headersSent) send(res, status, JSON.stringify({ error: message }), "application/json");
  else res.end();
}
