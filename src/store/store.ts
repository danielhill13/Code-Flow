import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { PrFact } from "../core/facts.ts";
import { CodeflowError } from "../errors.ts";
import { migrate } from "./migrations.ts";
import { type Database, openDatabase, transaction } from "./sqlite.ts";

/** How far a repo's sync has got. providers/github/sync.ts explains each field. */
export type SyncState = {
  watermark: string | null;
  coveredSince: string | null;
  tailCursor: string | null;
  headCursor: string | null;
  headNewest: string | null;
  openSwept: boolean;
  sweepCursor: string | null;
};

export type RepoRecord = {
  id: string;
  provider: string;
  fullName: string;
  defaultBranch: string | null;
  archived: boolean;
  fork: boolean;
  private: boolean;
};

/** One version of one PR: the provider's payload plus the fields the store indexes. */
export type PrVersion = {
  id: string;
  number: number;
  state: string;
  updatedAt: string;
  payload: unknown;
};

export type RunStatus = "running" | "ok" | "failed" | "interrupted";

export type RunRecord = {
  id: number;
  command: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  calls: number;
  points: number;
  detail: unknown;
};

export type RepoSummary = {
  fullName: string;
  defaultBranch: string | null;
  branchChanges: number;
  prs: number;
  open: number;
  merged: number;
  closed: number;
  versions: number;
  watermark: string | null;
  coveredSince: string | null;
  openSwept: boolean;
};

export type LockOwner = { pid: number; host: string };

/** A repo as derive needs it. */
export type StoredRepo = {
  id: string;
  provider: string;
  fullName: string;
  defaultBranch: string | null;
  /** Every branch that has been the default since codeflow first saw the repo, oldest first. */
  defaultBranches: string[];
};

const STATE_COLUMNS = {
  watermark: "watermark",
  coveredSince: "covered_since",
  tailCursor: "tail_cursor",
  headCursor: "head_cursor",
  headNewest: "head_newest",
  openSwept: "open_swept",
  sweepCursor: "sweep_cursor",
} as const satisfies Record<keyof SyncState, string>;

/** Another machine's processes can't be checked, so its lock is trusted for this long. */
const REMOTE_LOCK_TTL_MS = 24 * 60 * 60 * 1000;

const thisProcess = (): LockOwner => ({ pid: process.pid, host: hostname() });

/** codeflow's local database: raw PR versions, repos and their sync state, runs, locks. */
export class Store {
  readonly path: string;
  readonly #db: Database;

  private constructor(db: Database, path: string) {
    this.#db = db;
    this.path = path;
  }

  static open(path: string): Store {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = openDatabase(path);
    try {
      migrate(db);
    } catch (err) {
      db.close();
      throw err;
    }
    return new Store(db, path);
  }

  close(): void {
    this.#db.close();
  }

  // Runs

  startRun(command: string, now = new Date()): number {
    const { lastInsertRowid } = this.#db
      .prepare("INSERT INTO runs (command, started_at, status) VALUES (?, ?, 'running')")
      .run(command, now.toISOString());
    return Number(lastInsertRowid);
  }

  finishRun(
    id: number,
    result: {
      status: Exclude<RunStatus, "running">;
      calls: number;
      points: number;
      detail?: unknown;
    },
    now = new Date(),
  ): void {
    this.#db
      .prepare(
        "UPDATE runs SET finished_at = ?, status = ?, calls = ?, points = ?, detail = ? WHERE id = ?",
      )
      .run(
        now.toISOString(),
        result.status,
        result.calls,
        result.points,
        JSON.stringify(result.detail ?? null),
        id,
      );
  }

  /**
   * Marks runs still `running` as interrupted: their process died without finishing them.
   * Call it while holding the command's lock, before starting a new run.
   */
  closeAbandonedRuns(command: string): number {
    const { changes } = this.#db
      .prepare("UPDATE runs SET status = 'interrupted' WHERE command = ? AND status = 'running'")
      .run(command);
    return Number(changes);
  }

