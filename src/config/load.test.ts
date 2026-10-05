import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROMOTION_BRANCHES } from "../core/derive.ts";
import { loadConfig, parseConfig } from "./load.ts";
import { everyMs } from "./schema.ts";

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
      azure_devops: { url: "https://dev.azure.com", token_env: "AZURE_DEVOPS_TOKEN" },
      branches: {},
      promotions: [...DEFAULT_PROMOTION_BRANCHES],
      bots: { accounts: [], reviewers: [], include_prs: true, ignore_bodies: [] },
      paths: [],
      sync_every: "24h",
      stale_after_days: 90,
      people_views: true,
      churn_window_days: 30,
      size_target_lines: 400,
      local_copies: [],
      people: {},
      teams: {},
      groups: {},
      products: {},
      rules: [],
    });
  });

  it("reads teams of people, with dates, and products of repos and teams", () => {
    const config = parseConfig(`
sources:
  - owner: acme
since: 2025-10-01
teams:
  Platform:
    people: [mika, { login: devon, to: 2026-05-31 }]
  Payments:
    people: [ana, { login: devon, from: 2026-06-01 }, { login: mika, secondary: true }]
products:
  Checkout:
    repos: ["acme/cart-*"]
    teams: [Payments]
`);
    expect(config.teams.Payments?.people).toEqual([
      { login: "ana", from: null, to: null, secondary: false },
      { login: "devon", from: "2026-06-01", to: null, secondary: false },
      { login: "mika", from: null, to: null, secondary: true },
    ]);
    expect(config.products).toEqual({
      Checkout: { repos: ["acme/cart-*"], teams: ["Payments"], people: [] },
    });
  });

  it("refuses a person in two teams at once, an unknown team, and the catch-all names", () => {
    const base = "sources:\n  - owner: a\nsince: 2025-10-01\n";
    expect(errorOf(`${base}teams:\n  A: { people: [sam] }\n  B: { people: [sam] }\n`)).toContain(
      "sam is in A and B at the same time",
    );
    expect(errorOf(`${base}products:\n  P: { teams: [Nobody] }\n`)).toContain(
      'no team is called "Nobody"',
    );
    expect(errorOf(`${base}teams:\n  No team: { people: [x] }\n`)).toContain(
      "the report's name for PRs outside any team or group",
    );
    expect(errorOf(`${base}products:\n  Empty: {}\n`)).toContain(
      "give the product `repos`, `teams`",
    );
  });

  it("reads people with their logins, and groups of any kind", () => {
    const config = parseConfig(`
sources:
  - owner: acme
since: 2025-10-01
people:
  ana: { name: Ana Ruiz, github: [ana-r, ana-old] }
  deploy: { github: [deploy-svc], bot: true }
  mika: {}
groups:
  Mobile: { kind: area, people: [mika], repos: ["acme/ios-*"] }
  Q4 launch: { teams: [] , people: [ana] }
`);
    expect(config.people).toEqual({
      ana: { name: "Ana Ruiz", github: ["ana-r", "ana-old"] },
      deploy: { github: ["deploy-svc"], bot: true },
      mika: {},
    });
    expect(config.groups.Mobile).toEqual({
      kind: "area",
      repos: ["acme/ios-*"],
      teams: [],
      people: ["mika"],
    });
    expect(config.groups["Q4 launch"]?.kind).toBe("group");
  });

  it("refuses a group named like a catch-all, two groups of one name, and a shared login", () => {
    const base = "sources:\n  - owner: a\nsince: 2025-10-01\n";
    expect(errorOf(`${base}groups:\n  No area: { kind: area, people: [x] }\n`)).toContain(
      "the report's name for PRs in no area",
    );
    expect(
      errorOf(`${base}groups:\n  Core: { people: [x] }\nproducts:\n  Core: { people: [y] }\n`),
    ).toContain('another group is called "Core"');
    expect(errorOf(`${base}groups:\n  G: { kind: Big Area, people: [x] }\n`)).toContain(
      "one lowercase word",
    );
    expect(
      errorOf(`${base}people:\n  a: { github: [shared] }\n  b: { github: [shared] }\n`),
    ).toContain("shared is listed under both a and b");
  });

  it("reads measurement settings", () => {
    const config = parseConfig(`
sources:
  - owner: acme
since: 2025-10-01
branches:
  acme/legacy: [develop, main]
bots:
  reviewers: [coderabbitai]
  ignore_bodies: ["configured for manual reviews"]
paths:
  - { match: "packages/*-tests/**", bucket: test }
  - { match: ["docs/**", "site/**"], bucket: product, repos: [acme/website] }
`);
    expect(config.branches).toEqual({ "acme/legacy": ["develop", "main"] });
    expect(config.bots).toMatchObject({ reviewers: ["coderabbitai"], include_prs: true });
    expect(config.paths).toEqual([
      { match: ["packages/*-tests/**"], bucket: "test" },
      { match: ["docs/**", "site/**"], bucket: "product", repos: ["acme/website"] },
    ]);
  });

  it("rejects an unknown bucket and an invalid regular expression", () => {
    const base = "sources:\n  - owner: a\nsince: 2025-10-01\n";
    expect(errorOf(`${base}paths:\n  - { match: "x/**", bucket: tests }\n`)).toContain(
      "paths[0].bucket",
    );
    expect(errorOf(`${base}bots:\n  ignore_bodies: ["(unclosed"]\n`)).toContain(
      "bots.ignore_bodies[0]: must be a valid regular expression",
    );
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

  it("requires exactly one of owner, repo or ado", () => {
    expect(errorOf("sources:\n  - owner: a\n    repo: a/b\nsince: 2025-10-01\n")).toContain(
      "set exactly one of `owner`, `repo` (GitHub) or `ado` (Azure DevOps)",
    );
    expect(errorOf("sources:\n  - include: ['*']\nsince: 2025-10-01\n")).toContain(
      "set exactly one of `owner`, `repo` (GitHub) or `ado` (Azure DevOps)",
    );
  });

  it("reads Azure DevOps sources and where Azure DevOps is", () => {
    const config = parseConfig(
      "sources:\n  - ado: contoso\n    project: Platform\n    exclude: [old-*]\nsince: 2025-10-01\n" +
        "azure_devops:\n  url: https://tfs.acme.com/tfs\n",
    );
    expect(config.sources).toEqual([
      {
        kind: "ado",
        organization: "contoso",
        project: "Platform",
        include: ["*"],
        exclude: ["old-*"],
        forks: false,
      },
    ]);
    expect(config.azure_devops).toEqual({
      url: "https://tfs.acme.com/tfs",
      token_env: "AZURE_DEVOPS_TOKEN",
    });
    expect(errorOf("sources:\n  - owner: a\n    project: P\nsince: 2025-10-01\n")).toContain(
      "`project` only applies to `ado` sources",
    );
  });

  it("rejects owner-only filters on a repo source", () => {
    expect(errorOf("sources:\n  - repo: a/b\n    exclude: [x]\nsince: 2025-10-01\n")).toContain(
      "only apply to `owner` and `ado` sources",
    );
  });

  it("rejects unknown keys rather than ignoring them", () => {
    expect(errorOf("sources:\n  - owner: a\nsince: 2025-10-01\nteamz: {}\n")).toMatch(/teamz/);
  });

  it("reads the sync schedule, the stale window and people views, refusing nonsense", () => {
    const base = "sources:\n  - owner: acme\nsince: 2025-10-01\n";
    const config = parseConfig(
      `${base}sync_every: 6h\nstale_after_days: 30\npeople_views: false\n`,
    );
    expect(config).toMatchObject({ sync_every: "6h", stale_after_days: 30, people_views: false });
    expect(everyMs("6h")).toBe(6 * 3_600_000);
    expect(everyMs("off")).toBe(Number.POSITIVE_INFINITY);
    expect(() => parseConfig(`${base}sync_every: daily\n`)).toThrow(/like 24h, 6h/);
    expect(() => parseConfig(`${base}sync_every: 5m\n`)).toThrow(/15m or longer/);
    expect(() => parseConfig(`${base}stale_after_days: 0\n`)).toThrow(/stale_after_days/);
  });

  it("rejects impossible dates", () => {
    expect(errorOf("sources:\n  - owner: a\nsince: 2025-02-30\n")).toContain("since:");
  });

  it("reports YAML syntax errors with the file name", () => {
    expect(errorOf("sources: [\n")).toMatch(/^codeflow\.yml: /);
  });
});
