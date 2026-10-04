// @vitest-environment happy-dom
/** @jsxImportSource preact */
// Every tab, at every scope, window, statistic and contributors filter, plus PR lists and the
// side panel: no view may show "undefined", "NaN", "Infinity" or "[object Object]" (roadmap,
// phase 3), and the numbers it shows are core's.
import { options, render } from "preact";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { measure } from "../core/aggregate.ts";
import type { PrFact } from "../core/facts.ts";
import { formatValue } from "../core/format.ts";
import {
  attribute,
  type Groups,
  type Member,
  NO_GROUPS,
  NO_TEAM,
  noGroup,
  personOf,
} from "../core/groups.ts";
import type { PrModel, Review } from "../core/model.ts";
import { parsePeriod } from "../core/periods.ts";
import { EVERYTHING, type Selection } from "../core/selection.ts";
import { EmbeddedSource, type ReportData } from "../core/source.ts";
import { at, bob, carol, deriveRules, prFact as fact } from "../testing/factories.ts";
import type { AdminApi, ConfigPart, PartValue } from "./admin/api.ts";
import { App } from "./app.tsx";
import { DEFAULT_STATE, type ReportState, TABS, writeState } from "./state.ts";

const asOf = "2026-10-03T00:12:08.928Z";
const people = ["ana", "devon", "mika", "visitor"];
const repos = ["acme/api", "acme/web", "acme/scripts"];

const groups: Groups = {
  people: [
    { key: "ana", name: "Ana Ruiz", github: ["ana", "ana-old"], internal: null, bot: null },
    { key: "visitor", name: null, github: ["visitor"], internal: false, bot: null },
  ],
  teams: [
    {
      name: "Platform",
      members: [member("ana"), member("devon", { to: "2026-08-15" })],
    },
    {
      name: "Web",
      members: [
        member("mika"),
        member("devon", { from: "2026-08-16" }),
        member("ana", { secondary: true }),
      ],
    },
  ],
  groups: [
    { name: "Core", kind: "product", repos: ["acme/api"], teams: [], people: [] },
    { name: "Site", kind: "product", repos: ["acme/web"], teams: ["Web"], people: [] },
    { name: "Mobile", kind: "area", repos: [], teams: [], people: ["mika", "visitor"] },
  ],
};

function member(login: string, extra: Partial<Member> = {}): Member {
  return { login, from: null, to: null, secondary: false, ...extra };
}

function facts(withGroups: Groups): PrFact[] {
  const rules = deriveRules({
    attribute: (pr) => attribute(withGroups, pr),
    personOf: (login) => personOf(withGroups, login),
  });
  const prFact = (overrides: Partial<PrModel>) => fact(overrides, rules);
  const out: PrFact[] = [];
  for (let i = 0; i < 90; i++) {
    const month = 7 + (i % 3);
    const day = 1 + ((i * 7) % 27);
    const pad = (n: number) => String(n).padStart(2, "0");
    const when = (d: number, h: number) => `${pad(month)}-${pad(Math.min(28, d))} ${pad(h)}:00`;
    const author = people[i % people.length] ?? "ana";
    const reviews: Review[] =
      i % 5 === 0
        ? []
        : [
            { author: i % 2 ? bob : carol, state: "commented", at: at(when(day + 1, 9)), body: "" },
            { author: bob, state: "approved", at: at(when(day + 2, 9)), body: "" },
          ];
    const base = {
      repo: repos[i % repos.length],
      author: { login: author, bot: false },
      authorAssociation: author === "visitor" ? "NONE" : "MEMBER",
      fromFork: author === "visitor",
      createdAt: at(when(day, 10)),
      commits: [
        {
          sha: `c${i}`,
          authoredAt: at(when(day, 8)),
          committedAt: at(when(day + 1, 12)),
          message: "x",
        },
      ],
      reviews,
      files: [{ path: "src/a.ts", additions: (i * 37) % 1200, deletions: i % 9 }],
    };
    if (i % 11 === 0) {
      out.push(
        prFact({
          ...base,
          state: "open",
          mergedAt: null,
          closedAt: null,
          mergedBy: null,
          draft: i % 2 === 0,
        }),
      );
    } else if (i % 13 === 0) {
      out.push(
        prFact({
          ...base,
          state: "closed",
          mergedAt: null,
          closedAt: at(when(day + 3, 10)),
          mergedBy: null,
        }),
      );
    } else {
      const merged = at(when(day + 3, 15));
      out.push(prFact({ ...base, mergedAt: merged, closedAt: merged, updatedAt: merged }));
    }
  }
  return out;
}