  lastRun(command: string): RunRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM runs WHERE command = ? ORDER BY id DESC LIMIT 1")
      .get(command) as RunRow | undefined;
    return (
      row && {
        id: row.id,
        command: row.command,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        status: row.status,
        calls: row.calls,
        points: row.points,
        detail: row.detail === null ? null : JSON.parse(row.detail),
      }
    );
  }

  // Locks

  /** Takes the named lock, or throws if a live process holds it. A dead holder's lock is taken over. */
  acquireLock(name: string, owner: LockOwner = thisProcess(), now = new Date()): void {
    transaction(this.#db, () => {
      const held = this.#db
        .prepare("SELECT pid, host, acquired_at FROM locks WHERE name = ?")
        .get(name) as LockRow | undefined;
      if (held && isLive(held, now)) {
        throw new CodeflowError(
          `Another ${name} is running (pid ${held.pid} on ${held.host}, since ${held.acquired_at}).`,
        );
      }
      this.#db
        .prepare(
          `INSERT INTO locks (name, pid, host, acquired_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (name) DO UPDATE
           SET pid = excluded.pid, host = excluded.host, acquired_at = excluded.acquired_at`,
        )
        .run(name, owner.pid, owner.host, now.toISOString());
    });
  }

  /** Who holds the named lock, if that process is still alive. */
  lockHolder(name: string, now = new Date()): (LockOwner & { acquiredAt: string }) | undefined {
    const held = this.#db
      .prepare("SELECT pid, host, acquired_at FROM locks WHERE name = ?")
      .get(name) as LockRow | undefined;
    if (!held || !isLive(held, now)) return undefined;
    return { pid: held.pid, host: held.host, acquiredAt: held.acquired_at };
  }

  releaseLock(name: string, owner: LockOwner = thisProcess()): void {
    this.#db
      .prepare("DELETE FROM locks WHERE name = ? AND pid = ? AND host = ?")
      .run(name, owner.pid, owner.host);
  }

  // Repos

  /** Records what discovery saw of a repo, and returns its sync state. */
  upsertRepo(repo: RepoRecord, now = new Date()): SyncState {
    const at = now.toISOString();
    return transaction(this.#db, () => {
      const before = this.#db
        .prepare("SELECT default_branch FROM repos WHERE id = ?")
        .get(repo.id) as { default_branch: string | null } | undefined;
      this.#db
        .prepare(
          `INSERT INTO repos
             (id, provider, full_name, default_branch, archived, fork, private, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             full_name = excluded.full_name, default_branch = excluded.default_branch,
             archived = excluded.archived, fork = excluded.fork, private = excluded.private,
             last_seen_at = excluded.last_seen_at`,
        )
        .run(
          repo.id,
          repo.provider,
          repo.fullName,
          repo.defaultBranch,
          Number(repo.archived),
          Number(repo.fork),
          Number(repo.private),
          at,
          at,
        );
      if (!before || before.default_branch !== repo.defaultBranch) {
        this.#db
          .prepare("INSERT INTO default_branches (repo_id, branch, seen_at) VALUES (?, ?, ?)")
          .run(repo.id, repo.defaultBranch, at);
      }
      return this.syncState(repo.id);
    });
  }

  syncState(repoId: string): SyncState {
    const row = this.#db
      .prepare(
        `SELECT watermark, covered_since, tail_cursor, head_cursor, head_newest, open_swept, sweep_cursor
         FROM repos WHERE id = ?`,
      )
      .get(repoId) as SyncStateRow | undefined;
    if (!row) throw new Error(`unknown repo ${repoId}`);
    return {
      watermark: row.watermark,
      coveredSince: row.covered_since,
      tailCursor: row.tail_cursor,
      headCursor: row.head_cursor,
      headNewest: row.head_newest,
      openSwept: row.open_swept === 1,
      sweepCursor: row.sweep_cursor,
    };
  }

  /**
   * Stores a page of PR versions and moves the repo's sync state on, in one transaction, so an
   * interruption can never record progress for PRs that were not stored. Versions already
   * stored are skipped. Returns how many versions were new.
   */
  savePage(
    repoId: string,
    prs: readonly PrVersion[],
    runId: number,
    state: Partial<SyncState>,
    now = new Date(),
  ): number {
    const fetchedAt = now.toISOString();
    return transaction(this.#db, () => {
      const insert = this.#db.prepare(
        `INSERT INTO raw_prs (pr_id, updated_at, repo_id, number, state, fetched_at, run_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      );
      let added = 0;
      for (const pr of prs) {
        const payload = gzipSync(JSON.stringify(pr.payload));
        const { changes } = insert.run(
          pr.id,
          pr.updatedAt,
          repoId,
          pr.number,
          pr.state,
          fetchedAt,
          runId,
          payload,
        );
        added += Number(changes);
      }
      this.#setSyncState(repoId, state);
      return added;
    });
  }

  /**
   * The newest stored version of each PR, optionally for one repo, in no particular order.
   * Rows stream one at a time, so memory stays flat however many PRs there are.
   */
  *latestPrs(repoId?: string): Generator<PrVersion & { repoId: string }> {
    // Find each PR's newest version from the primary key alone, then read only those payloads.
    const rows = this.#db
      .prepare(
        `SELECT r.pr_id, r.repo_id, r.number, r.state, r.updated_at, r.payload
         FROM raw_prs r
         JOIN (SELECT pr_id, MAX(updated_at) AS updated_at FROM raw_prs GROUP BY pr_id) newest
           ON newest.pr_id = r.pr_id AND newest.updated_at = r.updated_at
         WHERE ? IS NULL OR r.repo_id = ?`,
      )
      .iterate(repoId ?? null, repoId ?? null) as Iterable<RawPrRow>;
    for (const row of rows) {
      yield {
        id: row.pr_id,
        repoId: row.repo_id,
        number: row.number,
        state: row.state,
        updatedAt: row.updated_at,
        payload: JSON.parse(gunzipSync(row.payload).toString("utf8")),
      };
    }
  }

  // Facts

  repos(): StoredRepo[] {
    const rows = this.#db
      .prepare("SELECT id, provider, full_name, default_branch FROM repos ORDER BY full_name")
      .all() as {
      id: string;
      provider: string;
      full_name: string;
      default_branch: string | null;
    }[];
    const history = this.#db.prepare(
      "SELECT branch FROM default_branches WHERE repo_id = ? AND branch IS NOT NULL ORDER BY seen_at",
    );
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      fullName: row.full_name,
      defaultBranch: row.default_branch,
      defaultBranches: (history.all(row.id) as { branch: string }[]).map((r) => r.branch),
    }));
  }

  /** Changes whenever a PR version is added to the repo, since raw rows are only ever inserted. */
  rawFingerprint(repoId: string): string {
    const row = this.#db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS last FROM raw_prs WHERE repo_id = ?",
      )
      .get(repoId) as { n: number; last: number };
    return `${row.n}:${row.last}`;
  }

  /** The fingerprint a repo's current facts were derived from, if they have been. */
  derivedInputs(repoId: string): string | undefined {
    const row = this.#db.prepare("SELECT inputs FROM derivations WHERE repo_id = ?").get(repoId) as
      | { inputs: string }
      | undefined;
    return row?.inputs;
  }

  /** Replaces a repo's facts and records what they came from, in one transaction. */
  replaceFacts(repoId: string, facts: readonly PrFact[], inputs: string, now = new Date()): void {
    transaction(this.#db, () => {
      this.#db.prepare("DELETE FROM pr_facts WHERE repo_id = ?").run(repoId);
      const insert = this.#db.prepare(
        "INSERT INTO pr_facts (pr_id, repo_id, fact) VALUES (?, ?, ?)",
      );
      for (const fact of facts) insert.run(fact.id, repoId, JSON.stringify(fact));
      this.#db
        .prepare(
          `INSERT INTO derivations (repo_id, inputs, derived_at) VALUES (?, ?, ?)
           ON CONFLICT (repo_id) DO UPDATE SET inputs = excluded.inputs, derived_at = excluded.derived_at`,
        )
        .run(repoId, inputs, now.toISOString());
    });
  }

  /** Every PR's facts, optionally for one repo. */
  facts(repoId?: string): PrFact[] {
    const rows = this.#db
      .prepare("SELECT fact FROM pr_facts WHERE ? IS NULL OR repo_id = ?")
      .all(repoId ?? null, repoId ?? null) as { fact: string }[];
    return rows.map((row) => JSON.parse(row.fact) as PrFact);
  }

  /**
   * When the data was last known complete: the start of the newest sync that finished without
   * errors. Anything that happened on GitHub after that may not be stored yet.
   */
  dataThrough(): string | null {
    const row = this.#db
      .prepare(
        "SELECT started_at FROM runs WHERE command = 'sync' AND status = 'ok' ORDER BY id DESC LIMIT 1",
      )
      .get() as { started_at: string } | undefined;
    return row?.started_at ?? null;
  }

  repoSummaries(): RepoSummary[] {
    const rows = this.#db
      .prepare(
        `SELECT r.full_name, r.default_branch, r.watermark, r.covered_since, r.open_swept,
           (SELECT COUNT(*) - 1 FROM default_branches b WHERE b.repo_id = r.id) AS branch_changes,
           (SELECT COUNT(*) FROM raw_prs v WHERE v.repo_id = r.id) AS versions,
           COALESCE(l.prs, 0) AS prs, COALESCE(l.open, 0) AS open,
           COALESCE(l.merged, 0) AS merged, COALESCE(l.closed, 0) AS closed
         FROM repos r
         LEFT JOIN (
           SELECT repo_id, COUNT(*) AS prs, SUM(state = 'OPEN') AS open,
             SUM(state = 'MERGED') AS merged, SUM(state = 'CLOSED') AS closed
           FROM (
             SELECT repo_id, state,
               ROW_NUMBER() OVER (PARTITION BY pr_id ORDER BY updated_at DESC) AS n
             FROM raw_prs
           ) WHERE n = 1 GROUP BY repo_id
         ) l ON l.repo_id = r.id
         ORDER BY prs DESC, r.full_name`,
      )
      .all() as unknown as SummaryRow[];
    return rows.map((row) => ({
      fullName: row.full_name,
      defaultBranch: row.default_branch,
      branchChanges: row.branch_changes,
      prs: row.prs,
      open: row.open,
      merged: row.merged,
      closed: row.closed,
      versions: row.versions,
      watermark: row.watermark,
      coveredSince: row.covered_since,
      openSwept: row.open_swept === 1,
    }));
  }

  #setSyncState(repoId: string, patch: Partial<SyncState>): void {
    const entries = Object.entries(patch) as [keyof SyncState, SyncState[keyof SyncState]][];
    if (entries.length === 0) return;
    const assignments = entries.map(([key]) => `${STATE_COLUMNS[key]} = ?`).join(", ");
    const values = entries.map(([, value]) => (typeof value === "boolean" ? Number(value) : value));
    this.#db.prepare(`UPDATE repos SET ${assignments} WHERE id = ?`).run(...values, repoId);
  }
}

function isLive(lock: LockRow, now: Date): boolean {
  if (lock.host !== hostname()) {
    return now.getTime() - Date.parse(lock.acquired_at) < REMOTE_LOCK_TTL_MS;
  }
  try {
    process.kill(lock.pid, 0); // signal 0 checks the process exists without touching it
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, but isn't ours
  }
}

type LockRow = { pid: number; host: string; acquired_at: string };

type RunRow = {
  id: number;
  command: string;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  calls: number;
  points: number;
  detail: string | null;
};

type SyncStateRow = {
  watermark: string | null;
  covered_since: string | null;
  tail_cursor: string | null;
  head_cursor: string | null;
  head_newest: string | null;
  open_swept: number;
  sweep_cursor: string | null;
};

type RawPrRow = {
  pr_id: string;
  repo_id: string;
  number: number;
  state: string;
  updated_at: string;
  payload: Uint8Array;
};

type SummaryRow = {
  full_name: string;
  default_branch: string | null;
  watermark: string | null;
  covered_since: string | null;
  open_swept: number;
  branch_changes: number;
  versions: number;
  prs: number;
  open: number;
  merged: number;
  closed: number;
};
