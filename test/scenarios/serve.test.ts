import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVERYTHING } from "../../src/core/selection.ts";
import { ghPayload } from "../../src/testing/factories.ts";
import { acmeRepos, OWNER, scenarioStart } from "../../src/testing/scenario.ts";
import { buildReportPage, ROOT, serve, type Workspace, workspace } from "./support.ts";

const since = new Date(scenarioStart() - 14 * 86_400_000).toISOString().slice(0, 10);
const WRITE = { "content-type": "application/json", "x-codeflow": "1" };
const LIST = {
  selection: EVERYTHING,
  contributors: "all",
  set: "merged",
  filters: [],
  sort: { key: "merged", dir: "desc" },
  limit: 500,
};

let ws: Workspace;
let server: { url: string; stop: () => void };

beforeAll(async () => {
  // serve needs the report page; a fresh clone hasn't built it yet.
  if (!existsSync(join(ROOT, "dist/report/index.html"))) {
    await buildReportPage();
  }
  ws = await workspace(acmeRepos());
  await ws.addOrg("acme", "--repo", `${OWNER}/api`, "--since", since);
  await ws.addOrg("beta", "--repo", `${OWNER}/web`, "--since", since);
  await ws.write(
    "orgs/acme/groups.yml",
    "teams:\n  # the API crew\n  Platform:\n    people: [ana]\n",
  );
  expect((await ws.run("sync", "--org", "acme")).code).toBe(0);
  server = await serve(ws, "--no-schedule");
});
afterAll(async () => {
  server?.stop();
  await ws?.stop();
});

const api = (path: string, init?: RequestInit) => fetch(`${server.url}${path}`, init);
const json = async <T>(path: string, init?: RequestInit) =>
  (await (await api(path, init)).json()) as T;
type Rows = { rows: { repo: string; number: number }[] };

