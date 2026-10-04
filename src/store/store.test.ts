import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./sqlite.ts";
import { type PrVersion, type RepoRecord, Store } from "./store.ts";

const repo: RepoRecord = {
  id: "R_1",
  provider: "github",
  fullName: "acme/api",
  defaultBranch: "main",
  archived: false,
  fork: false,
  private: false,
};

const pr = (id: string, updatedAt: string, state = "OPEN"): PrVersion => ({
  id,
  number: Number(id.replace(/\D/g, "")),
  state,
  updatedAt,
  payload: { id, updatedAt, state },
});

const opened: Store[] = [];
const openStore = (path = ":memory:") => {
  const store = Store.open(path);
  opened.push(store);
  return store;
};
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});

const tempPath = (...parts: string[]) => join(mkdtempSync(join(tmpdir(), "codeflow-")), ...parts);

describe("Store.open", () => {
  it("creates the schema once and reopens without changes", () => {
    const path = tempPath("data", "codeflow.db");
    const first = Store.open(path);
    first.upsertRepo(repo);
    first.close();
    expect(
      openStore(path)
        .repoSummaries()
        .map((r) => r.fullName),
    ).toEqual(["acme/api"]);
  });

  it("refuses a database from a newer codeflow", () => {
    const path = tempPath("codeflow.db");
    const db = openDatabase(path);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
    db.exec("INSERT INTO meta VALUES ('schema_version', '999')");
    db.close();
    expect(() => openStore(path)).toThrow(/newer codeflow/);
  });
});

describe("repos", () => {
  it("start with an empty sync state", () => {
    expect(openStore().upsertRepo(repo)).toEqual({
      watermark: null,
      coveredSince: null,
      tailCursor: null,
      headCursor: null,
      headNewest: null,
      openSwept: false,
      sweepCursor: null,
    });
  });

  it("record a default-branch change, not every sighting", () => {
    const store = openStore();
    store.upsertRepo(repo, new Date("2026-01-01"));
    store.upsertRepo(repo, new Date("2026-02-01"));
    store.upsertRepo({ ...repo, defaultBranch: "develop" }, new Date("2026-03-01"));
    expect(store.repoSummaries()[0]).toMatchObject({ defaultBranch: "develop", branchChanges: 1 });
  });
});

describe("savePage", () => {
  it("stores each version once and moves the sync state on", () => {
    const store = openStore();
    store.upsertRepo(repo);
    const run = store.startRun("sync");

    const first = [pr("P1", "2026-01-01T00:00:00Z")];
    expect(store.savePage(repo.id, first, run, { tailCursor: "c1" })).toBe(1);
    const second = [pr("P1", "2026-01-01T00:00:00Z"), pr("P1", "2026-01-02T00:00:00Z", "MERGED")];
    expect(store.savePage(repo.id, second, run, { tailCursor: "c2", openSwept: true })).toBe(1);

    expect(store.syncState(repo.id)).toMatchObject({ tailCursor: "c2", openSwept: true });
    expect([...store.latestPrs()]).toEqual([
      {
        id: "P1",
        repoId: repo.id,
        number: 1,
        state: "MERGED",
        updatedAt: "2026-01-02T00:00:00Z",
        payload: { id: "P1", updatedAt: "2026-01-02T00:00:00Z", state: "MERGED" },
      },
    ]);
    expect(store.repoSummaries()[0]).toMatchObject({ prs: 1, merged: 1, versions: 2 });
  });

  it("stores nothing and keeps the old state when a page fails partway", () => {
    const store = openStore();
    store.upsertRepo(repo);
    const run = store.startRun("sync");
    const unserializable = { ...pr("P2", "2026-01-01T00:00:00Z"), payload: { n: 1n } };

    expect(() =>
      store.savePage(repo.id, [pr("P1", "2026-01-01T00:00:00Z"), unserializable], run, {
        tailCursor: "c1",
      }),
    ).toThrow();
    expect([...store.latestPrs()]).toEqual([]);
    expect(store.syncState(repo.id).tailCursor).toBeNull();
  });
});

describe("removeRepo", () => {
  it("removes one repo and everything stored about it, leaving the others", () => {
    const store = openStore();
    const other = { ...repo, id: "R_2", fullName: "acme/web" };
    store.upsertRepo(repo);
    store.upsertRepo(other);
    const run = store.startRun("sync");
    store.savePage(
      repo.id,
      [pr("P1", "2026-09-01T00:00:00Z"), pr("P2", "2026-09-02T00:00:00Z")],
      run,
      {},
    );
    store.savePage(other.id, [pr("P3", "2026-09-03T00:00:00Z")], run, {});
    expect(store.removeRepo(repo.id)).toBe(2);
    expect(store.repos().map((r) => r.fullName)).toEqual(["acme/web"]);
    expect(store.rawFingerprint(other.id)).not.toBe(store.rawFingerprint(repo.id));
    expect(store.repoSummaries().map((r) => r.prs)).toEqual([1]);
  });
});

describe("locks", () => {
  it("refuse a lock a live process holds", () => {
    const store = openStore();
    store.acquireLock("sync");
    expect(() => store.acquireLock("sync")).toThrow(/Another sync is running/);
    store.releaseLock("sync");
    expect(() => store.acquireLock("sync")).not.toThrow();
  });

  it("take over a lock whose process has died", () => {
    const store = openStore();
    const deadPid = 2 ** 22 + 12_345; // above every platform's pid limit, so never running
    store.acquireLock("sync", { pid: deadPid, host: hostname() });
    expect(() => store.acquireLock("sync")).not.toThrow();
  });

  it("trust another machine's lock until it is a day old", () => {
    const store = openStore();
    store.acquireLock("sync", { pid: 1, host: "elsewhere" }, new Date("2026-10-02T00:00:00Z"));
    expect(() => store.acquireLock("sync", undefined, new Date("2026-10-02T12:00:00Z"))).toThrow(
      /Another sync is running \(pid 1 on elsewhere/,
    );
    expect(() =>
      store.acquireLock("sync", undefined, new Date("2026-10-03T01:00:00Z")),
    ).not.toThrow();
  });
});

describe("runs", () => {
  it("record how a run ended", () => {
    const store = openStore();
    const id = store.startRun("sync", new Date("2026-10-02T10:00:00Z"));
    expect(store.lastRun("sync")?.status).toBe("running");
    store.finishRun(id, { status: "ok", calls: 7, points: 12, detail: { repos: 1 } });
    expect(store.lastRun("sync")).toMatchObject({
      id,
      status: "ok",
      calls: 7,
      points: 12,
      detail: { repos: 1 },
    });
  });

  it("close runs a dead process left running, before the next one starts", () => {
    const store = openStore();
    const crashed = store.startRun("sync");
    store.startRun("doctor");

    expect(store.closeAbandonedRuns("sync")).toBe(1);
    expect(store.lastRun("sync")).toMatchObject({ id: crashed, status: "interrupted" });
    expect(store.lastRun("doctor")?.status).toBe("running");
  });
});
