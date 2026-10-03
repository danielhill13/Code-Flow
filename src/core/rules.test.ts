import { describe, expect, it } from "vitest";
import type { Groups } from "./groups.ts";
import { type PrContext, type Rule, RuleEngine, ruleProblems } from "./rules.ts";

const groups: Groups = {
  people: [{ key: "ana", name: null, github: ["ana", "ana-old"], internal: null, bot: null }],
  teams: [],
  groups: [],
};

let next = 0;
const rule = (fields: Partial<Rule> & Pick<Rule, "effects">): Rule => ({
  id: `r${++next}`,
  description: null,
  enabled: true,
  scope: {},
  when: {},
  source: "rules.yml",
  ...fields,
});

const pr = (overrides: Partial<PrContext> = {}): PrContext => ({
  repo: "acme/api",
  person: "ana",
  team: "Payments",
  groups: ["Checkout", "No area"],
  labels: ["chore"],
  title: "chore: bump deps",
  base: "main",
  head: "deps/bump",
  authorAssociation: "MEMBER",
  fromFork: false,
  draft: false,
  authorBot: false,
  ...overrides,
});

const counts = (rules: Rule[], ctx = pr()) => new RuleEngine(rules, groups).pr(ctx).count;

describe("scopes", () => {
  it("applies an org rule everywhere, and a scoped one only where every field matches", () => {
    expect(counts([rule({ effects: { count: false } })])).toBe(false);
    expect(counts([rule({ scope: { repos: ["ACME/*"] }, effects: { count: false } })])).toBe(false);
    expect(counts([rule({ scope: { repos: ["other/*"] }, effects: { count: false } })])).toBeNull();
    expect(counts([rule({ scope: { teams: ["Payments"] }, effects: { count: false } })])).toBe(
      false,
    );
    expect(
      counts([rule({ scope: { teams: ["Platform"] }, effects: { count: false } })]),
    ).toBeNull();
    expect(counts([rule({ scope: { groups: ["Checkout"] }, effects: { count: false } })])).toBe(
      false,
    );
    expect(
      counts([
        rule({ scope: { teams: ["Payments"], repos: ["other/x"] }, effects: { count: false } }),
      ]),
    ).toBeNull();
  });

  it("matches a person by any of their logins", () => {
    expect(counts([rule({ scope: { people: ["ana-old"] }, effects: { count: false } })])).toBe(
      false,
    );
    expect(counts([rule({ scope: { people: ["bob"] }, effects: { count: false } })])).toBeNull();
  });
});

describe("conditions", () => {
  it("needs every condition given, and any value within one", () => {
    const when = (w: Rule["when"], ctx = pr()) =>
      counts([rule({ when: w, effects: { count: false } })], ctx);
    expect(when({ labels: ["dependencies", "CHORE"] })).toBe(false);
    expect(when({ labels: ["feature"] })).toBeNull();
    expect(when({ title: "^chore" })).toBe(false);
    expect(when({ title: "^feat" })).toBeNull();
    expect(when({ base: ["release/*"] })).toBeNull();
    expect(when({ head: ["deps/*"] })).toBe(false);
    expect(when({ author_association: ["NONE"] })).toBeNull();
    expect(when({ from_fork: true })).toBeNull();
    expect(when({ draft: false, author_bot: false })).toBe(false);
    expect(when({ labels: ["chore"], title: "^feat" })).toBeNull();
  });
});

describe("precedence", () => {
  it("lets the more specific scope win, then the later rule", () => {
    const org = rule({ effects: { count: false } });
    const team = rule({ scope: { teams: ["Payments"] }, effects: { count: true } });
    const person = rule({ scope: { people: ["ana"] }, effects: { count: false } });
    expect(counts([team, org])).toBe(true);
    expect(counts([person, team, org])).toBe(false);
    expect(counts([rule({ effects: { count: false } }), rule({ effects: { count: true } })])).toBe(
      true,
    );
  });

  it("resolves each effect on its own, and skips disabled rules", () => {
    const engine = new RuleEngine(
      [
        rule({ id: "a", effects: { count: false, internal: true } }),
        rule({ id: "b", scope: { teams: ["Payments"] }, effects: { internal: false } }),
        rule({ id: "c", enabled: false, effects: { count: true } }),
      ],
      groups,
    );
    expect(engine.pr(pr())).toMatchObject({
      count: false,
      countRule: "a",
      internal: false,
      applied: ["a", "b"],
    });
  });

  it("collects comments to ignore from every rule that applies", () => {
    const engine = new RuleEngine(
      [
        rule({ effects: { ignore_comments: ["^thanks"] } }),
        rule({ effects: { ignore_comments: ["lgtm"] } }),
      ],
      groups,
    );
    expect(engine.pr(pr()).ignore.map((r) => r.source)).toEqual(["^thanks", "lgtm"]);
  });
});