const withTeams: ReportData = {
  org: "acme",
  builtAt: asOf,
  asOf,
  coveredFrom: "2026-01-01",
  repos,
  groups,
  facts: facts(groups),
};
const withoutTeams: ReportData = { ...withTeams, groups: NO_GROUPS, facts: facts(NO_GROUPS) };

const BAD = /undefined|NaN|Infinity|\[object Object\]/;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
// Effects wait for an animation frame, which happy-dom spaces out: run them on the next tick.
options.requestAnimationFrame = (callback) => setTimeout(callback, 0);

/** Shows a view and waits until the page says it is that view, with its data loaded. */
async function show(state: Partial<ReportState>): Promise<string> {
  const hash = writeState({ ...DEFAULT_STATE, ...state });
  history.replaceState(null, "", hash);
  dispatchEvent(new HashChangeEvent("hashchange"));
  for (let i = 0; i < 200; i++) {
    const main = document.querySelector("main");
    if (main?.dataset.view === hash && main.dataset.ready === "true") {
      return document.body.textContent ?? "";
    }
    await tick();
  }
  throw new Error(`The report never showed ${hash}`);
}

describe.each([
  ["with teams", withTeams],
  ["without teams", withoutTeams],
])("the report, %s", (_, data) => {
  const root = document.createElement("div");
  beforeAll(async () => {
    document.body.append(root);
    render(<App source={new EmbeddedSource(data)} />, root);
    for (let i = 0; i < 4; i++) await tick();
  });
  afterAll(() => {
    render(null, root);
    root.remove();
  });

  const some = (selection: Partial<Selection>): Selection => ({ ...EVERYTHING, ...selection });
  const selections =
    data.groups.teams.length > 0
      ? [
          EVERYTHING,
          some({ team: ["Platform"] }),
          some({ team: ["Web"], repo: ["acme/web"] }),
          some({ team: [NO_TEAM] }),
          some({ group: ["Core"] }),
          some({ group: [noGroup("product")] }),
          some({ group: ["Site", "Mobile"] }),
          some({ group: ["Core", "Site"], team: ["Web"] }),
          some({ person: ["visitor"] }),
          some({ team: ["Platform", "Web"], person: ["ana", "mika"] }),
        ]
      : [EVERYTHING, some({ repo: ["acme/scripts"] }), some({ person: ["ana"] })];

  it("shows no broken values in any tab, scope, window, statistic or filter", async () => {
    for (const tab of TABS.map((t) => t.key).filter((t) => t !== "setup")) {
      for (const selection of selections) {
        for (const window of ["30d", "60d", "90d", "ytd"] as const) {
          for (const percentile of [0.5, 0.75]) {
            for (const contributors of ["all", "internal", "external"] as const) {
              const text = await show({ tab, selection, window, percentile, contributors });
              const where = JSON.stringify({ tab, selection, window, percentile, contributors });
              expect(text, where).not.toMatch(BAD);
              expect(text, where).not.toContain("Loading");
            }
          }
        }
      }
    }
  }, 30_000); // Hundreds of views: slower than one test is allowed by default.

  it("breaks down by each dimension the selection offers, with a row per value", async () => {
    if (data.groups.teams.length === 0) return;
    for (const tab of ["overview", "review"] as const) {
      for (const by of ["team", "group:product", "group:area", "repo"] as const) {
        const text = await show({ tab, by });
        expect(text, `${tab} by ${by}`).not.toMatch(BAD);
        const rows = {
          team: ["Platform", "Web", NO_TEAM],
          "group:product": ["Core", "Site", noGroup("product")],
          "group:area": ["Mobile", noGroup("area")],
          repo: repos,
        };
        for (const name of rows[by]) expect(text, `${tab} by ${by}`).toContain(name);
      }
    }
  });

  it("lists PRs by every set and opens each kind of PR in the side panel", async () => {
    for (const set of ["merged", "open", "abandoned"] as const) {
      const list = { ...DEFAULT_STATE.list, set };
      expect(await show({ tab: "prs", list })).not.toMatch(BAD);
    }
    for (const pr of data.facts.filter((_, i) => i % 6 === 0)) {
      const text = await show({ tab: "prs", pr: pr.id });
      expect(text, `#${pr.number}`).not.toMatch(BAD);
      expect(text).toContain("how codeflow read the pull request");
    }
  });

  it("always says when its data runs through, on every tab [rule 12]", async () => {
    for (const tab of TABS.map((t) => t.key).filter((t) => t !== "setup")) {
      expect(await show({ tab }), tab).toMatch(/Data through \w{3} \d{1,2}, 2026/);
    }
  });

  it("shows core's own numbers: Compare's months match summary's", async () => {
    const text = await show({
      tab: "compare",
      compare: { grain: "month", a: "2026-08", b: "2026-09" },
    });
    const september = parsePeriod("2026-09");
    if (!september) throw new Error("unreachable");
    const result = measure(data.facts, september, { asOf: new Date(asOf) });
    for (const key of ["merged", "cycle", "reviewed"]) {
      const value = result.values.find((v) => v.key === key);
      if (!value) throw new Error(key);
      expect(text).toContain(formatValue(value));
    }
  });
});

