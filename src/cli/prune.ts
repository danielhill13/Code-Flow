// `codeflow prune`: lists the repos an org has stored but no longer measures, and with --yes
// removes their data (decision D43). Local only: no network.
import { existsSync } from "node:fs";
import type { Org } from "../config/workspace.ts";
import { pruneRepos, unmeasuredRepos } from "../pipeline/prune.ts";
import { Store } from "../store/store.ts";
import { num, plural, status } from "./format.ts";
import { type OrgOptions, orgHeading, orgsFor, type Print } from "./session.ts";

export type PruneOptions = OrgOptions & { yes?: boolean };

export async function prune(options: PruneOptions): Promise<number> {
  const print: Print = (line = "") => console.log(line);
  const { workspace, orgs } = await orgsFor(options);
  for (const [i, org] of orgs.entries()) {
    if (i > 0) print();
    orgHeading(workspace, org, print);
    pruneOrg(org, options.yes === true, print);
  }
  return 0;
}

function pruneOrg(org: Org, yes: boolean, print: Print): void {
  if (!existsSync(org.dbPath)) {
    print(status("ok", "Data", "nothing stored yet"));
    return;
  }
  const store = Store.open(org.dbPath);
  try {
    const found = yes ? pruneRepos(store, org.config) : unmeasuredRepos(store, org.config);
    if (found.length === 0) {
      print(status("ok", "Repos", "every stored repo is one the sources measure"));
      return;
    }
    for (const repo of found) {
      print(`  ${yes ? "removed" : "not measured"}  ${repo.fullName}  (${num(repo.prs)} PRs)`);
    }
    print(
      yes
        ? status("ok", "Removed", `the data of ${plural(found.length, "repo")}`)
        : status(
            "warn",
            "Not measured",
            `${plural(found.length, "repo")} stored that no source selects. Remove their data: codeflow prune --yes --org ${org.name}`,
          ),
    );
  } finally {
    store.close();
  }
}