describe("repo and people rules", () => {
  it("sets a repo's branches, and puts the most specific path rules first", () => {
    const engine = new RuleEngine(
      [
        rule({
          id: "org",
          effects: { promotion_branches: ["main"], paths: [{ match: ["a/**"], bucket: "test" }] },
        }),
        rule({
          id: "api",
          scope: { repos: ["acme/api"] },
          effects: { measured_branches: ["develop"], paths: [{ match: ["b/**"], bucket: "docs" }] },
        }),
      ],
      groups,
    );
    expect(engine.repo("acme/api")).toEqual({
      measuredBranches: ["develop"],
      promotionBranches: ["main"],
      paths: [
        { match: ["b/**"], bucket: "docs" },
        { match: ["a/**"], bucket: "test" },
      ],
      applied: ["org", "api"],
    });
    expect(engine.repo("acme/web").measuredBranches).toBeNull();
  });

  it("marks people as bots, and bots whose reviews count", () => {
    const engine = new RuleEngine(
      [
        rule({ id: "svc", scope: { people: ["deploy-svc"] }, effects: { bot: true } }),
        rule({
          id: "rabbit",
          scope: { people: ["coderabbitai"] },
          effects: { bot_reviews_count: true },
        }),
      ],
      groups,
    );
    expect(engine.person("deploy-svc")).toEqual({
      bot: true,
      botReviewsCount: null,
      applied: ["svc"],
    });
    expect(engine.person("CodeRabbitAI").botReviewsCount).toBe(true);
    expect(engine.person("ana").applied).toEqual([]);
  });
});

describe("ruleProblems", () => {
  const known = { teams: ["Payments"], groups: ["Checkout"] };
  it("accepts well-formed rules", () => {
    expect(
      ruleProblems(
        [
          rule({
            scope: { teams: ["Payments"] },
            when: { labels: ["chore"] },
            effects: { count: false },
          }),
          rule({ scope: { repos: ["acme/*"] }, effects: { measured_branches: ["main"] } }),
          rule({ scope: { people: ["svc"] }, effects: { bot: true } }),
        ],
        known,
      ),
    ).toEqual([]);
  });

  it("explains each kind of mistake", () => {
    const problems = ruleProblems(
      [
        rule({ id: "same", effects: { count: false } }),
        rule({ id: "same", effects: { count: true } }),
        rule({ id: "none", effects: {} }),
        rule({ id: "mixed", effects: { count: false, bot: true } }),
        rule({
          id: "repo-team",
          scope: { teams: ["Payments"] },
          effects: { measured_branches: ["x"] },
        }),
        rule({ id: "person-when", when: { draft: true }, effects: { bot: true } }),
        rule({
          id: "unknown",
          scope: { teams: ["Ghosts"], groups: ["Nope"] },
          effects: { count: false },
        }),
        rule({ id: "regex", when: { title: "(" }, effects: { count: false } }),
      ],
      known,
    );
    expect(problems).toEqual([
      expect.stringContaining("Rule same: another rule has this id"),
      expect.stringContaining("Rule none: give it an effect"),
      expect.stringContaining("Rule mixed: mixes count, bot"),
      expect.stringContaining("Rule repo-team: measured_branches apply to repos"),
      expect.stringContaining("Rule person-when: bot apply to people"),
      expect.stringContaining('Rule unknown: no team is called "Ghosts"'),
      expect.stringContaining('Rule unknown: no group is called "Nope"'),
      expect.stringContaining("Rule regex: /(/ isn't a valid regular expression"),
    ]);
  });
});
