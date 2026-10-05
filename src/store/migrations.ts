import { CodeflowError } from "../errors.ts";
import { type Database, transaction } from "./sqlite.ts";

/** Schema versions, oldest first. Append only: never edit a migration that has shipped. */
const MIGRATIONS: readonly string[] = [
  /* 1: repos, raw PR versions, runs, locks */ `
  CREATE TABLE repos (
    id              TEXT PRIMARY KEY,    -- provider node id: survives renames and transfers
    provider        TEXT NOT NULL,
    full_name       TEXT NOT NULL,       -- as last seen
    default_branch  TEXT,                -- as last seen; history in default_branches
    archived        INTEGER NOT NULL,
    fork            INTEGER NOT NULL,
    private         INTEGER NOT NULL,
    first_seen_at   TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL,
    -- Sync coverage. providers/github/sync.ts explains each walk.
    watermark       TEXT,                -- PRs updated at or before this are stored at their current version
    covered_since   TEXT,                -- the backfill has reached this date
    tail_cursor     TEXT,                -- where the backfill stopped, to resume or extend it
    head_cursor     TEXT,                -- an unfinished update walk: where it stopped...
    head_newest     TEXT,                -- ...and the newest updatedAt it saw, the next watermark
    open_swept      INTEGER NOT NULL DEFAULT 0,  -- open PRs last updated before the backfill are stored
    sweep_cursor    TEXT
  ) STRICT;

  CREATE TABLE default_branches (
    repo_id  TEXT NOT NULL REFERENCES repos (id),
    branch   TEXT,                       -- null while a repo is empty
    seen_at  TEXT NOT NULL,              -- first time this branch was seen as the default
    PRIMARY KEY (repo_id, seen_at)
  ) STRICT;

  CREATE TABLE runs (
    id           INTEGER PRIMARY KEY,
    command      TEXT NOT NULL,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    status       TEXT NOT NULL,          -- running | ok | failed | interrupted
    calls        INTEGER NOT NULL DEFAULT 0,
    points       INTEGER NOT NULL DEFAULT 0,
    detail       TEXT                    -- JSON: per-repo results and errors
  ) STRICT;

  -- The system of record: every version of every PR, exactly as the provider returned it.
  -- Rows are only ever inserted.
  CREATE TABLE raw_prs (
    pr_id       TEXT NOT NULL,           -- provider node id
    updated_at  TEXT NOT NULL,           -- the PR's updatedAt in this version
    repo_id     TEXT NOT NULL REFERENCES repos (id),
    number      INTEGER NOT NULL,
    state       TEXT NOT NULL,
    fetched_at  TEXT NOT NULL,
    run_id      INTEGER NOT NULL REFERENCES runs (id),
    payload     BLOB NOT NULL,           -- gzipped JSON
    PRIMARY KEY (pr_id, updated_at)
  ) STRICT;
  CREATE INDEX raw_prs_by_repo ON raw_prs (repo_id, number);

  CREATE TABLE locks (
    name         TEXT PRIMARY KEY,
    pid          INTEGER NOT NULL,
    host         TEXT NOT NULL,
    acquired_at  TEXT NOT NULL
  ) STRICT;
  `,
  /* 2: facts derived from raw PRs */ `
  -- One row per PR: a pure function of its newest raw version, the config and derive's code.
  CREATE TABLE pr_facts (
    pr_id    TEXT PRIMARY KEY,
    repo_id  TEXT NOT NULL REFERENCES repos (id),
    fact     TEXT NOT NULL                   -- JSON, shaped like core/facts.ts PrFact
  ) STRICT;
  CREATE INDEX pr_facts_by_repo ON pr_facts (repo_id);

  -- What each repo's facts were derived from. When that changes, they are derived again.
  CREATE TABLE derivations (
    repo_id     TEXT PRIMARY KEY REFERENCES repos (id),
    inputs      TEXT NOT NULL,               -- fingerprint of raw data, config and code version
    derived_at  TEXT NOT NULL
  ) STRICT;
  `,
  // 2: line-level churn from local copies (decision D46). Measured from git, after the window
  // has passed, so it is kept apart from the PRs' raw versions; a row is per window length.
  `
  CREATE TABLE line_churn (
    pr_id        TEXT NOT NULL,
    repo_id      TEXT NOT NULL REFERENCES repos (id),
    window_days  INTEGER NOT NULL,
    added        INTEGER,                    -- product lines the PR added; null: git couldn't say
    rewritten    INTEGER,
    measured_at  TEXT NOT NULL,
    PRIMARY KEY (pr_id, window_days)
  ) STRICT;
  CREATE INDEX line_churn_by_repo ON line_churn (repo_id);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const current = row ? Number(row.value) : 0;
  if (current > MIGRATIONS.length) {
    throw new CodeflowError(
      `This database has schema ${current}, from a newer codeflow. Upgrade codeflow to use it.`,
    );
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version] ?? "");
      db.prepare(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      ).run(String(version + 1));
    });
  }
}
