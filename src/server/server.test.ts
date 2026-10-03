import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { init } from "../cli/init.ts";
import { loadWorkspace } from "../config/workspace.ts";
import { HttpSource } from "../core/http-source.ts";
import { EVERYTHING } from "../core/selection.ts";
import { EmbeddedSource } from "../core/source.ts";
import type { ViewQuery } from "../core/views/context.ts";
import { deriveFacts } from "../pipeline/derive.ts";
import { reportData } from "../pipeline/report.ts";
import { Store } from "../store/store.ts";
import { ghPayload } from "../testing/factories.ts";
import { Registry } from "./registry.ts";
import { createServer } from "./server.ts";

/** Stores merged PRs for a repo, as a finished sync would. */
function seed(dbPath: string, repo: string, prefix: string, count: number): void {
  const store = Store.open(dbPath);
  try {
    store.upsertRepo({
      id: `R_${repo}`,
      provider: "github",
      fullName: repo,
      defaultBranch: "main",
      archived: false,
      fork: false,
      private: false,
    });
    const run = store.startRun("sync");
    const prs = Array.from({ length: count }, (_, i) => {
      const day = String(1 + (i % 27)).padStart(2, "0");
      const payload = ghPayload({
        id: `${prefix}_${i}`,
        number: i + 1,
        title: `${prefix} change ${i}`,
        url: `https://github.com/${repo}/pull/${i + 1}`,
        createdAt: `2026-09-${day}T08:00:00Z`,
        mergedAt: `2026-09-${day}T18:00:00Z`,
        closedAt: `2026-09-${day}T18:00:00Z`,
        updatedAt: `2026-09-${day}T18:00:00Z`,
        labels: { nodes: i % 4 === 0 ? [{ name: "chore" }] : [] },
        author: { __typename: "User", login: i % 2 ? "ana" : "devon" },
      });
      return {
        id: payload.id,
        number: i + 1,
        state: "MERGED",
        updatedAt: payload.updatedAt,
        payload,
      };
    });
    store.savePage(`R_${repo}`, prs, run, { coveredSince: "2026-01-01" });
    store.finishRun(run, { status: "ok", calls: 1, points: 1, detail: {} });
  } finally {
    store.close();
  }
}

let root: string;
let config: string;
let server: Server;
let base: string;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  root = await mkdtemp(join(tmpdir(), "codeflow-serve-"));
  config = join(root, "codeflow.yml");
  await init({ config, org: "acme", repo: ["acme-co/api"], since: "2026-01-01" });
  await init({ config, org: "beta", repo: ["beta-inc/web"], since: "2026-01-01" });
  await writeFile(
    join(root, "orgs/acme/groups.yml"),
    "teams:\n  # who builds the API\n  Platform:\n    people: [ana]\n",
  );
  const [acme, beta] = (await loadWorkspace(config)).orgs;
  if (!acme || !beta) throw new Error("expected two orgs");
  seed(acme.dbPath, "acme-co/api", "Acme", 24);
  seed(beta.dbPath, "beta-inc/web", "Beta", 12);
  server = createServer(new Registry(config), { template: "<html>the page</html>", hosts: null });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => server.close());

const get = (path: string) => fetch(`${base}${path}`);
const send = (method: string, path: string, body: unknown, write = true) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(write && { "x-codeflow": "1" }) },
    body: JSON.stringify(body),
  });

const query: ViewQuery = {
  selection: EVERYTHING,
  by: null,
  contributors: "all",
  window: "90d",
  percentile: 0.5,
};

