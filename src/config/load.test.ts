import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "./load.ts";

describe("codeflow.example.yml", () => {
  it("stays a valid config as the schema changes", async () => {
    const example = fileURLToPath(new URL("../../codeflow.example.yml", import.meta.url));
    const config = await loadConfig(example);
    expect(config.sources.map((s) => s.kind)).toEqual(["owner", "repo"]);
  });
});

const errorOf = (text: string) => {
  try {
    parseConfig(text);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected parseConfig to throw");
};

describe("parseConfig", () => {
  it("fills in defaults for a minimal config", () => {
    const config = parseConfig(`
sources:
  - owner: acme
  - repo: someone/tool
since: 2025-10-01
`);
    expect(config).toEqual({
      sources: [
        {
          kind: "owner",
          owner: "acme",
          include: ["*"],
          exclude: [],
          archived: false,
          forks: false,
        },
        { kind: "repo", owner: "someone", name: "tool" },
      ],
      since: "2025-10-01",
      github: { api_url: "https://api.github.com", token_env: "GITHUB_TOKEN" },
    });
  });

  it("keeps owner filters and github overrides", () => {
    const config = parseConfig(`
sources:
  - owner: acme
    include: ["api-*"]
    exclude: ["*-archive"]
    archived: true
since: 2025-01-01
github:
  api_url: https://ghe.example.com/api/v3
`);
    expect(config.sources[0]).toMatchObject({
      include: ["api-*"],
      exclude: ["*-archive"],
      archived: true,
      forks: false,
    });
    expect(config.github).toEqual({
      api_url: "https://ghe.example.com/api/v3",
      token_env: "GITHUB_TOKEN",
    });
  });

  it("names the field that is wrong", () => {
    expect(errorOf("sources:\n  - repo: not-a-repo\nsince: 2025-10-01\n")).toContain(
      "sources[0].repo: must look like owner/name",
    );
    expect(errorOf("sources:\n  - owner: acme\nsince: last year\n")).toContain(
      "since: must be a date like 2025-10-01",
    );
    expect(errorOf("sources: []\nsince: 2025-10-01\n")).toContain(
      "sources: add at least one source",
    );
  });

  it("requires exactly one of owner or repo", () => {
    expect(errorOf("sources:\n  - owner: a\n    repo: a/b\nsince: 2025-10-01\n")).toContain(
      "set exactly one of `owner` or `repo`",
    );
    expect(errorOf("sources:\n  - include: ['*']\nsince: 2025-10-01\n")).toContain(
      "set exactly one of `owner` or `repo`",
    );
  });

  it("rejects owner-only filters on a repo source", () => {
    expect(errorOf("sources:\n  - repo: a/b\n    exclude: [x]\nsince: 2025-10-01\n")).toContain(
      "only apply to `owner` sources",
    );
  });

  it("rejects unknown keys rather than ignoring them", () => {
    expect(errorOf("sources:\n  - owner: a\nsince: 2025-10-01\ngroups: {}\n")).toMatch(/groups/);
  });

  it("rejects impossible dates", () => {
    expect(errorOf("sources:\n  - owner: a\nsince: 2025-02-30\n")).toContain("since:");
  });

  it("reports YAML syntax errors with the file name", () => {
    expect(errorOf("sources: [\n")).toMatch(/^codeflow\.yml: /);
  });
});
