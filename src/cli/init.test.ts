import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../config/load.ts";
import { loadWorkspace } from "../config/workspace.ts";
import { defaultSince, init, orgNameFrom, renderConfig } from "./init.ts";

describe("renderConfig", () => {
  it("writes a config that loads back to the same sources", () => {
    const text = renderConfig({ owners: ["acme"], repos: ["someone/tool"], since: "2025-10-01" });
    expect(parseConfig(text).sources).toEqual([
      { kind: "owner", owner: "acme", include: ["*"], exclude: [], archived: false, forks: false },
      { kind: "repo", owner: "someone", name: "tool" },
    ]);
  });

  it("quotes names that YAML would otherwise read as booleans or numbers", () => {
    const text = renderConfig({ owners: ["true", "123"], repos: [], since: "2025-10-01" });
    expect(parseConfig(text).sources.map((s) => s.owner)).toEqual(["true", "123"]);
  });
});

describe("defaultSince", () => {
  it("is the first of the month, a year back", () => {
    expect(defaultSince(new Date("2026-10-02T12:00:00Z"))).toBe("2025-10-01");
    expect(defaultSince(new Date("2026-01-31T23:59:00Z"))).toBe("2025-01-01");
  });
});

describe("init", () => {
  const quiet = () => vi.spyOn(console, "log").mockImplementation(() => {});

  it("creates a workspace, then adds orgs to it, keeping its comments", async () => {
    quiet();
    const root = await mkdtemp(join(tmpdir(), "codeflow-"));
    const config = join(root, "codeflow.yml");
    await init({ config, owner: ["Acme-Corp"] });
    await writeFile(config, `# ours\n${await readFile(config, "utf8")}`);
    await init({ config, org: "beta", repo: ["beta-inc/api"], since: "2026-01-01" });

    expect(await readFile(config, "utf8")).toContain("# ours");
    const workspace = await loadWorkspace(config);
    expect(workspace.orgs.map((o) => [o.name, o.config.since])).toEqual([
      ["acme-corp", defaultSince()],
      ["beta", "2026-01-01"],
    ]);
    expect(existsSync(join(root, "orgs/beta/groups.yml"))).toBe(true);
    expect(existsSync(join(root, "orgs/beta/people.yml"))).toBe(true);
    expect(existsSync(join(root, "orgs/beta/rules.yml"))).toBe(true);
  });

  it("refuses to replace an org without --force, and a single-file config", async () => {
    quiet();
    const root = await mkdtemp(join(tmpdir(), "codeflow-"));
    const config = join(root, "codeflow.yml");
    await init({ config, owner: ["acme"] });
    await expect(init({ config, owner: ["acme"] })).rejects.toThrow(/already has an org/);
    await init({ config, owner: ["acme"], since: "2026-02-01", force: true });
    expect((await loadWorkspace(config)).orgs[0]?.config.since).toBe("2026-02-01");

    await writeFile(config, "sources:\n  - owner: x\nsince: 2025-10-01\n");
    await expect(init({ config, owner: ["acme"] })).rejects.toThrow(/codeflow migrate/);
  });

  it("needs something to measure, and a name that works as a folder", async () => {
    await expect(init({ config: "unused.yml" })).rejects.toThrow(/--owner/);
    await expect(init({ config: "unused.yml", owner: ["x"], org: "Bad Name" })).rejects.toThrow(
      /can't name an org/,
    );
    expect(orgNameFrom("Acme Corp")).toBe("acme-corp");
  });
});
