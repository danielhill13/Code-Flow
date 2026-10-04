import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AdoServer } from "../testing/ado-server.ts";
import { GitHubServer } from "../testing/github-server.ts";
import { ADO_ORG, ADO_PROJECT, acmeRepos, contosoRepos, OWNER } from "../testing/scenario.ts";
import { Registry } from "./registry.ts";
import { createServer } from "./server.ts";

const TOKEN_ENV = "CODEFLOW_ADMIN_TEST_TOKEN";
let github: GitHubServer;
let apiUrl: string;
let root: string;
let server: Server;
let base: string;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  github = new GitHubServer(acmeRepos());
  apiUrl = await github.start();
  process.env[TOKEN_ENV] = github.token;
  root = await mkdtemp(join(tmpdir(), "codeflow-admin-"));
  server = createServer(new Registry(join(root, "codeflow.yml")), {
    template: "<html>page</html>",
    hosts: null,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  server.close();
  await github.stop();
  delete process.env[TOKEN_ENV];
});

const get = async <T>(path: string) => (await (await fetch(`${base}${path}`)).json()) as T;
const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-codeflow": "1" },
    body: JSON.stringify(body),
  });
const enterprise = { api_url: "", token_env: TOKEN_ENV };

describe("setting up from the web app", () => {
  it("starts from nothing: no workspace file, the first steps at /welcome/", async () => {
    const home = await fetch(`${base}/`, { redirect: "manual" });
    expect(home.headers.get("location")).toBe("/welcome/");
    expect(await (await fetch(`${base}/welcome/`)).text()).toContain("page");
    expect(await get("/api/workspace")).toMatchObject({ exists: false, single: false, orgs: [] });
  });

  it("checks the connection to GitHub, saying what to do when there is no token", async () => {
    const missing = await (
      await post("/api/github/check", { api_url: apiUrl, token_env: "NOPE_TOKEN" })
    ).json();
    // With no token anywhere (CI), it explains; on a laptop the GitHub CLI may have one.
    if (!(missing as { ok: boolean }).ok) {
      expect(missing).toMatchObject({ ok: false, error: expect.stringContaining("NOPE_TOKEN") });
    }
    const ok = await (await post("/api/github/check", { ...enterprise, api_url: apiUrl })).json();
    expect(ok).toMatchObject({ ok: true, login: "codeflow-tester", source: `$${TOKEN_ENV}` });
  });

  it("previews what sources measure, and refuses ones that make no sense", async () => {
    const preview = (await (
      await post("/api/github/preview", {
        sources: [{ owner: OWNER }],
        since: "2026-01-01",
        github: { ...enterprise, api_url: apiUrl },
      })
    ).json()) as {
      sources: { repos: { fullName: string }[]; skipped: { repo: string; reason: string }[] }[];
      firstSync: { prs: number };
    };
    expect(preview.sources[0]?.repos.map((r) => r.fullName).sort()).toEqual([
      `${OWNER}/api`,
      `${OWNER}/legacy`,
      `${OWNER}/web`,
    ]);
    expect(preview.sources[0]?.skipped).toEqual([{ repo: `${OWNER}/attic`, reason: "archived" }]);
    expect(preview.firstSync.prs).toBeGreaterThan(100);
    const bad = await post("/api/github/preview", {
      sources: [{ repo: "not a repo" }],
      since: "2026-01-01",
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("owner/name");
  });

  it("creates an org and its files, keeping the GitHub settings it was set up with", async () => {
    const made = await post("/api/workspace/orgs", {
      owners: [OWNER],
      since: "2026-01-01",
      github: { api_url: apiUrl, token_env: TOKEN_ENV },
    });
    expect(await made.json()).toEqual({ name: "acme-co" });
    for (const file of ["org.yml", "people.yml", "groups.yml", "rules.yml"]) {
      expect(existsSync(join(root, "orgs/acme-co", file)), file).toBe(true);
    }
    const org = await readFile(join(root, "orgs/acme-co/org.yml"), "utf8");
    expect(org).toContain(`api_url: ${apiUrl}`);
    expect(await get("/api/workspace")).toMatchObject({
      exists: true,
      orgs: [{ name: "acme-co", synced: false }],
    });
    const again = await post("/api/workspace/orgs", { name: "acme-co", owners: [OWNER] });
    expect(again.status).toBe(400);
  });

  it("edits everything org.yml holds, sending only what changed and keeping the rest", async () => {
    const opened = await get<{ value: Record<string, unknown>; version: string }>(
      "/api/orgs/acme-co/config/settings",
    );
    expect(opened.value).toMatchObject({
      sources: [{ owner: OWNER }],
      since: "2026-01-01",
      sync_every: "24h",
      promotions: expect.arrayContaining(["main", "release/*"]),
    });
    const saved = await fetch(`${base}/api/orgs/acme-co/config/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-codeflow": "1" },
      body: JSON.stringify({
        value: {
          sources: [{ owner: OWNER, exclude: ["legacy"] }],
          branches: { [`${OWNER}/web`]: ["main", "develop"] },
          bots: { accounts: ["deploy-svc"] },
          paths: [{ match: ["e2e/**"], bucket: "test" }],
        },
        version: opened.version,
      }),
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const text = await readFile(join(root, "orgs/acme-co/org.yml"), "utf8");
    expect(text).toContain("exclude:");
    expect(text).toContain("deploy-svc");
    expect(text).toContain("e2e/**");
    expect(text).toContain(`api_url: ${apiUrl}`); // untouched
    expect(text).not.toContain("promotions"); // never sent, so never written
  });

  it("takes an org off the list without deleting anything, but never the last one", async () => {
    await post("/api/workspace/orgs", {
      name: "beta",
      repos: [`${OWNER}/web`],
      github: { api_url: apiUrl, token_env: TOKEN_ENV },
    });
    const last = await post("/api/orgs/acme-co/remove", {});
    expect(last.status).toBe(200);
    expect(existsSync(join(root, "orgs/acme-co/org.yml"))).toBe(true);
    expect(await get("/api/workspace")).toMatchObject({ orgs: [{ name: "beta" }] });
    const only = await post("/api/orgs/beta/remove", {});
    expect(only.status).toBe(400);
  });

  it("turns a single-file config into a workspace, so orgs can be added", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codeflow-admin-single-"));
    const file = join(dir, "codeflow.yml");
    await writeFile(file, `sources:\n  - repo: ${OWNER}/api\nsince: 2026-01-01\n`);
    const single = createServer(new Registry(file), { template: "", hosts: null });
    await new Promise<void>((resolve) => single.listen(0, "127.0.0.1", resolve));
    const address = single.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    try {
      expect(await (await fetch(`${url}/api/workspace`)).json()).toMatchObject({ single: true });
      const converted = await fetch(`${url}/api/workspace/convert`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-codeflow": "1" },
        body: JSON.stringify({ name: "acme" }),
      });
      expect(converted.status).toBe(200);
      expect(await (await fetch(`${url}/api/workspace`)).json()).toMatchObject({
        single: false,
        orgs: [{ name: "acme" }],
      });
    } finally {
      single.close();
    }
  });
});

describe("setting up Azure DevOps from the web app", () => {
  const ADO_TOKEN_ENV = "CODEFLOW_ADMIN_TEST_ADO_TOKEN";
  const ado = new AdoServer(contosoRepos());
  let adoUrl: string;
  beforeAll(async () => {
    adoUrl = await ado.start();
    process.env[ADO_TOKEN_ENV] = ado.token;
  });
  afterAll(async () => {
    await ado.stop();
    delete process.env[ADO_TOKEN_ENV];
  });
  const settings = () => ({ url: adoUrl, token_env: ADO_TOKEN_ENV });

  it("checks the token against an organization", async () => {
    const ok = await (
      await post("/api/ado/check", { ...settings(), organization: ADO_ORG })
    ).json();
    expect(ok).toMatchObject({ ok: true, who: "Codeflow Tester", organization: ADO_ORG });
    // A missing token is covered by the scenarios, where the Azure CLI is out of reach: here,
    // on a laptop, it might hand over its real sign-in.
  });

  it("previews an Azure DevOps project beside a GitHub org, and creates the org with both", async () => {
    const preview = (await (
      await post("/api/github/preview", {
        sources: [{ owner: OWNER }, { ado: ADO_ORG, project: ADO_PROJECT }],
        since: "2026-01-01",
        github: { api_url: apiUrl, token_env: TOKEN_ENV },
        azure_devops: settings(),
      })
    ).json()) as {
      sources: {
        name: string;
        repos: { fullName: string; prs: unknown }[];
        skipped: { reason: string }[];
      }[];
    };
    const azure = preview.sources.find((s) => s.name.includes("Azure DevOps"));
    expect(azure?.repos.map((r) => r.fullName)).toEqual([
      `${ADO_ORG}/${ADO_PROJECT}/billing`,
      `${ADO_ORG}/${ADO_PROJECT}/portal`,
    ]);
    expect(azure?.repos[0]?.prs).toBeNull();
    expect(azure?.skipped.map((s) => s.reason)).toEqual(["disabled"]);

    const made = await post("/api/workspace/orgs", {
      name: "company",
      owners: [OWNER],
      ado: [{ organization: ADO_ORG, project: ADO_PROJECT }],
      since: "2026-01-01",
      github: { api_url: apiUrl, token_env: TOKEN_ENV },
      azure_devops: settings(),
    });
    expect(made.status, await made.clone().text()).toBe(200);
    const org = await readFile(join(root, "orgs/company/org.yml"), "utf8");
    expect(org).toMatch(/ado: contoso[\s\S]*project: Platform/);
    expect(org).toContain(`url: ${adoUrl}`);
    expect(org).toContain(`token_env: ${ADO_TOKEN_ENV}`);
  });
});
