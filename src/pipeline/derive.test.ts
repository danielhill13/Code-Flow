import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../config/load.ts";
import type { GhPayload } from "../providers/github/normalize.ts";
import { Store } from "../store/store.ts";
import { ghPayload } from "../testing/factories.ts";
import { deriveFacts, rulesOf } from "./derive.ts";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

/** A store with acme/api in it; `defaultBranches` replays the repo's history, oldest first. */
function setup(defaultBranches = ["main"]) {
  const store = Store.open(":memory:");
  stores.push(store);
  for (const [i, defaultBranch] of defaultBranches.entries()) {
    store.upsertRepo(
      {
        id: "R_1",
        provider: "github",
        fullName: "acme/api",
        defaultBranch,
        archived: false,
        fork: false,
        private: false,
      },
      new Date(Date.UTC(2026, 0, i + 1)),
    );
  }
  const run = store.startRun("sync");
  const save = (...payloads: GhPayload[]) =>
    store.savePage(
      "R_1",
      payloads.map((p) => ({
        id: p.id,
        number: p.number,
        state: p.state,
        updatedAt: p.updatedAt,
        payload: p,
      })),
      run,
      {},
    );
  const fact = (number: number) => store.facts().find((f) => f.number === number);
  return { store, save, fact };
}

const config = (yaml = "") =>
  parseConfig(`sources:\n  - repo: acme/api\nsince: 2025-10-01\n${yaml}`);
const bot = { __typename: "Bot", login: "dependabot" };

describe("deriveFacts", () => {
  it("derives every stored PR, then again only when something it depends on changes", () => {
    const { store, save } = setup();
    save(ghPayload({ id: "PR_1", number: 1 }), ghPayload({ id: "PR_2", number: 2, author: bot }));

    expect(deriveFacts(store, config())).toMatchObject({ repos: 1, derived: 1, prs: 2 });
    expect(deriveFacts(store, config())).toMatchObject({ derived: 0 });

    const withBots = config("bots:\n  include_prs: true\n");
    expect(deriveFacts(store, withBots)).toMatchObject({ derived: 1 });

    save(ghPayload({ id: "PR_3", number: 3 }));
    expect(deriveFacts(store, withBots)).toMatchObject({ derived: 1, prs: 3 });
    expect(store.facts().every((fact) => fact.counted)).toBe(true);
  });

  it("keeps counting PRs into a default branch that has since been renamed [rule 2]", () => {
    const { store, save, fact } = setup(["master", "main"]);
    save(ghPayload({ id: "PR_1", number: 1, baseRefName: "master" }));
    deriveFacts(store, config());
    expect(fact(1)?.counted).toBe(true);
  });

  it("measures the configured branches instead, when config names them", () => {
    const { store, save, fact } = setup();
    save(
      ghPayload({ id: "PR_1", number: 1 }),
      ghPayload({ id: "PR_2", number: 2, baseRefName: "develop" }),
    );
    deriveFacts(store, config('branches:\n  "acme/*": [develop]\n'));
    expect(fact(1)).toMatchObject({ counted: false, exclusion: "base" });
    expect(fact(2)?.counted).toBe(true);
  });

  it("links reverts across the repo's PRs", () => {
    const { store, save, fact } = setup();
    save(
      ghPayload({ id: "PR_10", number: 10, mergeCommit: { oid: "aaaa1111" } }),
      ghPayload({
        id: "PR_11",
        number: 11,
        body: "Reverts acme/api#10",
        mergeCommit: { oid: "bbbb2222" },
      }),
    );
    deriveFacts(store, config());
    expect(fact(10)?.revertedBy).toBe(11);
    expect(fact(11)?.reverts).toEqual([10]);
  });

  it("applies the org's rules: what counts, with the rule named, and who is a bot", () => {
    const { store, save, fact } = setup();
    save(
      ghPayload({ id: "PR_1", number: 1, labels: { nodes: [{ name: "chore" }] } }),
      ghPayload({ id: "PR_2", number: 2, author: { __typename: "User", login: "deploy-svc" } }),
      ghPayload({ id: "PR_3", number: 3 }),
    );
    deriveFacts(
      store,
      config(`
rules:
  - id: no-chores
    when: { labels: [chore] }
    then: { count: false }
  - id: deploy-account
    scope: { people: [deploy-svc] }
    then: { bot: true }
`),
    );
    expect(fact(1)).toMatchObject({ counted: false, exclusion: "rule", excludedBy: "no-chores" });
    expect(fact(2)).toMatchObject({ counted: false, exclusion: "bot", authorIsBot: true });
    expect(fact(3)).toMatchObject({ counted: true, rules: [] });
  });
});

describe("rulesOf", () => {
  it("turns today's config keys into rules, ahead of the org's own", () => {
    const rules = rulesOf(
      config(`
branches:
  "acme/*": [develop]
  acme/api: [main]
bots:
  accounts: [ci-helper]
  reviewers: [coderabbitai]
  include_prs: true
  ignore_bodies: ["^Thanks"]
paths:
  - { match: "e2e/**", bucket: test }
people:
  svc: { bot: true, internal: true }
rules:
  - id: mine
    then: { count: true }
`),
    );
    expect(rules.map((r) => [r.id, r.source])).toEqual([
      ["config:promotions", "promotions"],
      // The first matching pattern decides in `branches`, so it comes last among the rules.
      ["config:branches:acme/api", "branches"],
      ["config:branches:acme/*", "branches"],
      ["config:bots.accounts", "bots"],
      ["config:bots.reviewers", "bots"],
      ["config:bots.include_prs", "bots"],
      ["config:bots.ignore_bodies", "bots"],
      ["config:paths:1", "paths"],
      ["config:people:svc:bot", "people"],
      ["config:people:svc:internal", "people"],
      ["mine", "rules.yml"],
    ]);
  });
});
