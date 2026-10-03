import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { formatIssues } from "../config/load.ts";
import { asRule, RulesFileSchema } from "../config/schema.ts";
import type { PrFact } from "../core/facts.ts";
import { ruleImpact } from "../core/preview.ts";
import { contextOf, type Rule, ruleProblems } from "../core/rules.ts";
import { CodeflowError } from "../errors.ts";
import { deriveFacts, deriveWith, rulesOf } from "../pipeline/derive.ts";
import { Store } from "../store/store.ts";
import { bold, dim, num, plural, status, table } from "./format.ts";
import { type OrgOptions, orgsFor, type Print } from "./session.ts";

export type RulesOptions = OrgOptions;

/** Every rule an org has, where it came from, and how many PRs it applies to. Local only. */
export async function listRules(options: RulesOptions): Promise<number> {
  const print: Print = (line = "") => console.log(line);
  const {
    orgs: [org],
  } = await orgsFor(options, true);
  if (!org) throw new CodeflowError("No org to read.");
  const rules = rulesOf(org.config);
  const facts = existsSync(org.dbPath) ? derived(org.dbPath, org.config) : [];
  const applied = ruleImpact([], facts).applied;

  print(
    status(
      "ok",
      "Rules",
      `${plural(rules.length, "rule")} for ${org.name}, in the order they apply`,
    ),
  );
  print();
  print(
    table(
      ["rule", "from", "applies to", "where", "when", "then", "PRs"],
      rules.map((rule) => [
        rule.enabled ? rule.id : dim(`${rule.id} (off)`),
        rule.source,
        contextOf(rule) ?? "?",
        describe(rule.scope) || "the whole org",
        describe(rule.when),
        describe(rule.effects),
        contextOf(rule) === "pr" ? num(applied[rule.id] ?? 0) : "",
      ]),
      { rightAlign: [6], indent: "  " },
    ),
  );
  print();
  print(
    dim(
      "Each effect is decided on its own: a more specific scope (person, repo, team, group, " +
        "then org) wins, and among equals the later rule.",
    ),
  );
  return 0;
}

export type RulesTestOptions = OrgOptions & { limit?: string };

/**
 * What the rules in a file would change, compared with the org's rules now: PRs that would stop
 * or start counting, and authors who would count as internal or external. Writes nothing.
 */
export async function testRules(file: string, options: RulesTestOptions): Promise<number> {
  const print: Print = (line = "") => console.log(line);
  const {
    orgs: [org],
  } = await orgsFor(options, true);
  if (!org) throw new CodeflowError("No org to read.");
  if (!existsSync(org.dbPath)) throw new CodeflowError("Nothing synced yet. Run: codeflow sync");

  const doc = parseDocument(await readFile(file, "utf8"));
  const [yamlError] = doc.errors;
  if (yamlError) throw new CodeflowError(`${file}: ${yamlError.message}`);
  // The draft replaces the org's rules.yml; everything else stays as it is.
  const parsed = RulesFileSchema.safeParse(doc.toJS() ?? {});
  if (!parsed.success) {
    throw new CodeflowError(`${file} is not valid:\n${formatIssues(parsed.error.issues)}`);
  }
  const { config } = org;
  const problems = ruleProblems(
    parsed.data.rules.map((rule) => asRule(rule, file)),
    {
      teams: Object.keys(config.teams),
      groups: [...Object.keys(config.groups), ...Object.keys(config.products)],
    },
  );
  if (problems.length > 0)
    throw new CodeflowError(`${file} is not valid:\n  ${problems.join("\n  ")}`);
  const candidate = { ...config, rules: parsed.data.rules };

  const store = Store.open(org.dbPath);
  let before: PrFact[];
  let after: PrFact[];
  try {
    deriveFacts(store, org.config);
    before = store.facts();
    after = deriveWith(store, candidate);
  } finally {
    store.close();
  }
  const impact = ruleImpact(before, after);
  const limit = Number(options.limit ?? 10);
  const list = (
    title: string,
    changes: typeof impact.leftOut,
    why: (c: (typeof changes)[number]) => string,
  ) => {
    if (changes.length === 0) return;
    print(bold(`${title}: ${plural(changes.length, "PR")}`));
    for (const change of changes.slice(0, limit)) {
      print(`  ${change.repo}#${change.number}  ${change.title.slice(0, 60)}  ${dim(why(change))}`);
    }
    if (changes.length > limit) print(dim(`  and ${num(changes.length - limit)} more`));
    print();
  };
  print(status("ok", "Preview", `${file} in place of ${org.name}'s rules.yml; nothing is saved`));
  print();
  list("Would stop counting", impact.leftOut, (c) => (c.rule ? `rule ${c.rule}` : (c.after ?? "")));
  list("Would start counting", impact.broughtIn, (c) => `was left out: ${c.before}`);
  list("Author would count as internal", impact.internal, () => "");
  list("Author would count as external", impact.external, () => "");
  const changes =
    impact.leftOut.length +
    impact.broughtIn.length +
    impact.internal.length +
    impact.external.length;
  if (changes === 0) print("No PR would be counted differently.");
  return 0;
}

function derived(dbPath: string, config: Parameters<typeof deriveFacts>[1]): PrFact[] {
  const store = Store.open(dbPath);
  try {
    deriveFacts(store, config);
    return store.facts();
  } finally {
    store.close();
  }
}

/** A rule's scope, conditions or effects in a line: "teams Payments · labels chore". */
function describe(fields: object): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => {
      const shown = Array.isArray(value)
        ? value
            .map((v) => (typeof v === "object" ? `${v.bucket}: ${v.match.join(" ")}` : v))
            .join(", ")
        : String(value);
      return `${key.replaceAll("_", " ")} ${shown}`;
    })
    .join(" · ");
}

export type { Rule };
