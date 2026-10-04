// A new user's first run, as getting-started.md walks it: init, doctor, sync, status, summary,
// pr, build. The real CLI, as its own process, against a fake GitHub serving a made-up org.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GhPayload } from "../../src/providers/github/normalize.ts";
import { acmeRepos, countedMerges, scenarioStart } from "../../src/testing/scenario.ts";
import { type Workspace, workspace } from "./support.ts";

const repos = acmeRepos();
const since = new Date(scenarioStart() - 14 * 86_400_000).toISOString().slice(0, 10);
let ws: Workspace;

beforeAll(async () => {
  ws = await workspace(repos);
});
afterAll(() => ws.stop());

/** Every PR the fake GitHub holds for a repo with any PR activity since `since`. */
const total = repos.reduce((n, repo) => n + repo.prs.length, 0);

type Summary = {
  period: { start: string; end: string; label: string };
  metrics: { key: string; value: number | null; n: number; hidden?: string }[];
};

describe("a first run, step by step", () => {
  it("TC-101 init writes a workspace and the org's folder of config files", async () => {
    await ws.addOrg("acme", "--owner", "acme-co", "--since", since);
    expect(await ws.read("codeflow.yml")).toMatch(/orgs:\s+acme:/);
    for (const file of ["org.yml", "people.yml", "groups.yml", "rules.yml"]) {
      expect(existsSync(join(ws.dir, "orgs/acme", file)), file).toBe(true);
    }
  });

  it("TC-102 doctor checks the token and repos, skips archived ones, and stores nothing", async () => {
    const result = await ws.run("doctor");
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("codeflow-tester");
    expect(result.out).toContain("3 repos selected; skipped 1 archived");
    expect(result.out).toMatch(/First sync\s+\d+ PRs updated since/);
    expect(result.out).toContain("everything checks out");
    expect(existsSync(join(ws.dir, ".codeflow/acme/codeflow.db"))).toBe(false);
  });

  it("TC-103 sync stores every PR since `since`, reporting each repo", async () => {
    const result = await ws.run("sync");
    expect(result.code, result.out).toBe(0);
    for (const repo of ["api", "web", "legacy"]) expect(result.out).toContain(`acme-co/${repo}:`);
    expect(result.out).toContain(`${total} new or changed PR versions`);
  });

  it("TC-104 a second sync fetches only what changed", async () => {
    const before = ws.github.calls.length;
    const quiet = await ws.run("sync");
    expect(quiet.code, quiet.out).toBe(0);
    expect(quiet.out).toContain("0 new or changed");

    const open = repos[0]?.prs.find((pr) => pr.state === "OPEN");
    if (!open) throw new Error("the scenario has open PRs");
    const merged: GhPayload = {
      ...open,
      state: "MERGED",
      isDraft: false,
      mergedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      closedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      updatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    };
    ws.github.put("acme-co/api", merged);
    const changed = await ws.run("sync");
    expect(changed.code, changed.out).toBe(0);
    expect(changed.out).toContain("1 new or changed");
    // Three repos, a page or two each: nothing like re-reading every PR.
    expect(ws.github.count("PrPage", before)).toBeLessThan(15);
  });

  it("TC-105 status shows what is stored, and flags work landing on an unmeasured branch [rule 2]", async () => {
    const result = await ws.run("status");
    expect(result.code, result.out).toBe(0);
    expect(result.out).toMatch(/PRs\s+\d+ stored from 3 repos/);
    expect(result.out).toMatch(
      /acme-co\/legacy: \d+ of \d+ PRs merged in the last 90 days went into develop/,
    );
    // The advice names the file to edit: the org's own, in a workspace.
    expect(result.out).toContain(`measure it in ${join("orgs", "acme", "org.yml")}`);
    expect(result.out).toContain("acme-co/legacy: [main, develop]");
  });

  it("TC-106 summary counts what a person counting by hand would, and shows no number it can't back", async () => {
    const result = await ws.run("summary", "--json");
    expect(result.code, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout) as Summary;
    const merged = summary.metrics.find((m) => m.key === "merged");
    const expected = countedMerges(repos, summary.period.start, summary.period.end);
    expect(merged?.value, summary.period.label).toBe(expected);
    expect(expected).toBeGreaterThan(10);
    // [rule 4] A metric that can't be shown is null with a reason, never 0.
    for (const metric of summary.metrics) {
      if (metric.value === null) expect(metric.hidden ?? "", metric.key).not.toBe("");
    }
    const table = await ws.run("summary", "--percentile", "75", "--explain");
    expect(table.code, table.out).toBe(0);
    expect(table.out).toContain("P75");
    expect(table.out).not.toMatch(/undefined|NaN|\[object Object\]/);
  });

  it("TC-107 pr explains how one PR was read: a bot's, a promotion and a revert", async () => {
    const bot = await ws.run("pr", "acme-co/api#200");
    expect(bot.code, bot.out).toBe(0);
    expect(bot.out).toContain("Counted     no: a bot opened it");
    const promotion = await ws.run("pr", "acme-co/web#300");
    expect(promotion.out).toMatch(/Counted\s+no: .*promot/);
    const revert = await ws.run("pr", "acme-co/api#201");
    expect(revert.out).toMatch(/revert/i);
    const reverted = await ws.run("pr", "https://github.com/acme-co/api/pull/11");
    expect(reverted.code, reverted.out).toBe(0);
    expect(reverted.out).toMatch(/reverted by .*#201/i);
  });

  it("TC-111 stale PRs are counted apart from open ones, and a bot's nudge doesn't revive one", async () => {
    const summary = await ws.run("summary");
    expect(summary.out).toMatch(/Open now: \d+ PRs/);
    expect(summary.out).toContain("Stale: 1 open PR with no activity for more than 90 days");
    const forgotten = await ws.run("pr", "acme-co/api#202");
    expect(forgotten.out).toMatch(/Stale\s+no activity since \d{4}-\d{2}-\d{2}, more than 90 days/);
    // The org can choose its own window: a year, and the PR is open again.
    const file = "orgs/acme/org.yml";
    const before = await ws.read(file);
    await ws.write(file, `${before}\nstale_after_days: 365\n`);
    expect((await ws.run("summary")).out).not.toContain("Stale:");
    await ws.write(file, before);
  });

  it("TC-108 build writes one report file holding the org's data", async () => {
    const result = await ws.run("build");
    expect(result.code, result.out).toBe(0);
    const html = await ws.read("codeflow-report-acme.html");
    expect(html).toContain("acme-co/api");
    expect(html).toContain('"org":"acme"');
    expect(html.length).toBeGreaterThan(50_000);
  });

  it("TC-109 a config change takes effect without a new sync [rule 2]", async () => {
    const intoDevelop = "acme-co/legacy#20";
    expect((await ws.run("pr", intoDevelop)).out).toMatch(/Counted\s+no: it targets develop/);
    const file = "orgs/acme/org.yml";
    await ws.write(file, `${await ws.read(file)}\nbranches:\n  acme-co/legacy: [main, develop]\n`);
    const calls = ws.github.calls.length;
    const status = await ws.run("status");
    expect(status.out).not.toContain("went into develop");
    expect((await ws.run("pr", intoDevelop)).out).toMatch(/Counted\s+yes/);
    expect(ws.github.calls.length).toBe(calls);
  });

  it("TC-112 run syncs and then builds, for a scheduler such as cron", async () => {
    const result = await ws.run("run");
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("0 new or changed");
    expect(result.out).toMatch(/Report\s+codeflow-report-acme\.html/);
  });

  it("TC-110 rules lists the org's rules, and rules test previews a draft without saving it", async () => {
    await ws.write(
      "draft.yml",
      "rules:\n  - id: no-chores\n    when: { labels: [chore] }\n    then: { count: false }\n",
    );
    const before = await ws.read("orgs/acme/rules.yml");
    const preview = await ws.run("rules", "test", "draft.yml");
    expect(preview.code, preview.out).toBe(0);
    expect(preview.out).toMatch(/Would stop counting: \d+ PRs/);
    expect(preview.out).toContain("rule no-chores");
    expect(await ws.read("orgs/acme/rules.yml")).toBe(before);
    const list = await ws.run("rules");
    expect(list.out).toContain("config:promotions");
    expect(list.out).toContain("config:branches:acme-co/legacy");
  });
});
