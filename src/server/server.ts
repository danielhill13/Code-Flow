// `codeflow serve`: the report as a web app on this machine, with every org's config editable
// (decision D33). Node's own http module, no framework. Every API path names its org, and each
// org is loaded on its own, so no response can hold another org's data.

import { existsSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
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
import type { OrgPart } from "../config/workspace.ts";
import { ruleImpact } from "../core/preview.ts";
import { ruleProblems } from "../core/rules.ts";
import { CodeflowError } from "../errors.ts";
import { deriveFacts, deriveWith } from "../pipeline/derive.ts";
import { Store } from "../store/store.ts";
import { NotFound, partVersion, type Registry } from "./registry.ts";

/** The parts of an org's config the app edits, and the keys each holds. */
export const EDITABLE: Record<Exclude<OrgPart, "org">, readonly string[]> = {
  people: ["people"],
  groups: ["teams", "groups", "products"],
  rules: ["rules"],
};

/** Requests that change anything carry this header, which a page on another site can't send. */
export const WRITE_HEADER = "x-codeflow";

export type ServeOptions = {
  /** The report page, built without data. */
  template: string;
  /** Only requests addressed to these hosts are answered (DNS rebinding); null for any. */
  hosts: readonly string[] | null;
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
  if (options.hosts && !options.hosts.includes(host)) {
    throw new Forbidden(`This server answers only on ${options.hosts.join(", ")}.`);
  }
  if (req.method !== "GET" && req.headers[WRITE_HEADER] !== "1") {
    throw new Forbidden(`Requests that change anything need the ${WRITE_HEADER} header.`);
  }
  const path = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  // The page: one per org, at /orgs/<name>/, so a link or a bookmark names its org.
  if (path.length === 0) {
    const [first] = await registry.names();
    return redirect(res, first ? `/orgs/${encodeURIComponent(first)}/` : "/");
  }
  if (path[0] === "orgs" && path.length === 2) {
    await registry.org(path[1] ?? "");
    if (!url.pathname.endsWith("/")) return redirect(res, `${url.pathname}/`);
    return send(res, 200, options.template, "text/html; charset=utf-8");
  }
  if (path[0] !== "api" || path[1] !== "orgs") throw new NotFound("Not found.");
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
      const value = Object.fromEntries(
        EDITABLE[part].map((key) => [key, raw[key] ?? emptyOf(key)]),
      );
      return json(res, { value, version: partVersion(org, part) });
    }
    case "PUT config": {
      const part = editable(route[1]);
      const { value, version } = (await body(req)) as {
        value: Record<string, unknown>;
        version: string;
      };
      if (version !== partVersion(org, part)) {
        throw new Conflict(
          `${org.files[part]} changed since you opened it. Reload to see the change, then edit again.`,
        );
      }
      const bundle = { codeflow: BUNDLE_VERSION, ...pick(value, EDITABLE[part]) } as Bundle;
      const plan = await planImport(org, bundle, [part as Part], "replace");
      if (plan.changes.length > 0) await applyImport(org, plan);
      registry.forget(name);
      return json(res, { version: partVersion(org, part), changes: describeChanges(plan.changes) });
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

function editable(part: string | undefined): keyof typeof EDITABLE {
  if (part === "people" || part === "groups" || part === "rules") return part;
  throw new NotFound(`No config part called "${part}". Parts: people, groups, rules.`);
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

function send(res: ServerResponse, status: number, text: string, type: string): void {
  res.statusCode = status;
  res.setHeader("content-type", type);
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(text);
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