/** The setup of an org, held in memory as `codeflow serve` holds it in files. */
class FakeAdmin implements AdminApi {
  readonly org = "acme";
  readonly saved: { part: ConfigPart; value: PartValue }[] = [];
  readonly parts: Record<ConfigPart, { value: PartValue; version: number }> = {
    people: {
      value: {
        people: { ana: { name: "Ana Ruiz", github: ["ana", "ana-old"] }, svc: { bot: true } },
      },
      version: 1,
    },
    groups: {
      value: {
        teams: {
          Platform: { people: ["ana", { login: "devon", to: "2026-08-15" }] },
          Web: {
            people: [
              "mika",
              { login: "devon", from: "2026-08-16" },
              { login: "ana", secondary: true },
            ],
          },
        },
        groups: { Mobile: { kind: "area", people: ["mika", "visitor"] } },
        products: { Core: { repos: ["acme/api"] }, Site: { repos: ["acme/web"], teams: ["Web"] } },
      },
      version: 1,
    },
    settings: {
      value: {
        sources: [
          { owner: "acme", exclude: ["*-sandbox"] },
          { repo: "partner/sdk" },
          { ado: "contoso", project: "Platform" },
        ],
        since: "2026-01-01",
        github: {},
        azure_devops: {},
        branches: { "acme/legacy": ["main", "develop"] },
        promotions: ["main", "release/*"],
        bots: { accounts: ["deploy-svc"], reviewers: [], include_prs: false, ignore_bodies: [] },
        paths: [{ match: ["e2e/**"], bucket: "test" }],
        sync_every: "24h",
        stale_after_days: 90,
        people_views: true,
      },
      version: 1,
    },
    rules: {
      value: {
        rules: [
          {
            id: "no-chores",
            description: "Housekeeping",
            when: { labels: ["chore"] },
            then: { count: false },
          },
          {
            id: "legacy",
            scope: { repos: ["acme/scripts"] },
            then: { paths: [{ match: ["e2e/**"], bucket: "test" }] },
          },
          { id: "deploys", enabled: false, scope: { people: ["svc"] }, then: { bot: true } },
        ],
      },
      version: 1,
    },
  };

  async status() {
    return {
      every: "24h",
      lastSync: asOf,
      nextSync: new Date(Date.parse(asOf) + 86_400_000).toISOString(),
      running: false,
      queued: false,
      lastError: null,
      log: ["✓ acme/api: 3 PRs fetched"],
      progress: null,
    };
  }

  syncNow() {
    return this.status();
  }

