// Several orgs in one workspace, moving config between them, upgrading an old single-file config,
// and what each command says when something is wrong. The real CLI, against a fake GitHub.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acmeRepos, OWNER, scenarioStart } from "../../src/testing/scenario.ts";
import { TOKEN_ENV, type Workspace, workspace } from "./support.ts";

const since = new Date(scenarioStart() - 14 * 86_400_000).toISOString().slice(0, 10);
/** No stack trace, no "at file:line": a user-fixable failure prints its message only. */
const NO_STACK = /\n\s+at\s|Error:\s.*\n\s+at /;

describe("a workspace of two orgs", () => {
  let ws: Workspace;
  beforeAll(async () => {
    // Two "companies" on one fake GitHub: acme measures api and legacy, beta measures web.
    ws = await workspace(acmeRepos());
    await ws.addOrg(
      "acme",
      "--repo",
      `${OWNER}/api`,
      "--repo",
      `${OWNER}/legacy`,
      "--since",
      since,
    );
    await ws.addOrg("beta", "--repo", `${OWNER}/web`, "--since", since);
  });
  afterAll(() => ws.stop());

  it("TC-201 sync and build cover every org, each into its own database and report", async () => {
    const sync = await ws.run("sync");
    expect(sync.code, sync.out).toBe(0);
    expect(existsSync(join(ws.dir, ".codeflow/acme/codeflow.db"))).toBe(true);
    expect(existsSync(join(ws.dir, ".codeflow/beta/codeflow.db"))).toBe(true);
    const build = await ws.run("build");
    expect(build.code, build.out).toBe(0);
    const acme = await ws.read("codeflow-report-acme.html");
    const beta = await ws.read("codeflow-report-beta.html");
    expect(acme).toContain(`${OWNER}/api`);
    expect(acme).not.toContain(`${OWNER}/web`);
    expect(beta).toContain(`${OWNER}/web`);
    for (const other of [`${OWNER}/api`, `${OWNER}/legacy`, '"org":"acme"']) {
      expect(beta).not.toContain(other);
    }
  });

  it("TC-202 a command about one org asks which, and names the orgs there are", async () => {
    const result = await ws.run("summary");
    expect(result.code).toBe(1);
    expect(result.out).toContain("say which with --org (acme, beta)");
    expect(result.out).not.toMatch(NO_STACK);
    const unknown = await ws.run("summary", "--org", "gamma");
    expect(unknown.out).toContain('No org called "gamma"');
    const ok = await ws.run("summary", "--org", "beta");
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain(`${OWNER}/web`);
    expect(ok.out).not.toContain(`${OWNER}/api`);
  });

  it("TC-203 export then import moves teams and rules to another org, previewed first", async () => {
    await ws.write(
      "orgs/acme/groups.yml",
      "teams:\n  # the API crew\n  Platform:\n    people: [ana, devon]\n",
    );
    await ws.write(
      "orgs/acme/rules.yml",
      "rules:\n  - id: no-chores\n    when: { labels: [chore] }\n    then: { count: false }\n",
    );
    const exported = await ws.run("export", "--org", "acme", "-o", "acme.yml");
    expect(exported.code, exported.out).toBe(0);
    const bundle = await ws.read("acme.yml");
    expect(bundle).toMatch(/^codeflow: 1$/m);
    expect(bundle).not.toContain(TOKEN_ENV.toLowerCase());

    const before = await ws.read("orgs/beta/groups.yml");
    const dry = await ws.run("import", "acme.yml", "--org", "beta", "--dry-run");
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toContain("teams: added Platform");
    expect(dry.out).toContain("rules: added no-chores");
    expect(await ws.read("orgs/beta/groups.yml")).toBe(before);

    const wet = await ws.run("import", "acme.yml", "--org", "beta");
    expect(wet.code, wet.out).toBe(0);
    expect(await ws.read("orgs/beta/groups.yml")).toContain("Platform");
    const rules = await ws.run("rules", "--org", "beta");
    expect(rules.out).toContain("no-chores");
  });

  it("TC-204 teams import from a spreadsheet's CSV", async () => {
    await ws.write(
      "teams.csv",
      "team,login,from,to,secondary,name\nWeb,mika,,,,Mika Lee\nWeb,rui,2026-01-01,,,\n",
    );
    const result = await ws.run("import", "teams.csv", "--org", "beta");
    expect(result.code, result.out).toBe(0);
    const groups = await ws.read("orgs/beta/groups.yml");
    expect(groups).toContain("Web:");
    expect(groups).toContain("rui");
    expect(await ws.read("orgs/beta/people.yml")).toContain("Mika Lee");
  });

  it("TC-205 an invalid import or config is refused, naming the file and the fix", async () => {
    await ws.write("clash.yml", "codeflow: 1\nteams:\n  Data: { people: [ana] }\n");
    const before = await ws.read("orgs/beta/groups.yml");
    const clash = await ws.run("import", "clash.yml", "--org", "beta");
    expect(clash.code).toBe(1);
    expect(clash.out).toMatch(/groups\.yml: .*ana is in .* at the same time/);
    expect(clash.out).not.toMatch(NO_STACK);
    expect(await ws.read("orgs/beta/groups.yml")).toBe(before);

    await ws.write("orgs/beta/org.yml", `${await ws.read("orgs/beta/org.yml")}\nteamz: {}\n`);
    const typo = await ws.run("status", "--org", "beta");
    expect(typo.code).toBe(1);
    expect(typo.out).toContain("org.yml");
    expect(typo.out).toContain("teamz");
    expect(typo.out).not.toMatch(NO_STACK);
  });
});

