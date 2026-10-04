import { existsSync, statSync } from "node:fs";
import { relative } from "node:path";
import type { Org } from "../config/workspace.ts";
import { deriveFacts } from "../pipeline/derive.ts";
import { Store } from "../store/store.ts";
import { branchWarnings } from "./branches.ts";
import { durationSeconds, type Mark, num, plural, status, table } from "./format.ts";
import { type OrgOptions, orgHeading, orgsFor, type Print } from "./session.ts";

export type StatusOptions = OrgOptions;

/** What is stored locally and how the last sync went, per org. Local only: no network. */
export async function showStatus(options: StatusOptions): Promise<number> {
  const print: Print = (line = "") => console.log(line);
  const { workspace, orgs } = await orgsFor(options);
  let code = 0;
  for (const [i, org] of orgs.entries()) {
    if (i > 0) print();
    orgHeading(workspace, org, print);
    code = Math.max(code, orgStatus(org, print));
  }
  return code;
}

function orgStatus(org: Org, print: Print): number {
  const { config, dbPath } = org;
  if (!existsSync(dbPath)) {
    print(status("warn", "Data", "nothing synced yet. Run: codeflow sync"));
    return 1;
  }

  const store = Store.open(dbPath);
  try {
    const megabytes = statSync(dbPath).size / 1024 / 1024;
    print(status("ok", "Data", `${relative(process.cwd(), dbPath)} (${megabytes.toFixed(1)} MB)`));

    const run = store.lastRun("sync");
    const running = run?.status === "running" && store.lockHolder("sync") !== undefined;
    if (run) {
      const outcome = running
        ? "running now"
        : run.status === "running"
          ? "did not finish"
          : run.status;
      const mark: Mark = run.status === "ok" || running ? "ok" : "warn";
      const took = run.finishedAt
        ? `, took ${durationSeconds((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000)}`
        : "";
      print(
        status(
          mark,
          "Last sync",
          `${outcome}, started ${when(run.startedAt)}${took}, ` +
            `${plural(run.calls, "call")}, ${plural(run.points, "point")}`,
        ),
      );
    }

    const repos = store.repoSummaries();
    const total = repos.reduce((sum, repo) => sum + repo.prs, 0);
    print(status("ok", "PRs", `${num(total)} stored from ${plural(repos.length, "repo")}`));
    print();
    print(
      table(
        ["repo", "PRs", "open", "merged", "closed", "versions", "current to", "backfilled to"],
        repos.map((repo) => [
          repo.fullName,
          num(repo.prs),
          num(repo.open),
          num(repo.merged),
          num(repo.closed),
          num(repo.versions),
          repo.watermark ? when(repo.watermark) : "-",
          repo.coveredSince ?? "in progress",
        ]),
        { rightAlign: [1, 2, 3, 4, 5], indent: "  " },
      ),
    );

    const notes: string[] = [];
    for (const repo of repos) {
      if (repo.branchChanges > 0) {
        notes.push(
          status(
            "warn",
            "Branch",
            `${repo.fullName}: default branch changed, now ${repo.defaultBranch}`,
          ),
        );
      }
      if (repo.coveredSince === null && !running) {
        notes.push(
          status("warn", "Backfill", `${repo.fullName}: unfinished; the next sync resumes it`),
        );
      }
    }
    deriveFacts(store, config);
    notes.push(...branchWarnings(store, org));
    if (notes.length > 0) print();
    for (const note of notes) print(note);
    return 0;
  } finally {
    store.close();
  }
}

const when = (iso: string) =>
  new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