  async repos() {
    return {
      repos: [
        { fullName: "acme/api", defaultBranch: "main", measured: ["main"] },
        { fullName: "acme/legacy", defaultBranch: "main", measured: ["main", "develop"] },
      ],
      advice: [],
    };
  }

  async remove() {}

  async checkGitHub() {
    return {
      ok: true as const,
      login: "tester",
      source: "$GITHUB_TOKEN",
      kind: "token",
      writeScopes: [],
      remaining: 4999,
      limit: 5000,
    };
  }

  async identities() {
    return {
      identities: [
        {
          login: "ana",
          host: "github" as const,
          name: "Ana Ruiz",
          authored: 12,
          involved: 30,
          lastSeen: asOf,
          person: "ana",
        },
        {
          login: "mika",
          host: "github" as const,
          name: null,
          authored: 8,
          involved: 20,
          lastSeen: asOf,
          person: null,
        },
        {
          login: "mika@acme.example",
          host: "ado" as const,
          name: "Mika Sato",
          authored: 5,
          involved: 9,
          lastSeen: asOf,
          person: null,
        },
      ],
      suggestions: [
        {
          github: "mika",
          ado: "mika@acme.example",
          reason: "the address's name is the login",
          strength: "strong" as const,
          person: null,
          ambiguous: false,
        },
      ],
    };
  }

  async checkAdo() {
    return {
      ok: true as const,
      who: "Tester",
      source: "$AZURE_DEVOPS_TOKEN",
      kind: "personal access token",
      organization: "contoso",
    };
  }

  async previewSources() {
    return {
      github: await this.checkGitHub(),
      sources: [
        {
          name: "acme",
          ownerType: "Organization",
          error: null,
          repos: [
            {
              fullName: "acme/api",
              defaultBranch: "main",
              archived: false,
              fork: false,
              prs: { open: 3, merged: 40, closed: 2 },
              lastPrActivity: asOf,
            },
          ],
          skipped: [{ repo: "acme/play-sandbox", reason: "excluded" }],
        },
      ],
      firstSync: { prs: 45, olderOpen: 0, seconds: 12, shareOfHour: 0.01 },
    };
  }

  async open(part: ConfigPart) {
    const { value, version } = this.parts[part];
    return { value: structuredClone(value), version: String(version) };
  }

  async save(part: ConfigPart, value: PartValue, version: string) {
    if (String(this.parts[part].version) !== version) throw new Error("changed meanwhile");
    this.parts[part] = { value, version: this.parts[part].version + 1 };
    this.saved.push({ part, value });
    return { version: String(this.parts[part].version), changes: [] };
  }

  async preview() {
    const examples = [{ id: "x", repo: "acme/api", number: 7, title: "chore: bump" }];
    const none = { count: 0, examples: [] };
    return {
      synced: true as const,
      leftOut: { count: 1, examples },
      broughtIn: none,
      internal: none,
      external: none,
      applied: { "no-chores": 1 },
    };
  }

  exportUrl(parts: string[], format: string) {
    return `/export?only=${parts.join(",")}&format=${format}`;
  }

  async importText() {
    return { changes: ["teams: added Data"], applied: false };
  }
}

/** Waits until the page's text passes the test, and returns it. */
async function until(test: (text: string) => boolean): Promise<string> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const text = document.body.textContent ?? "";
    if (test(text)) return text;
    await tick();
  }
  throw new Error(`The page never showed what was expected: ${document.body.textContent}`);
}

function press(label: string): void {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!button) throw new Error(`No button "${label}"`);
  button.click();
}

function type(field: Element | null | undefined, value: string, event = "input"): void {
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) {
    throw new Error("No such field");
  }
  field.value = value;
  field.dispatchEvent(new Event(event, { bubbles: true }));
}

