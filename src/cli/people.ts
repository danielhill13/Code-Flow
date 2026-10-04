// `codeflow people`: the accounts an org's PRs show, on GitHub and Azure DevOps, which look like
// one person, and merging them into one (decision D42). The web app's Setup › People does the
// same; both write people.yml through the import checks.
import { existsSync } from "node:fs";
import {
  applyImport,
  type Bundle,
  describeChanges,
  planImport,
  readRaw,
} from "../config/bundle.ts";
import { BUNDLE_VERSION } from "../config/schema.ts";
import type { Org } from "../config/workspace.ts";
import {
  type Identity,
  identitiesOf,
  mergePeople,
  type PersonRaw,
  suggestMerges,
} from "../core/identities.ts";
import { CodeflowError } from "../errors.ts";
import { deriveFacts } from "../pipeline/derive.ts";
import { Store } from "../store/store.ts";
import { bold, dim, num, status, table } from "./format.ts";
import { type OrgOptions, orgsFor } from "./session.ts";

export type PeopleOptions = OrgOptions & { all?: boolean };
export type MergeOptions = OrgOptions & { as?: string; name?: string; dryRun?: boolean };

const HOST = { github: "GitHub", ado: "Azure DevOps" } as const;

/** The org's accounts and people, as the synced PRs and people.yml say. */
async function accounts(
  org: Org,
): Promise<{ identities: Identity[]; people: Record<string, PersonRaw> }> {
  const people = ((await readRaw(org)).people ?? {}) as Record<string, PersonRaw>;
  if (!existsSync(org.dbPath)) throw new CodeflowError("Nothing synced yet. Run: codeflow sync");
  const store = Store.open(org.dbPath);
  try {
    deriveFacts(store, org.config);
    const hosts = new Map(store.repos().map((repo) => [repo.id, repo.provider]));
    const identities = identitiesOf(
      store.facts(),
      (repoId) => (hosts.get(repoId) === "ado" ? "ado" : "github"),
      people,
    );
    return { identities, people };
  } finally {
    store.close();
  }
}

export async function listPeople(options: PeopleOptions): Promise<number> {
  const {
    orgs: [org],
  } = await orgsFor(options, true);
  if (!org) throw new CodeflowError("No org to read.");
  const { identities } = await accounts(org);
  const suggestions = suggestMerges(identities);
  const shown = options.all ? identities : identities.filter((i) => i.person === null);
  const hosts = new Set(identities.map((i) => i.host));
  console.log(
    status(
      "ok",
      "Accounts",
      `${num(identities.length)} in ${org.name}'s PRs` +
        (hosts.size > 1 ? `, on GitHub and Azure DevOps` : "") +
        `; ${num(identities.filter((i) => i.person === null).length)} not in a person`,
    ),
  );
  if (shown.length > 0) {
    console.log(
      table(
        ["account", "host", "name", "opened", "took part", "person"],
        shown
          .slice(0, 50)
          .map((i) => [
            i.login,
            HOST[i.host],
            i.name ?? "",
            num(i.authored),
            num(i.involved),
            i.person ?? "",
          ]),
        { rightAlign: [3, 4], indent: "  " },
      ),
    );
    if (shown.length > 50) console.log(dim(`  and ${num(shown.length - 50)} more`));
  }
  if (suggestions.length > 0) {
    console.log();
    console.log(bold("Same person on GitHub and Azure DevOps?"));
    for (const s of suggestions) {
      const flag = s.ambiguous ? "; another account matches too" : "";
      console.log(
        `  ${s.github} and ${s.ado}  ${dim(`${s.strength === "strong" ? "likely" : "possibly"}: ${s.reason}${flag}`)}`,
      );
      console.log(
        dim(`    codeflow people merge ${s.github} ${s.ado}${s.person ? ` --as ${s.person}` : ""}`),
      );
    }
  }
  return 0;
}

/**
 * Merges accounts into one person in people.yml: an existing person (`--as`), or a new one named
 * for the GitHub login. Each account is taken to be on the host the PRs show it on; one the PRs
 * don't show is Azure DevOps when it looks like an address, else GitHub.
 */
export async function mergeAccounts(logins: string[], options: MergeOptions): Promise<number> {
  const {
    orgs: [org],
  } = await orgsFor(options, true);
  if (!org) throw new CodeflowError("No org to read.");
  if (logins.length < 1) throw new CodeflowError("Name the accounts to merge.");
  const { identities, people } = await accounts(org).catch(async () => ({
    identities: [] as Identity[],
    people: ((await readRaw(org)).people ?? {}) as Record<string, PersonRaw>,
  }));
  const hostOf = (login: string) =>
    identities.find((i) => i.login === login.toLowerCase())?.host ??
    (/[@\\]/.test(login) ? "ado" : "github");
  const github = logins.filter((l) => hostOf(l) === "github");
  const ado = logins.filter((l) => hostOf(l) === "ado");
  const owner = identities.find(
    (i) => logins.map((l) => l.toLowerCase()).includes(i.login) && i.person,
  )?.person;
  const key = options.as ?? owner ?? github[0] ?? "";
  if (!key) {
    throw new CodeflowError(
      "Say which person they become, with --as <key>: there's no GitHub login to name it.",
    );
  }
  const name =
    options.name ??
    identities.find((i) => ado.map((l) => l.toLowerCase()).includes(i.login) && i.name)?.name ??
    undefined;
  const next = mergePeople(people, { key, name, github, ado });
  const bundle = { codeflow: BUNDLE_VERSION, people: next } as Bundle;
  const plan = await planImport(org, bundle, ["people"], "replace");
  console.log(
    status(
      "ok",
      "Merge",
      `${logins.join(", ")} into ${key}${name ? ` (${name})` : ""}, in ${org.name}`,
    ),
  );
  for (const line of describeChanges(plan.changes)) console.log(`  ${line}`);
  if (options.dryRun) {
    console.log(dim("  Nothing written (--dry-run)."));
    return 0;
  }
  if (plan.changes.length > 0) await applyImport(org, plan);
  console.log(
    dim("  Saved to people.yml. The next summary, report or page uses it; no sync needed."),
  );
  return 0;
}
