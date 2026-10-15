import { describe, expect, it } from "vitest";
import type { UsageRow } from "../../core/file-usage.ts";
import { ruleFor } from "./files.tsx";

const row = (name: string, whole = false): UsageRow => ({
  name,
  changes: 10,
  prs: 2,
  perPr: 5,
  bulk: false,
  whole,
  examples: [],
  extensions: [],
});

describe("a path rule from a row of what your PRs change", () => {
  it("counts a folder with its subfolders, a kind by extension, a whole name by name", () => {
    expect(ruleFor(row("thoughts"), true, "docs", null)).toEqual({
      match: ["thoughts/**"],
      bucket: "docs",
    });
    expect(ruleFor(row("research/data"), true, "docs", null)?.match).toEqual(["research/data/**"]);
    expect(ruleFor(row(".png"), false, "assets", null)?.match).toEqual(["**/*.png"]);
    expect(ruleFor(row("Dockerfile", true), false, "generated", null)?.match).toEqual([
      "**/Dockerfile",
    ]);
    expect(ruleFor(row(".gitignore", true), false, "docs", null)?.match).toEqual(["**/.gitignore"]);
  });

  it("keeps a rule to the repo being looked at, and makes none for the repo root", () => {
    expect(ruleFor(row("notes"), true, "docs", "acme/api")).toEqual({
      match: ["notes/**"],
      bucket: "docs",
      repos: ["acme/api"],
    });
    expect(ruleFor(row("(repo root)"), true, "docs", null)).toBeNull();
  });
});
