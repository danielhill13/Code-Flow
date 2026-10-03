import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../store/store.ts";
import { repo } from "../../testing/factories.ts";
import { FakeGitHub } from "../../testing/fake-github.ts";
import { type RepoSyncOptions, syncRepo, syncRepos, toPrVersion } from "./sync.ts";

const SINCE = "2025-10-01";
const day = (date: string) => `${date}T00:00:00Z`;

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

/** A fake repo and a real (in-memory) store, with a `sync` that runs one repo sync between them. */
function setup() {
  const github = new FakeGitHub(2);
  const store = Store.open(":memory:");
  stores.push(store);
  store.upsertRepo({
    id: "R",
    provider: "github",
    fullName: "acme/api",
    defaultBranch: "main",
    archived: false,
    fork: false,
    private: false,
  });
  const runId = store.startRun("sync");

  const sync = (options: Partial<RepoSyncOptions> = {}) => {
    github.requests.length = 0;
    return syncRepo({
      since: SINCE,
      lastPrActivity: github.lastPrActivity,
      state: store.syncState("R"),
      fetchPage: github.fetchPage,
      savePage: (prs, patch) => store.savePage("R", prs.map(toPrVersion), runId, patch),
      ...options,
    });
  };
  /** Each stored PR's newest version, as `number@updatedAt`, in number order. */
  const stored = () =>
    [...store.latestPrs("R")]
      .sort((a, b) => a.number - b.number)
      .map((pr) => `${pr.number}@${pr.updatedAt}`);
  /** PRs active since SINCE (or still open) whose current version is not stored. */
  const missing = () => {
    const have = new Set(stored());
    return github
      .current((pr) => pr.updatedAt >= SINCE || pr.state === "OPEN")
      .filter((pr) => !have.has(pr));
  };
  return { github, store, sync, stored, missing };
}

