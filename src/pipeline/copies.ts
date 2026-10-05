// Local copies of repos (decision D46): which repos an org keeps one of, where, how each is
// reached, and line churn measured from them after each sync. A copy is opt-in per repo
// (`local_copies` in org.yml, or Setup › Repos › Local copies).
import { dirname, join } from "node:path";
import picomatch from "picomatch";
import type { Config } from "../config/schema.ts";
import type { Org } from "../config/workspace.ts";
import { copyPath, copyStatus, removeCopy, rewrittenLines } from "../providers/git/git.ts";
import type { Store, StoredRepo } from "../store/store.ts";
import { measuredBranches, normalize, rulesFor } from "./derive.ts";

/** Where an org's copies live: beside its database, one bare clone per repo. */
export const copiesRoot = (org: Pick<Org, "dbPath">) => join(dirname(org.dbPath), "git");

/** A repo's copy folder. */
export const copyOf = (org: Pick<Org, "dbPath">, repoId: string) =>
  copyPath(copiesRoot(org), repoId);

/** Whether the org keeps a copy of this repo. */
export function wantsCopy(config: Pick<Config, "local_copies">, fullName: string): boolean {
  return (
    config.local_copies.length > 0 &&
    picomatch(config.local_copies, { nocase: true, dot: true })(fullName)
  );
}

/** Where git fetches a GitHub repo from: github.com, or an Enterprise Server's own host. */
export function githubCloneUrl(apiUrl: string, fullName: string): string {
  const api = new URL(apiUrl);
  const host =
    api.hostname === "api.github.com"
      ? `${api.protocol}//github.com`
      : `${api.protocol}//${api.host}${api.pathname.replace(/\/api\/v3\/?$/, "")}`;
  return `${host.replace(/\/+$/, "")}/${fullName}.git`;
}

/** Where git fetches an Azure DevOps repo from: its organization's address, project and name. */
export function adoCloneUrl(organizationBase: string, project: string, name: string): string {
  return `${organizationBase}/${encodeURIComponent(project)}/_git/${encodeURIComponent(name)}`;
}

/**
 * Measures line churn for the repo's merged PRs old enough to tell and not measured yet for the
 * org's window. Each is stored, a few at a time, so a stop keeps what was done. Returns how many
 * were measured.
 */
export async function measureLineChurn(options: {
  store: Store;
  repo: StoredRepo;
  config: Config;
  dir: string;
  asOf: Date;
  signal?: AbortSignal;
  onProgress?: (done: number) => void;
}): Promise<number> {
  const { store, repo, config, dir } = options;
  const days = config.churn_window_days;
  const known = store.lineChurn(repo.id, days);
  const rules = rulesFor(config, repo.fullName, measuredBranches(config, repo));
  const due: { id: string; model: ReturnType<typeof normalize> }[] = [];
  for (const version of store.latestPrs(repo.id)) {
    if (known.has(version.id)) continue;
    const model = normalize(repo, version.payload, version.updatedAt);
    if (model.state !== "merged" || !model.mergedAt || !model.mergeCommitSha) continue;
    if (options.asOf.getTime() - Date.parse(model.mergedAt) < days * 86_400_000) continue;
    due.push({ id: version.id, model });
  }
  let done = 0;
  let batch: { prId: string; added: number | null; rewritten: number | null }[] = [];
  for (const { id, model } of due) {
    if (options.signal?.aborted) break;
    const measured = await rewrittenLines(dir, {
      mergeCommit: model.mergeCommitSha ?? "",
      prCommitSubjects: model.commits.map((c) => c.message.split("\n")[0] ?? ""),
      branch: model.baseBranch,
      mergedAt: model.mergedAt ?? "",
      days,
      counts: (path) => rules.classify(repo.fullName, path) === "product",
    }).catch(() => null);
    batch.push({
      prId: id,
      added: measured?.added ?? null,
      rewritten: measured?.rewritten ?? null,
    });
    done += 1;
    if (batch.length === 20) {
      store.saveLineChurn(repo.id, days, batch);
      batch = [];
      options.onProgress?.(done);
    }
  }
  store.saveLineChurn(repo.id, days, batch);
  return done;
}

/** Each synced repo: whether the org wants a copy of it, and the copy's size and freshness. */
export type CopyRow = {
  repo: string;
  wanted: boolean;
  /** Null when there is no copy yet (or any more). */
  bytes: number | null;
  fetchedAt: string | null;
};

export async function copyStatuses(org: Org, store: Store): Promise<CopyRow[]> {
  const rows: CopyRow[] = [];
  for (const repo of store.repos()) {
    const status = await copyStatus(copyOf(org, repo.id));
    const wanted = wantsCopy(org.config, repo.fullName);
    if (!wanted && !status) continue;
    rows.push({
      repo: repo.fullName,
      wanted,
      bytes: status?.bytes ?? null,
      fetchedAt: status?.fetchedAt ?? null,
    });
  }
  return rows;
}

/** Deletes the copies of repos the org no longer keeps one of. Returns their names. */
export async function removeUnwantedCopies(org: Org, store: Store): Promise<string[]> {
  const removed: string[] = [];
  for (const repo of store.repos()) {
    if (wantsCopy(org.config, repo.fullName)) continue;
    const dir = copyOf(org, repo.id);
    if (await copyStatus(dir)) {
      await removeCopy(dir);
      removed.push(repo.fullName);
    }
  }
  return removed;
}
