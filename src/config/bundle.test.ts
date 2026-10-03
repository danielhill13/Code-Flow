import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { init } from "../cli/init.ts";
import { importConfig } from "../cli/transfer.ts";
import {
  applyImport,
  describeChanges,
  exportBundle,
  parseCsv,
  planImport,
  readBundle,
  readRaw,
  renderBundle,
} from "./bundle.ts";
import { loadWorkspace, type Org } from "./workspace.ts";

/** A workspace with two orgs: acme, filled in, and beta, as init leaves it. */
async function workspace(): Promise<{ root: string; config: string; acme: Org; beta: Org }> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const root = await mkdtemp(join(tmpdir(), "codeflow-bundle-"));
  const config = join(root, "codeflow.yml");
  await init({ config, org: "acme", owner: ["acme"], since: "2026-01-01" });
  await init({ config, org: "beta", owner: ["beta"], since: "2026-02-01" });
  await writeFile(
    join(root, "orgs/acme/people.yml"),
    "people:\n  ana: { name: Ana Ruiz, github: [ana-r] }\n",
  );
  await writeFile(
    join(root, "orgs/acme/groups.yml"),
    [
      "teams:",
      "  # the platform crew",
      "  Platform:",
      "    people: [mika, { login: devon, to: 2026-05-31 }]",
      "  Payments:",
      "    people: [ana, { login: devon, from: 2026-06-01 }]",
      "groups:",
      "  Mobile: { kind: area, people: [mika] }",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "orgs/acme/rules.yml"),
    "rules:\n  - id: no-chores\n    when: { labels: [chore] }\n    then: { count: false }\n",
  );
  const loaded = await loadWorkspace(config);
  const [acme, beta] = loaded.orgs;
  if (!acme || !beta) throw new Error("expected two orgs");
  return { root, config, acme, beta };
}

