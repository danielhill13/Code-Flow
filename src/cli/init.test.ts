import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../config/load.ts";
import { defaultSince, init, renderConfig } from "./init.ts";

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
  it("refuses to replace an existing config without --force", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const config = join(await mkdtemp(join(tmpdir(), "codeflow-")), "codeflow.yml");
    await writeFile(config, "keep me");

    await expect(init({ config, owner: ["acme"] })).rejects.toThrow(/already exists/);
    expect(await readFile(config, "utf8")).toBe("keep me");

    await init({ config, owner: ["acme"], force: true });
    expect(await readFile(config, "utf8")).toContain("- owner: acme");
  });

  it("needs something to measure", async () => {
    await expect(init({ config: "unused.yml" })).rejects.toThrow(/--owner/);
  });
});