describe("codeflow serve", () => {
  it("TC-301 serves each org at its own address, and an unsynced org as such", async () => {
    expect(await json("/api/orgs")).toEqual({ orgs: ["acme", "beta"] });
    const home = await api("/", { redirect: "manual" });
    expect(home.headers.get("location")).toBe("/orgs/acme/");
    expect(await (await api("/orgs/beta/")).text()).toContain("<html");
    expect(await json("/api/orgs/beta/meta")).toEqual({ meta: null });
    const meta = await json<{ meta: { repos: string[] } }>("/api/orgs/acme/meta");
    expect(meta.meta.repos).toEqual([`${OWNER}/api`]);
  });

  it("TC-302 answers for one org with nothing of another's", async () => {
    const list = await json<Rows>("/api/orgs/acme/views/prs", {
      method: "POST",
      headers: WRITE,
      body: JSON.stringify(LIST),
    });
    expect(list.rows.length).toBeGreaterThan(50);
    expect(new Set(list.rows.map((r) => r.repo))).toEqual(new Set([`${OWNER}/api`]));
    // Asking beta for one of acme's PRs, by its id, gets nothing of it.
    const crossed = await api(`/api/orgs/beta/prs/${encodeURIComponent("PR_api_1")}`);
    const text = await crossed.text();
    expect(text).not.toContain("Improve api");
    expect(text).not.toContain(`${OWNER}/api`);
  });

  it("TC-303 an edit through the app writes the org's file, keeps its comments, and applies at once", async () => {
    const opened = await json<{ value: { teams: object }; version: string }>(
      "/api/orgs/acme/config/groups",
    );
    const saved = await api("/api/orgs/acme/config/groups", {
      method: "PUT",
      headers: WRITE,
      body: JSON.stringify({
        value: { ...opened.value, teams: { ...opened.value.teams, Web: { people: ["mika"] } } },
        version: opened.version,
      }),
    });
    expect(saved.status).toBe(200);
    const text = await ws.read("orgs/acme/groups.yml");
    expect(text).toContain("# the API crew");
    expect(text).toContain("Web:");
    const meta = await json<{ meta: { choices: { teams: { name: string }[] } } }>(
      "/api/orgs/acme/meta",
    );
    expect(meta.meta.choices.teams.map((t) => t.name)).toEqual(
      expect.arrayContaining(["Platform", "Web"]),
    );
  });

  it("TC-304 a save based on a file someone changed meanwhile is refused, not merged blindly", async () => {
    const opened = await json<{ value: object; version: string }>("/api/orgs/acme/config/rules");
    await ws.write("orgs/acme/rules.yml", "# edited by hand\nrules: []\n");
    const stale = await api("/api/orgs/acme/config/rules", {
      method: "PUT",
      headers: WRITE,
      body: JSON.stringify({ value: opened.value, version: opened.version }),
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toMatch(
      /changed since you opened it/,
    );
    expect(await ws.read("orgs/acme/rules.yml")).toContain("# edited by hand");
  });

  it("TC-305 a sync running beside it shows up without a restart", async () => {
    const opened = new Date(Date.now() - 2 * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
    const merged = new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
    ws.github.put(
      `${OWNER}/api`,
      ghPayload({
        id: "PR_api_999",
        number: 999,
        title: "Fresh off the press",
        url: `https://github.com/${OWNER}/api/pull/999`,
        createdAt: opened,
        updatedAt: merged,
        mergedAt: merged,
        closedAt: merged,
      }),
    );
    expect((await ws.run("sync", "--org", "acme")).code).toBe(0);
    const list = await json<Rows>("/api/orgs/acme/views/prs", {
      method: "POST",
      headers: WRITE,
      body: JSON.stringify(LIST),
    });
    expect(list.rows.map((r) => r.number)).toContain(999);
  });
});

describe("codeflow serve, on a schedule", () => {
  it("TC-306 syncs an org on its own, reports when it did, and shows the new data", async () => {
    const fresh = await workspace(acmeRepos());
    await fresh.addOrg("acme", "--repo", `${OWNER}/web`, "--since", since);
    const running = await serve(fresh);
    try {
      const status = async () =>
        (await (await fetch(`${running.url}/api/orgs/acme/status`)).json()) as {
          every: string;
          lastSync: string | null;
          nextSync: string | null;
        };
      // Never synced, so due at once; then daily.
      let now = await status();
      for (let i = 0; i < 100 && now.lastSync === null; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        now = await status();
      }
      expect(now.every).toBe("24h");
      expect(now.lastSync).not.toBeNull();
      expect(Date.parse(now.nextSync ?? "") - Date.parse(now.lastSync ?? "")).toBe(86_400_000);
      const meta = (await (await fetch(`${running.url}/api/orgs/acme/meta`)).json()) as {
        meta: { repos: string[] } | null;
      };
      expect(meta.meta?.repos).toEqual([`${OWNER}/web`]);
    } finally {
      running.stop();
      await fresh.stop();
    }
  });

  it("TC-307 the org's settings are edited through the app, and apply at once", async () => {
    const opened = (await (await fetch(`${server.url}/api/orgs/acme/config/settings`)).json()) as {
      value: { sync_every: string; stale_after_days: number; people_views: boolean };
      version: string;
    };
    expect(opened.value).toMatchObject({
      sync_every: "24h",
      stale_after_days: 90,
      people_views: true,
    });
    const flow = async () =>
      (await (
        await fetch(`${server.url}/api/orgs/acme/views/flow`, {
          method: "POST",
          headers: WRITE,
          body: JSON.stringify({
            selection: EVERYTHING,
            by: null,
            contributors: "all",
            window: "30d",
            percentile: 0.5,
          }),
        })
      ).json()) as { stale: { count: number; afterDays: number } };
    expect(await flow()).toMatchObject({ stale: { count: 1, afterDays: 90 } });
    const saved = await fetch(`${server.url}/api/orgs/acme/config/settings`, {
      method: "PUT",
      headers: WRITE,
      body: JSON.stringify({
        value: { stale_after_days: 365, people_views: false },
        version: opened.version,
      }),
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await ws.read("orgs/acme/org.yml")).toMatch(
      /stale_after_days: 365[\s\S]*people_views: false/,
    );
    expect(await flow()).toMatchObject({ stale: { count: 0, afterDays: 365 } });
    const meta = (await (await fetch(`${server.url}/api/orgs/acme/meta`)).json()) as {
      meta: { choices: { people: unknown[] }; settings: { peopleViews: boolean } };
    };
    expect(meta.meta.settings.peopleViews).toBe(false);
    expect(meta.meta.choices.people).toEqual([]);
  });
});