describe("the report, served", () => {
  const root = document.createElement("div");
  const admin = new FakeAdmin();
  beforeAll(async () => {
    document.body.append(root);
    render(
      <App source={new EmbeddedSource(withTeams)} admin={admin} orgs={["acme", "beta"]} />,
      root,
    );
    for (let i = 0; i < 4; i++) await tick();
  });
  afterAll(() => {
    render(null, root);
    root.remove();
  });

  it("offers the other orgs, and a Setup tab", async () => {
    await show({ tab: "overview" });
    const picker = document.querySelector<HTMLSelectElement>(".org-picker");
    const options = [...(picker?.options ?? [])];
    expect(options.slice(0, 2).map((o) => o.value)).toEqual(["acme", "beta"]);
    expect(options.at(-1)?.textContent).toBe("Add an org…");
    expect(picker?.value).toBe("acme");
    expect(document.querySelector("nav.tabs")?.textContent).toContain("Setup");
  });

  it("shows every section of the setup without broken values", async () => {
    await show({ tab: "setup" });
    const sections = {
      Repos: ["GitHub: every repo", "GitHub: one repo", "Azure DevOps organization", "Project"],
      Branches: ["acme/legacy", "main, develop", "Promotion branches"],
      Bots: ["Also bots", "Bots whose reviews count", "Ignore comments matching"],
      Paths: ["Path rules", "Add a rule"],
      Sync: ["Last synced", "3 PRs fetched", "Sync now"],
      People: [
        "Ana Ruiz",
        "ana-old",
        "Same person on GitHub and Azure DevOps?",
        "mika@acme.example",
        "Accounts",
      ],
      Teams: ["Platform", "devon (… – 2026-08-15)", "ana (secondary)"],
      Groups: ["Mobile", "area", "Core", "product", "acme/api"],
      Rules: [
        "no-chores",
        "Housekeeping",
        "What counts",
        "Repo rules",
        "People rules",
        "test: e2e/**",
      ],
      "Import & export": ["Download", "Preview"],
    };
    for (const [section, expected] of Object.entries(sections)) {
      press(section);
      const text = await until((t) => expected.every((e) => t.includes(e)));
      expect(text, section).not.toMatch(BAD);
      expect(text, section).not.toContain("Loading");
    }
  });

  it("adds a team, writing it into the setup, and previews a rule as it's written", async () => {
    await show({ tab: "setup" });
    press("Teams");
    await until((t) => t.includes("Platform"));
    press("Add");
    await until((t) => t.includes("Add a team"));
    const form = document.querySelector("form");
    type(form?.querySelector("input"), "Data");
    type(form?.querySelector(".member-row input"), "zoe");
    await tick();
    press("Save");
    await until((t) => !t.includes("Add a team") && t.includes("Data"));
    expect(admin.parts.groups.value.teams).toMatchObject({ Data: { people: ["zoe"] } });
    expect(admin.parts.groups.value.products).toMatchObject({ Core: { repos: ["acme/api"] } });

    press("Rules");
    await until((t) => t.includes("no-chores"));
    press("Add");
    await until((t) => t.includes("Add a rule"));
    type(document.querySelector("form input"), "only-chores");
    const text = await until((t) => t.includes("With this rule saved"));
    expect(text).toContain("1 PRs would stop counting");
    expect(text).toContain("chore: bump");
    expect(text).not.toMatch(BAD);
    press("Cancel");
  });
});

describe("the report, served for an org not yet synced", () => {
  const root = document.createElement("div");
  const unsynced = new EmbeddedSource(withTeams);
  unsynced.meta = () => Promise.reject(new Error("Nothing synced yet for this org."));
  beforeAll(async () => {
    document.body.append(root);
    render(<App source={unsynced} admin={new FakeAdmin()} orgs={["acme"]} />, root);
  });
  afterAll(() => {
    render(null, root);
    root.remove();
  });

  it("offers only its setup", async () => {
    const text = await until(
      (t) => t.includes("Nothing synced yet") && t.includes("Sync now") && t.includes("Sources"),
    );
    expect(text).not.toMatch(BAD);
    expect(document.querySelector("nav.tabs")?.textContent).toBe("Setup");
  });
});

describe("the static report", () => {
  it("has no Setup tab, and reads a link to it as the overview", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    history.replaceState(null, "", "#tab=setup");
    render(<App source={new EmbeddedSource(withTeams)} />, root);
    await until((t) => t.includes("Are we getting faster or slower?"));
    expect(document.querySelector("nav.tabs")?.textContent).not.toContain("Setup");
    render(null, root);
    root.remove();
  });
});