describe("syncRepo", () => {
  it("backfills down to `since`, then fetches older open PRs once", async () => {
    const { github, store, sync, stored, missing } = setup();
    github.set(1, day("2025-01-01"), "OPEN"); // stale but open: work in progress
    github.set(2, day("2025-02-01")); // closed before the window: never fetched
    github.set(3, day("2025-03-01"));
    github.set(4, day("2025-11-01"));
    github.set(5, day("2025-12-01"), "OPEN");
    github.set(6, day("2026-01-01"));

    const result = await sync();

    expect(result).toEqual({
      interrupted: false,
      walks: [
        { walk: "backfill", pages: 2, prs: 4, newVersions: 4 },
        { walk: "open sweep", pages: 1, prs: 2, newVersions: 1 },
      ],
    });
    expect(missing()).toEqual([]);
    expect(stored()).not.toContain(`2@${day("2025-02-01")}`);
    expect(store.syncState("R")).toMatchObject({
      watermark: day("2026-01-01"),
      coveredSince: SINCE,
      openSwept: true,
    });
  });

  it("makes no calls for a repo with no PR activity since the last run", async () => {
    const { github, sync } = setup();
    github.set(1, day("2025-11-01"));
    await sync();

    expect(await sync()).toEqual({ walks: [], interrupted: false });
    expect(github.requests).toEqual([]);
  });

  it("fetches only the PRs that changed", async () => {
    const { github, store, sync, missing } = setup();
    for (const [n, date] of [
      [4, "2025-11-01"],
      [5, "2025-12-01"],
      [6, "2026-01-01"],
    ] as const) {
      github.set(n, day(date));
    }
    await sync();

    github.set(4, day("2026-02-01"), "CLOSED"); // an old PR changes
    github.set(7, day("2026-02-02")); // a new one arrives
    const result = await sync();

    expect(result.walks).toEqual([{ walk: "updates", pages: 2, prs: 4, newVersions: 2 }]);
    expect(missing()).toEqual([]);
    expect(store.syncState("R").watermark).toBe(day("2026-02-02"));
  });

  it("resumes an interrupted backfill where it stopped, catching what changed meanwhile", async () => {
    const { github, sync, missing } = setup();
    for (let n = 1; n <= 6; n++) github.set(n, day(`2026-0${n}-01`));
    github.set(9, day("2025-01-01"));

    const abort = new AbortController();
    const first = await sync({
      signal: abort.signal,
      onProgress: (progress) => progress.pages === 1 && abort.abort(),
    });
    expect(first).toEqual({
      interrupted: true,
      walks: [{ walk: "backfill", pages: 1, prs: 2, newVersions: 2 }],
    });

    github.set(6, day("2026-07-01")); // already fetched, then changed
    github.set(3, day("2026-07-02")); // not fetched yet, then changed: jumps above the cursor
    github.set(7, day("2026-07-03")); // new
    const second = await sync();

    expect(second.walks.map((w) => [w.walk, w.pages])).toEqual([
      ["updates", 2],
      ["backfill", 2],
      ["open sweep", 1],
    ]);
    // The backfill carried on after PR 5, the last PR of its first page: nothing fetched twice.
    expect(github.requests[2]?.after).toBe(JSON.stringify([day("2026-05-01"), "PR_5"]));
    expect(missing()).toEqual([]);
  });

  it("only moves the watermark once an interrupted update walk finishes", async () => {
    const { github, store, sync, missing } = setup();
    github.set(1, day("2025-11-01"));
    await sync();
    for (let n = 2; n <= 6; n++) github.set(n, day(`2026-0${n - 1}-01`));

    const abort = new AbortController();
    await sync({ signal: abort.signal, onProgress: () => abort.abort() });
    expect(store.syncState("R")).toMatchObject({
      watermark: day("2025-11-01"),
      headNewest: day("2026-05-01"),
    });

    github.set(7, day("2026-06-01")); // arrives while the walk is paused, above its cursor
    await sync();
    expect(store.syncState("R")).toMatchObject({
      watermark: day("2026-05-01"),
      headCursor: null,
      headNewest: null,
    });

    await sync(); // PR 7 is past the watermark, so the next run picks it up
    expect(missing()).toEqual([]);
    expect(store.syncState("R").watermark).toBe(day("2026-06-01"));
  });

  it("extends the backfill from where it stopped when `since` moves earlier", async () => {
    const { github, store, sync, stored } = setup();
    github.set(1, day("2025-01-01"));
    github.set(2, day("2025-02-01"));
    github.set(3, day("2025-03-01"));
    github.set(4, day("2025-11-01"));
    await sync();
    expect(stored()).not.toContain(`2@${day("2025-02-01")}`);

    const result = await sync({ since: "2025-01-15" });

    expect(result.walks).toEqual([{ walk: "backfill", pages: 1, prs: 2, newVersions: 2 }]);
    expect(github.requests[0]?.after).toBe(JSON.stringify([day("2025-03-01"), "PR_3"]));
    expect(stored()).toContain(`2@${day("2025-02-01")}`);
    expect(store.syncState("R").coveredSince).toBe("2025-01-15");
  });

  it("finishes a repo with no pull requests and picks up its first one later", async () => {
    const { github, store, sync, missing } = setup();
    expect((await sync()).interrupted).toBe(false);
    expect(store.syncState("R")).toMatchObject({ watermark: SINCE, coveredSince: SINCE });

    github.set(1, day("2026-03-01"));
    await sync();
    expect(missing()).toEqual([]);
  });
});

describe("syncRepos", () => {
  it("reports what a failing repo stored, keeps its place, and carries on", async () => {
    const store = Store.open(":memory:");
    stores.push(store);
    const github = { api: new FakeGitHub(2, "api"), web: new FakeGitHub(2, "web") };
    for (let n = 1; n <= 5; n++) {
      github.api.set(n, day(`2026-0${n}-01`));
      github.web.set(n, day(`2026-0${n}-01`));
    }
    let apiPages = 0;

    const { outcomes, interrupted } = await syncRepos({
      fetchPage: async (target, request) => {
        if (target.name === "api" && ++apiPages === 2) {
          throw new Error("GitHub sent an incomplete response");
        }
        return github[target.name as "api" | "web"].fetchPage(request);
      },
      store,
      runId: store.startRun("sync"),
      repos: [repo("api"), repo("web")],
      since: SINCE,
    });

    expect(interrupted).toBe(false);
    expect(outcomes[0]).toMatchObject({
      error: "GitHub sent an incomplete response",
      walks: [{ walk: "backfill", pages: 1, prs: 2, newVersions: 2 }],
    });
    expect(outcomes[1]?.error).toBeUndefined();
    expect(outcomes[1]?.walks.map((w) => [w.walk, w.pages])).toEqual([
      ["backfill", 3],
      ["open sweep", 1],
    ]);
    // The failed repo's next sync resumes after the last page it stored.
    expect(store.syncState("id-api").tailCursor).toBe(JSON.stringify([day("2026-04-01"), "api_4"]));
  });
});
