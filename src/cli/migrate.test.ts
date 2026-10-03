import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadWorkspace } from "../config/workspace.ts";
import { Store } from "../store/store.ts";
import { migrate } from "./migrate.ts";

describe("migrate", () => {
  it("splits a single-file config into an org's files, comments and data included", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = await mkdtemp(join(tmpdir(), "codeflow-"));
    const config = join(root, "codeflow.yml");
    await writeFile(
      config,
      [
        "# measured since the reorg",
        "sources:",
        "  - owner: Acme",
        "since: 2025-10-01 # a year back",
        "",
        "# who works where",
        "teams:",
        "  Core:",
        "    people: [ana]",
        "",
      ].join("\n"),
    );
    const before = (await loadWorkspace(config)).orgs[0]?.config;
    Store.open(join(root, ".codeflow", "codeflow.db")).close();

    await migrate({ config });

    const workspace = await loadWorkspace(config);
    expect(workspace.single).toBe(false);
    const [org] = workspace.orgs;
    expect(org?.name).toBe("acme");
    expect(org?.config).toEqual(before);
    expect(org?.dbPath).toBe(join(root, ".codeflow", "acme", "codeflow.db"));
    expect(existsSync(org?.dbPath ?? "")).toBe(true);
    expect(existsSync(join(root, ".codeflow", "codeflow.db"))).toBe(false);
    expect(await readFile(join(root, "orgs/acme/org.yml"), "utf8")).toContain("# a year back");
    expect(await readFile(join(root, "orgs/acme/groups.yml"), "utf8")).toContain(
      "# who works where",
    );
    expect(existsSync(`${config}.single.bak`)).toBe(true);
    await expect(migrate({ config })).rejects.toThrow(/already a workspace/);
  });
});