describe("what goes wrong, said plainly", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await workspace(acmeRepos());
    await ws.addOrg("acme", "--owner", OWNER, "--since", since);
  });
  afterAll(() => ws.stop());

  it("TC-206 no token, a rejected token, and GitHub unreachable each say what to do", async () => {
    const none = await ws.runWith({ [TOKEN_ENV]: undefined }, "doctor");
    expect(none.code).toBe(1);
    expect(none.out).toContain(`No GitHub token found. Set ${TOKEN_ENV}`);
    expect(none.out).not.toMatch(NO_STACK);

    const wrong = await ws.runWith({ [TOKEN_ENV]: "not-the-token" }, "sync");
    expect(wrong.code).toBe(1);
    expect(wrong.out).toContain("GitHub rejected the token");
    expect(wrong.out).not.toMatch(NO_STACK);

    await ws.stop();
    const down = await ws.run("doctor");
    expect(down.code).toBe(1);
    expect(down.out).toContain(`Couldn't reach GitHub at ${ws.apiUrl}`);
    expect(down.out).not.toMatch(NO_STACK);
  });

  it("TC-207 commands that need data say to sync first", async () => {
    for (const command of [["summary"], ["pr", "1"]]) {
      const result = await ws.run(...command);
      expect(result.code, command.join(" ")).toBe(1);
      expect(result.out, command.join(" ")).toMatch(/sync/i);
      expect(result.out).not.toMatch(NO_STACK);
    }
  });
});

describe("upgrading a single-file config", () => {
  it("TC-208 migrate turns it into a workspace, keeping the data and the numbers", async () => {
    const ws = await workspace(acmeRepos());
    try {
      await ws.write(
        "codeflow.yml",
        [
          "# Acme's codeflow config, from before workspaces",
          "sources:",
          `  - repo: ${OWNER}/api`,
          `since: ${since}`,
          "github:",
          `  api_url: ${ws.apiUrl}`,
          `  token_env: ${TOKEN_ENV}`,
          "teams:",
          "  Platform:",
          "    people: [ana, devon]",
          "",
        ].join("\n"),
      );
      expect((await ws.run("sync")).code).toBe(0);
      const before = await ws.run("summary", "--json");
      const migrated = await ws.run("migrate", "--org", "acme");
      expect(migrated.code, migrated.out).toBe(0);
      expect(await ws.read("orgs/acme/org.yml")).toContain("# Acme's codeflow config");
      expect(await ws.read("orgs/acme/groups.yml")).toContain("Platform");
      expect(existsSync(join(ws.dir, "codeflow.yml.single.bak"))).toBe(true);
      const after = await ws.run("summary", "--json");
      const metrics = (text: string) => (JSON.parse(text) as { metrics: unknown }).metrics;
      expect(metrics(after.stdout)).toEqual(metrics(before.stdout));
    } finally {
      await ws.stop();
    }
  });
});
