import type { DatabaseSync } from "node:sqlite";

export type Database = DatabaseSync;

// node:sqlite still prints an ExperimentalWarning when it loads, which would show on every
// command. Drop exactly that warning, then load the module dynamically: a static import is
// loaded before any of our code runs, so the filter would come too late.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning).startsWith("SQLite is an experimental feature")) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
const sqlite = await import("node:sqlite");

export function openDatabase(path: string): Database {
  const db = new sqlite.DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  return db;
}

/** Runs `fn` in one transaction: all of its writes land, or none do. */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