describe("serve", () => {
  it("lists the orgs, and serves the page at each org's own address", async () => {
    expect(await (await get("/api/orgs")).json()).toEqual({ orgs: ["acme", "beta"] });
    const home = await fetch(`${base}/`, { redirect: "manual" });
    expect(home.headers.get("location")).toBe("/orgs/acme/");
    expect(await (await get("/orgs/beta/")).text()).toBe("<html>the page</html>");
    expect((await get("/orgs/gamma/")).status).toBe(404);
  });

  it("answers exactly as the static report would, from the same builders", async () => {
    const [acme] = (await loadWorkspace(config)).orgs;
    if (!acme) throw new Error("no org");
    const store = Store.open(acme.dbPath);
    deriveFacts(store, acme.config);
    const embedded = new EmbeddedSource(reportData(store, acme.config, "acme"));
    store.close();
    const http = new HttpSource(`${base}/api/orgs/acme`);
    const same = async <T>(a: Promise<T>, b: Promise<T>) =>
      expect(await b).toEqual(JSON.parse(JSON.stringify(await a)));
    for (const window of ["30d", "90d", "ytd"] as const) {
      const q = { ...query, window };
      await same(embedded.overview(q), http.overview(q));
      await same(embedded.speed(q), http.speed(q));
      await same(embedded.review(q), http.review(q));
      await same(embedded.flow(q), http.flow(q));
    }
    const a = { start: "2026-08-01", end: "2026-09-01", label: "August 2026" };
    const b = { start: "2026-09-01", end: "2026-10-01", label: "September 2026" };
    await same(embedded.compare({ ...query, a, b }), http.compare({ ...query, a, b }));
    const list = {
      selection: EVERYTHING,
      contributors: "all" as const,
      set: "merged" as const,
      filters: [],
      sort: { key: "merged" as const, dir: "desc" as const },
      limit: 50,
    };
    await same(embedded.prs(list), http.prs(list));
    await same(embedded.pr("Acme_3"), http.pr("Acme_3"));
  });

  it("never answers for one org with another's data", async () => {
    const texts = await Promise.all(
      [
        get("/api/orgs/acme/meta"),
        send("POST", "/api/orgs/acme/views/overview", query),
        send("POST", "/api/orgs/acme/views/prs", {
          selection: EVERYTHING,
          contributors: "all",
          set: "merged",
          filters: [],
          sort: { key: "merged", dir: "desc" },
          limit: 500,
        }),
        get("/api/orgs/acme/config/groups"),
        get("/api/orgs/acme/export?only=people,groups,rules,settings"),
      ].map(async (r) => (await r).text()),
    );
    for (const text of texts) {
      for (const other of ["beta", "Beta change"]) expect(text).not.toContain(other);
    }
    expect(texts[2]).toContain("Acme change 3");
    expect(await (await get("/api/orgs/beta/prs/Acme_3")).json()).toBeNull();
  });

  it("edits a part of the config, keeping comments, and refuses stale or invalid edits", async () => {
    const opened = (await (await get("/api/orgs/acme/config/groups")).json()) as {
      value: { teams: Record<string, unknown> };
      version: string;
    };
    const teams = { ...opened.value.teams, Web: { people: ["devon"] } };
    const saved = await send("PUT", "/api/orgs/acme/config/groups", {
      value: { ...opened.value, teams },
      version: opened.version,
    });
    expect(await saved.json()).toMatchObject({ changes: ["teams: added Web"] });
    const text = await readFile(join(root, "orgs/acme/groups.yml"), "utf8");
    expect(text).toContain("# who builds the API");
    const meta = (await (await get("/api/orgs/acme/meta")).json()) as {
      meta: { choices: { teams: { name: string }[] } };
    };
    expect(meta.meta.choices.teams.map((t) => t.name)).toContain("Web");

    const stale = await send("PUT", "/api/orgs/acme/config/groups", {
      value: opened.value,
      version: opened.version,
    });
    expect(stale.status).toBe(409);
    const now = (await (await get("/api/orgs/acme/config/groups")).json()) as {
      version: string;
      value: object;
    };
    const invalid = await send("PUT", "/api/orgs/acme/config/groups", {
      value: { ...now.value, teams: { A: { people: ["ana"] }, B: { people: ["ana"] } } },
      version: now.version,
    });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: string }).error).toMatch(/ana is in A and B/);
  });

  it("previews rules, and imports with a dry run first", async () => {
    const preview = await send("POST", "/api/orgs/acme/rules/preview", {
      rules: [{ id: "no-chores", when: { labels: ["chore"] }, then: { count: false } }],
    });
    expect(await preview.json()).toMatchObject({ synced: true, leftOut: { count: 6 } });

    const bundle =
      "codeflow: 1\nrules:\n  - id: no-chores\n    when: { labels: [chore] }\n    then: { count: false }\n";
    const dry = await send("POST", "/api/orgs/acme/import?dryRun=1", { text: bundle });
    expect(await dry.json()).toEqual({ changes: ["rules: added no-chores"], applied: false });
    const wet = await send("POST", "/api/orgs/acme/import", { text: bundle });
    expect(await wet.json()).toEqual({ changes: ["rules: added no-chores"], applied: true });
    const overview = (await (
      await send("POST", "/api/orgs/acme/views/overview", query)
    ).json()) as {
      tiles: { key: string; value: { value: number } }[];
    };
    expect(overview.tiles.find((t) => t.key === "merged")?.value.value).toBe(18);

    const exported = await get("/api/orgs/acme/export?only=rules&format=json");
    expect(exported.headers.get("content-disposition")).toContain('filename="acme.json"');
    expect(await exported.json()).toMatchObject({ codeflow: 1, rules: [{ id: "no-chores" }] });
  });

  it("refuses writes without its header, and requests addressed to another host", async () => {
    expect((await send("PUT", "/api/orgs/acme/config/rules", {}, false)).status).toBe(403);
    const guarded = createServer(new Registry(config), { template: "", hosts: ["localhost:1"] });
    await new Promise<void>((resolve) => guarded.listen(0, "127.0.0.1", resolve));
    const address = guarded.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const status = await new Promise<number>((resolve) => {
      httpRequest(
        { host: "127.0.0.1", port, path: "/api/orgs", headers: { host: "evil.example" } },
        (res) => resolve(res.statusCode ?? 0),
      ).end();
    });
    guarded.close();
    expect(status).toBe(403);
  });
});