describe("export and import", () => {
  it("moves people, groups and rules to another org, leaving its settings alone", async () => {
    const { config, acme, beta } = await workspace();
    for (const format of ["yaml", "json"] as const) {
      const text = renderBundle(await exportBundle(acme, ["people", "groups", "rules"]), format);
      const bundle = readBundle(text, format, `bundle.${format}`);
      const plan = await planImport(beta, bundle, ["people", "groups", "rules"], "replace");
      await applyImport(beta, plan);
    }
    const after = (await loadWorkspace(config)).orgs;
    const [a, b] = after;
    for (const key of ["people", "teams", "groups", "rules"] as const) {
      expect(b?.config[key]).toEqual(a?.config[key]);
    }
    expect(b?.config.since).toBe("2026-02-01");
    expect(b?.config.sources).not.toEqual(a?.config.sources);
  });

  it("merges by adding and updating entries, and replaces by also removing them", async () => {
    const { acme } = await workspace();
    const bundle = readBundle(
      [
        "codeflow: 1",
        "teams:",
        "  Platform: { people: [mika, lee] }",
        "  Data: { people: [sam] }",
        "rules:",
        "  - id: no-drafts",
        "    when: { draft: true }",
        "    then: { count: false }",
      ].join("\n"),
      "yaml",
      "b.yml",
    );
    const merge = await planImport(acme, bundle, ["groups", "rules"], "merge");
    expect(describeChanges(merge.changes)).toEqual([
      "teams: added Data; changed Platform",
      "rules: added no-drafts",
    ]);
    const replace = await planImport(acme, bundle, ["groups", "rules"], "replace");
    expect(describeChanges(replace.changes)).toEqual([
      "teams: added Data; changed Platform; removed Payments",
      "rules: added no-drafts; removed no-chores",
    ]);
  });

  it("keeps the comments on entries it doesn't change", async () => {
    const { root, acme } = await workspace();
    const bundle = readBundle("codeflow: 1\nteams:\n  Data: { people: [sam] }\n", "yaml", "b.yml");
    await applyImport(acme, await planImport(acme, bundle, ["groups"], "merge"));
    const text = await readFile(join(root, "orgs/acme/groups.yml"), "utf8");
    expect(text).toContain("# the platform crew");
    expect(text).toContain("Data:");
  });

  it("keeps the rules it doesn't change as they were written, in the new order", async () => {
    const { root, acme } = await workspace();
    await writeFile(
      join(root, "orgs/acme/rules.yml"),
      [
        "rules:",
        "  # housekeeping",
        "  - id: no-chores",
        "    when: { labels: [chore] }",
        "    then: { count: false }",
        "  - id: no-drafts",
        "    when: { draft: true }",
        "    then: { count: false }",
        "",
      ].join("\n"),
    );
    // Edited as the Setup tab sends it: whole, keys in its own order, no-drafts moved first.
    const bundle = readBundle(
      JSON.stringify({
        codeflow: 1,
        rules: [
          { then: { count: false }, when: { draft: true }, id: "no-drafts", description: "WIP" },
          { id: "no-chores", then: { count: false }, when: { labels: ["chore"] } },
        ],
      }),
      "json",
      "b.json",
    );
    await applyImport(acme, await planImport(acme, bundle, ["rules"], "replace"));
    const text = await readFile(join(root, "orgs/acme/rules.yml"), "utf8");
    expect(text).toContain("# housekeeping");
    expect(text).toMatch(/- id: no-chores\n {4}when: \{ labels: \[ chore \] \}\n {4}then: \{/);
    expect(text.indexOf("no-drafts")).toBeLessThan(text.indexOf("no-chores"));
    expect(text).toContain("description: WIP");
  });

  it("refuses an import that would leave the org invalid, saying which file, writing nothing", async () => {
    const { root, acme } = await workspace();
    const before = await readFile(join(root, "orgs/acme/groups.yml"), "utf8");
    const bundle = readBundle("codeflow: 1\nteams:\n  Data: { people: [mika] }\n", "yaml", "b.yml");
    await expect(planImport(acme, bundle, ["groups"], "merge")).rejects.toThrow(
      /groups\.yml: .*mika is in Platform and Data at the same time/,
    );
    expect(await readFile(join(root, "orgs/acme/groups.yml"), "utf8")).toBe(before);
    expect(() => readBundle("codeflow: 2\n", "yaml", "old.yml")).toThrow(
      /version this codeflow reads/,
    );
  });

  it("writes nothing on a dry run", async () => {
    const { root, config } = await workspace();
    const file = join(root, "b.yml");
    await writeFile(file, "codeflow: 1\nteams:\n  Data: { people: [sam] }\n");
    const before = await readRaw((await loadWorkspace(config)).orgs[1] as Org);
    expect(await importConfig(file, { config, org: "beta", dryRun: true })).toBe(0);
    expect(await readRaw((await loadWorkspace(config)).orgs[1] as Org)).toEqual(before);
    expect(await importConfig(file, { config, org: "beta" })).toBe(0);
    expect((await loadWorkspace(config)).orgs[1]?.config.teams.Data).toBeDefined();
  });
});

describe("CSV of teams", () => {
  it("reads quoted cells, dates and secondary memberships, and writes them back", async () => {
    const { acme, beta } = await workspace();
    const csv = renderBundle(await exportBundle(acme, ["people", "groups"]), "csv");
    expect(csv.split("\n").slice(0, 3)).toEqual([
      "team,login,from,to,secondary,name",
      "Platform,mika,,,,",
      "Platform,devon,,2026-05-31,,",
    ]);
    const bundle = readBundle(csv, "csv", "teams.csv");
    await applyImport(beta, await planImport(beta, bundle, ["people", "groups"], "merge"));
    const config = (await loadWorkspace(join(acme.dir, "../../codeflow.yml"))).orgs[1]?.config;
    expect(config?.teams.Payments?.people).toEqual([
      { login: "ana", from: null, to: null, secondary: false },
      { login: "devon", from: "2026-06-01", to: null, secondary: false },
    ]);
    expect(config?.people.ana).toEqual({ name: "Ana Ruiz" });
  });

  it("parses RFC 4180, and asks for team and login columns", () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n1,2,3\n')).toEqual([
      ["a", "b, c", 'say "hi"'],
      ["1", "2", "3"],
    ]);
    expect(() => readBundle("name\nAna\n", "csv", "t.csv")).toThrow(/including team/);
  });
});
