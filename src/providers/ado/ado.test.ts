import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { derivePr } from "../../core/derive.ts";
import { Store } from "../../store/store.ts";
import { AdoServer } from "../../testing/ado-server.ts";
import { deriveRules } from "../../testing/factories.ts";
import { ADO_ORG, adoLogin, contosoRepos } from "../../testing/scenario.ts";
import { AdoClient, type AdoToken, PACE_MS, resolveAdoToken } from "./client.ts";
import { discoverAdo, selectAdoRepos } from "./discover.ts";
import { normalizeAdoPr } from "./normalize.ts";
import { changedFiles, versionOf } from "./pulls.ts";
import { adoRepoId, syncAdoRepo } from "./sync.ts";
import type { AdoIteration, AdoPayload } from "./types.ts";

const pat: AdoToken = { authorization: "Basic x", source: "$T", kind: "personal access token" };

/** A fetch that answers from a list, recording when each request started. */
function fakeFetch(answers: (() => Response)[], clock: { now: number }, starts: number[]) {
  let i = 0;
  return async () => {
    starts.push(clock.now);
    const answer = answers[Math.min(i++, answers.length - 1)];
    return answer ? answer() : new Response("{}");
  };
}
const ok = (headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ value: [] }), {
    headers: { "content-type": "application/json", ...headers },
  });

describe("the Azure DevOps client [D41]", () => {
  it("sends one request at a time, at most two a second", async () => {
    const clock = { now: 0 };
    const starts: number[] = [];
    const client = new AdoClient({
      url: "https://dev.azure.com",
      organization: "contoso",
      token: pat,
      fetch: fakeFetch([() => ok()], clock, starts),
      now: () => clock.now,
      sleep: async (ms) => {
        clock.now += ms;
      },
    });
    await Promise.all([client.get("/a"), client.get("/b"), client.get("/c")]);
    expect(starts).toEqual([0, PACE_MS, 2 * PACE_MS]);
  });

  it("slows down when Azure DevOps's headers say the budget is low, and waits out a 429", async () => {
    const clock = { now: 0 };
    const starts: number[] = [];
    const waits: string[] = [];
    const client = new AdoClient({
      url: "https://dev.azure.com",
      organization: "contoso",
      token: pat,
      fetch: fakeFetch(
        [
          () => ok({ "x-ratelimit-delay": "3" }),
          () => new Response("", { status: 429, headers: { "retry-after": "10" } }),
          () => ok(),
          () => ok(),
        ],
        clock,
        starts,
      ),
      now: () => clock.now,
      sleep: async (ms) => {
        clock.now += ms;
      },
      onWait: (message) => waits.push(message),
    });
    await client.get("/a");
    await client.get("/b");
    await client.get("/c");
    // A 3 s pause after the first, then 10 s after the throttled one.
    expect(starts).toEqual([0, 3000, 13_000, 13_000 + PACE_MS]);
    expect(waits.join(" ")).toMatch(/slow down; waiting 10s/);
  });

  it("steps down to an older API version when an Azure DevOps Server doesn't know 7.1", async () => {
    const versions: string[] = [];
    const client = new AdoClient({
      url: "https://tfs.acme.test/tfs",
      organization: "DefaultCollection",
      token: pat,
      paceMs: 0,
      fetch: async (input) => {
        const version = new URL(String(input)).searchParams.get("api-version") ?? "";
        versions.push(version);
        return version === "6.0"
          ? ok()
          : new Response(
              JSON.stringify({
                message: `The requested REST API version of ${version} is out of range`,
              }),
              {
                status: 400,
                headers: { "content-type": "application/json" },
              },
            );
      },
    });
    await client.get("/_apis/projects");
    await client.get("/_apis/projects");
    expect(versions).toEqual(["7.1", "7.0", "6.0", "6.0"]);
  });

  it("asks for a preview version when a resource only has one, without stepping down", async () => {
    const versions: string[] = [];
    const client = new AdoClient({
      url: "https://dev.azure.test",
      organization: "contoso",
      token: pat,
      paceMs: 0,
      fetch: async (input) => {
        const url = new URL(String(input));
        const version = url.searchParams.get("api-version") ?? "";
        versions.push(version);
        return url.pathname.endsWith("connectionData") && !version.endsWith("-preview")
          ? new Response(
              JSON.stringify({
                message: `The requested version "${version}" of the resource is under preview. The -preview flag must be supplied in the api-version for such requests.`,
              }),
              { status: 400, headers: { "content-type": "application/json" } },
            )
          : ok();
      },
    });
    await client.get("/_apis/connectionData");
    await client.get("/_apis/projects");
    expect(versions).toEqual(["7.1", "7.1-preview", "7.1"]);
  });

  it("says plainly when the token is refused, rather than reading a sign-in page", async () => {
    const clock = { now: 0 };
    const client = new AdoClient({
      url: "https://dev.azure.com",
      organization: "contoso",
      token: pat,
      fetch: fakeFetch(
        [
          () =>
            new Response("<html>sign in</html>", {
              status: 203,
              headers: { "content-type": "text/html" },
            }),
        ],
        clock,
        [],
      ),
      paceMs: 0,
    });
    await expect(client.get("/x")).rejects.toThrow(/refused the token/);
  });

  it("finds a token in the configured variable, then the Azure CLI's, or says how to get one", async () => {
    const fromEnv = await resolveAdoToken({
      tokenEnv: "ADO_PAT",
      env: { ADO_PAT: "abc" },
      azToken: async () => undefined,
    });
    expect(fromEnv).toMatchObject({ source: "$ADO_PAT", kind: "personal access token" });
    expect(fromEnv.authorization).toBe(`Basic ${Buffer.from(":abc").toString("base64")}`);
    const fromAz = await resolveAdoToken({
      tokenEnv: "ADO_PAT",
      env: {},
      azToken: async () => "jwt",
    });
    expect(fromAz).toMatchObject({ authorization: "Bearer jwt", kind: "Microsoft Entra token" });
    await expect(
      resolveAdoToken({ tokenEnv: "ADO_PAT", env: {}, azToken: async () => undefined }),
    ).rejects.toThrow(
      /Set ADO_PAT .* Code \(Read\) and Project and Team \(Read\), or sign in with the Azure CLI/,
    );
  });
});

describe("Azure DevOps repos a source selects", () => {
  it("leaves out disabled, empty and forked repos, and those the patterns skip", () => {
    const raw = [
      { id: "1", name: "api", defaultBranch: "refs/heads/main", project: { name: "P" } },
      {
        id: "2",
        name: "old",
        defaultBranch: "refs/heads/main",
        isDisabled: true,
        project: { name: "P" },
      },
      { id: "3", name: "empty", project: { name: "P" } },
      {
        id: "4",
        name: "api-fork",
        defaultBranch: "refs/heads/main",
        isFork: true,
        project: { name: "P" },
      },
      { id: "5", name: "sandbox", defaultBranch: "refs/heads/dev", project: { name: "P" } },
    ];
    const source = {
      kind: "ado" as const,
      organization: "contoso",
      project: "P",
      include: ["*"],
      exclude: ["sand*"],
      forks: false,
    };
    const { repos, skipped } = selectAdoRepos(source, "contoso", raw);
    expect(repos.map((r) => [r.fullName, r.defaultBranch])).toEqual([["contoso/P/api", "main"]]);
    expect(skipped.map((s) => s.reason).sort()).toEqual(["disabled", "empty", "excluded", "fork"]);
  });
});

describe("an Azure DevOps PR, read as codeflow's PR model", () => {
  const [billing] = contosoRepos(Date.parse("2026-10-04T00:00:00Z"));
  const repo = { id: "ado:repo-billing", fullName: `${ADO_ORG}/Platform/billing` };
  const read = (find: (p: AdoPayload) => boolean) => {
    const payload = billing?.prs.find(find);
    if (!payload) throw new Error("no such PR in the scenario");
    return normalizeAdoPr(payload, repo, versionOf(payload));
  };

  it("turns votes into reviews, a reviewer's thread into a commented review, and pushes into rounds", () => {
    const pr = read((p) => p.iterations.length > 1 && p.pr.status === "completed");
    expect(pr.state).toBe("merged");
    expect(pr.author?.login).toMatch(/@acme\.example$/);
    expect(pr.reviews.map((r) => r.state)).toEqual(
      expect.arrayContaining(["changes_requested", "approved"]),
    );
    expect(pr.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["review_requested", "force_pushed", "merged"]),
    );
    expect(pr.baseBranch).toBe("main");
    expect(pr.id).toBe(`ado:${ADO_ORG}:${pr.number}`);
    expect(pr.files.length).toBeGreaterThan(0);
    expect(pr.additions).toBe(pr.files.reduce((n, f) => n + f.additions, 0));
  });

  it("knows a build service for a bot, and keeps a reviewer's comments apart from the author's", () => {
    const bot = read((p) => p.pr.createdBy.uniqueName?.startsWith("Build\\") ?? false);
    expect(bot.author?.bot).toBe(true);
    const discussed = read((p) => p.threads.some((t) => t.comments.length > 1));
    const commented = discussed.reviews.find((r) => r.state === "commented");
    expect(commented?.author?.login).not.toBe(discussed.author?.login);
    expect(discussed.comments.every((c) => c.author?.login === discussed.author?.login)).toBe(true);
  });

  it("leaves size unknown when the files couldn't be counted [rule 4]", () => {
    const payload = billing?.prs[0];
    if (!payload) throw new Error("no PR");
    const pr = normalizeAdoPr({ ...payload, files: null }, repo, versionOf(payload));
    expect(pr.truncated).toContain("files");
    expect(pr.files).toEqual([]);
  });

  it("reads every file at zero lines, as stored before the diff fix, as size unknown [rule 4]", () => {
    const payload = billing?.prs.find((p) => (p.files?.length ?? 0) > 0);
    if (!payload?.files) throw new Error("no PR with files");
    const zeroed = payload.files.map((f) => ({ ...f, additions: 0, deletions: 0 }));
    const pr = normalizeAdoPr({ ...payload, files: zeroed }, repo, versionOf(payload));
    expect(pr.truncated).toContain("files");
    expect(pr.files).toEqual([]);
  });
});

describe("syncing an Azure DevOps repo", () => {
  const repos = contosoRepos();
  const server = new AdoServer(repos);
  let client: AdoClient;
  beforeAll(async () => {
    const url = await server.start();
    client = new AdoClient({
      url,
      organization: ADO_ORG,
      token: {
        authorization: `Basic ${Buffer.from(`:${server.token}`).toString("base64")}`,
        source: "",
        kind: "personal access token",
      },
    });
  });
  afterAll(() => server.stop());

  it("asks each PR read for its linked work items only when the org links fixes by them", async () => {
    const source = {
      kind: "ado" as const,
      organization: ADO_ORG,
      project: "Platform",
      include: ["billing"],
      exclude: [],
      forks: false,
    };
    const {
      repos: [repo],
    } = await discoverAdo(client, source);
    const first = repos[0]?.prs[0];
    if (!repo || !first) throw new Error("billing not found");
    first.workItems = ["12340"];
    const asked = () => server.calls.filter((c) => c.endsWith("/workitems")).length;
    const sync = async (workItems: boolean) => {
      const store = Store.open(":memory:");
      const before = asked();
      await syncAdoRepo({
        client,
        store,
        runId: store.startRun("sync"),
        repo,
        since: "2000-01-01",
        startedAt: new Date().toISOString(),
        workItems,
      });
      return { store, calls: asked() - before };
    };
    expect((await sync(false)).calls).toBe(0);
    const on = await sync(true);
    expect(on.calls).toBe(repos[0]?.prs.length);
    const stored = [...on.store.latestPrs()].find(
      (v) => (v.payload as AdoPayload).pr.pullRequestId === first.pr.pullRequestId,
    );
    expect((stored?.payload as AdoPayload | undefined)?.workItems).toEqual(["12340"]);
    delete first.workItems;
  });

  describe("measuring from a day [rule 19]", () => {
    const billing = repos[0];
    const template = billing?.prs.find((p) => p.pr.status === "completed");
    if (!billing || !template) throw new Error("scenario lacks a completed PR");
    const source = {
      kind: "ado" as const,
      organization: ADO_ORG,
      project: "Platform",
      include: ["billing"],
      exclude: [],
      forks: false,
    };
    /** A PR with its own dates, put on the server until `done`. */
    const made = (
      id: number,
      status: "completed" | "abandoned",
      created: string,
      closed: string,
    ) => {
      server.put("billing", {
        ...template,
        pr: {
          ...template.pr,
          pullRequestId: id,
          status,
          creationDate: `${created}T10:00:00Z`,
          closedDate: `${closed}T10:00:00Z`,
        },
      });
      return id;
    };
    const done = () => {
      for (const id of [9001, 9002, 9003, 9004]) server.remove("billing", id);
    };
    const sync = async (store: Store, since: string) => {
      const {
        repos: [repo],
      } = await discoverAdo(client, source);
      if (!repo) throw new Error("billing not found");
      const outcome = await syncAdoRepo({
        client,
        store,
        runId: store.startRun("sync"),
        repo,
        since,
        startedAt: new Date().toISOString(),
      });
      expect(outcome.error).toBeUndefined();
      return { outcome, id: adoRepoId(repo) };
    };
    const storedNumbers = (store: Store) => new Set([...store.latestPrs()].map((v) => v.number));
    const threadReads = (id: number) =>
      server.calls.filter((c) => c.endsWith(`/pullRequests/${id}/threads`)).length;
    const walks = (outcome: { walks: { walk: string }[] }) => outcome.walks.map((w) => w.walk);

    it("reads a PR merged or abandoned since that day, though it was opened before it", async () => {
      // Opened before 2026-01-01, and: merged after it; abandoned after it; closed before it.
      const mergedAfter = made(9001, "completed", "2025-12-10", "2026-02-05");
      const abandonedAfter = made(9003, "abandoned", "2025-11-20", "2026-01-15");
      const closedBefore = made(9002, "completed", "2025-12-10", "2025-12-20");
      try {
        const store = Store.open(":memory:");
        const { outcome } = await sync(store, "2026-01-01");
        expect(walks(outcome)).toContain("closed backfill");
        const stored = storedNumbers(store);
        expect(stored.has(mergedAfter)).toBe(true);
        expect(stored.has(abandonedAfter)).toBe(true);
        expect(stored.has(closedBefore)).toBe(false);
      } finally {
        done();
      }
    });

    it("reads them on the next sync of a repo synced before, once, and reads nothing twice", async () => {
      const store = Store.open(":memory:");
      // As the repo was: backfilled by creation date, with those PRs not yet on the server.
      const first = await sync(store, "2026-01-01");
      store.savePage(first.id, [], store.startRun("sync"), { closedSince: null });
      expect(store.syncState(first.id)).toMatchObject({ coveredSince: "2026-01-01" });
      const missed = made(9001, "completed", "2025-12-10", "2026-02-05");
      const also = made(9003, "abandoned", "2025-11-20", "2026-01-15");
      try {
        const again = await sync(store, "2026-01-01");
        // The creation walk is done: only the closed one runs.
        expect(walks(again.outcome)).not.toContain("backfill");
        expect(walks(again.outcome)).toContain("closed backfill");
        expect(storedNumbers(store).has(missed)).toBe(true);
        expect(storedNumbers(store).has(also)).toBe(true);
        expect(store.syncState(first.id).closedSince).toBe("2026-01-01");

        // Nothing more to find: no repeat of the walk, and no PR read again.
        const reads = [threadReads(missed), threadReads(also)];
        const third = await sync(store, "2026-01-01");
        expect(walks(third.outcome)).not.toContain("closed backfill");
        expect([threadReads(missed), threadReads(also)]).toEqual(reads);
      } finally {
        done();
      }
    });

    it("reads PRs closed in between when the day moves earlier, and only those", async () => {
      const kept = made(9001, "completed", "2025-12-10", "2026-02-05");
      const between = made(9004, "completed", "2025-10-01", "2025-11-15");
      const before = made(9002, "completed", "2025-09-01", "2025-09-20");
      try {
        const store = Store.open(":memory:");
        await sync(store, "2026-01-01");
        expect(storedNumbers(store).has(kept)).toBe(true);
        expect(storedNumbers(store).has(between)).toBe(false);
        const keptReads = threadReads(kept);

        const earlier = await sync(store, "2025-11-01");
        expect(walks(earlier.outcome)).toContain("closed backfill");
        expect(storedNumbers(store).has(between)).toBe(true);
        expect(storedNumbers(store).has(before)).toBe(false);
        // The one already stored wasn't read again.
        expect(threadReads(kept)).toBe(keptReads);
      } finally {
        done();
      }
    });
  });

  it("finishes a backfill past a PR Azure DevOps won't give, and says which it skipped", async () => {
    const store = Store.open(":memory:");
    const {
      repos: [repo],
    } = await discoverAdo(client, {
      kind: "ado",
      organization: ADO_ORG,
      project: "Platform",
      include: ["billing"],
      exclude: [],
      forks: false,
    });
    const broken = repos[0]?.prs.find((p) => p.pr.status === "completed");
    if (!repo || !broken) throw new Error("billing not found");
    server.broken.add(broken.pr.pullRequestId);
    try {
      const outcome = await syncAdoRepo({
        client,
        store,
        runId: store.startRun("sync"),
        repo,
        since: "2000-01-01",
        startedAt: new Date().toISOString(),
      });
      expect(outcome.error).toBeUndefined();
      const backfill = outcome.walks.find((w) => w.walk === "backfill");
      expect(backfill?.skipped).toEqual([
        { number: broken.pr.pullRequestId, error: expect.stringContaining("TF401180") },
      ]);
      // Done, so the next sync doesn't backfill again.
      expect(store.syncState(adoRepoId(repo)).coveredSince).toBe("2000-01-01");
      expect(store.repoSummaries()[0]?.prs).toBe((repos[0]?.prs.length ?? 0) - 1);
    } finally {
      server.broken.clear();
    }
  });

  it("backfills to `since`, then on each sync fetches only open PRs and what closed since", async () => {
    const store = Store.open(":memory:");
    const [source] = [
      {
        kind: "ado" as const,
        organization: ADO_ORG,
        project: "Platform",
        include: ["billing"],
        exclude: [],
        forks: false,
      },
    ];
    const {
      repos: [repo],
    } = await discoverAdo(client, source);
    if (!repo) throw new Error("billing not found");
    const run = store.startRun("sync");
    const first = await syncAdoRepo({
      client,
      store,
      runId: run,
      repo,
      since: "2000-01-01",
      startedAt: new Date().toISOString(),
    });
    expect(first.error).toBeUndefined();
    const all = repos[0]?.prs.length ?? 0;
    expect(first.walks.find((w) => w.walk === "backfill")?.prs).toBe(all);
    expect([...store.latestPrs(adoRepoId(repo))]).toHaveLength(all);

    const calls = server.calls.length;
    const second = await syncAdoRepo({
      client,
      store,
      runId: run,
      repo,
      since: "2000-01-01",
      startedAt: new Date().toISOString(),
    });
    const added = second.walks.reduce((n, w) => n + w.newVersions, 0);
    expect(added).toBe(0);
    expect(second.walks.map((w) => w.walk)).toEqual(["open PRs", "closed since"]);
    // Only the open PRs are read again: a few calls each, not the whole repo.
    const open = repos[0]?.prs.filter((p) => p.pr.status === "active").length ?? 0;
    expect(server.calls.length - calls).toBeLessThan(10 + open * 6);

    // A PR that merges between syncs is picked up, with its new version.
    const active = repos[0]?.prs.find((p) => p.pr.status === "active");
    if (!active) throw new Error("no open PR");
    const closedDate = new Date().toISOString();
    server.put("billing", { ...active, pr: { ...active.pr, status: "completed", closedDate } });
    const third = await syncAdoRepo({
      client,
      store,
      runId: run,
      repo,
      since: "2000-01-01",
      startedAt: new Date().toISOString(),
    });
    expect(third.walks.reduce((n, w) => n + w.newVersions, 0)).toBe(1);
    const merged = [...store.latestPrs(adoRepoId(repo))].find(
      (p) => p.number === active.pr.pullRequestId,
    );
    expect(merged?.state).toBe("MERGED");
    expect(adoLogin("ana")).toBe("ana@acme.example");
  });
});

describe("an Azure DevOps PR's line counts", () => {
  const files = Array.from({ length: 23 }, (_, i) => ({ path: `/src/f${i}.cs`, lines: i + 1 }));
  const repo = {
    id: "r1",
    name: "app",
    project: "P",
    fullName: "contoso/P/app",
    defaultBranch: "main",
    disabled: false,
    fork: false,
  };
  const iterations = [
    { id: 1, sourceRefCommit: { commitId: "s1" }, commonRefCommit: { commitId: "c1" } },
  ] as unknown as AdoIteration[];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const changes = () =>
    json({ changeEntries: files.map((f) => ({ item: { path: f.path }, changeType: "edit" })) });
  const base = "/P/_apis/git/repositories/r1/pullRequests/7";

  it("are asked for ten files at a time, and again for any an answer leaves out", async () => {
    const asked: number[] = [];
    const client = new AdoClient({
      url: "https://dev.azure.test",
      organization: "contoso",
      token: pat,
      paceMs: 0,
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname.endsWith("/changes")) return changes();
        const params = (JSON.parse(String(init?.body)) as { fileDiffParams: { path: string }[] })
          .fileDiffParams;
        asked.push(params.length);
        // The second answer comes back three short, and in its own order.
        const given = (asked.length === 2 ? params.slice(0, 7) : params.slice(0, 10)).reverse();
        return json({
          count: given.length,
          value: given.map((p) => ({
            path: p.path,
            lineDiffBlocks: [
              {
                changeType: "edit",
                modifiedLinesCount: Number(/\d+/.exec(p.path)?.[0]) + 1,
                originalLinesCount: 1,
              },
            ],
          })),
        });
      },
    });
    const sized = await changedFiles(client, repo, base, iterations);
    if (!("files" in sized)) throw new Error(sized.error);
    expect(asked).toEqual([10, 10, 6]);
    expect(sized.files).toHaveLength(23);
    expect(sized.files.reduce((n, f) => n + f.additions, 0)).toBe(
      files.reduce((n, f) => n + f.lines, 0),
    );
    expect(sized.files.every((f) => f.deletions === 1)).toBe(true);
  });

  it("are unknown, with the reason, when an answer brings back none of the files asked for", async () => {
    const client = new AdoClient({
      url: "https://dev.azure.test",
      organization: "contoso",
      token: pat,
      paceMs: 0,
      fetch: async (input) =>
        new URL(String(input)).pathname.endsWith("/changes")
          ? changes()
          : json({ count: 0, value: [] }),
    });
    expect(await changedFiles(client, repo, base, iterations)).toEqual({
      error: expect.stringContaining("gave no diff for 10 files"),
    });
  });
});

describe("an Azure DevOps PR opened as a draft [rule 18]", () => {
  const [billing] = contosoRepos(Date.parse("2026-06-01T00:00:00Z"));
  const repo = { id: "ado:repo-billing", fullName: `${ADO_ORG}/Platform/billing` };
  const template = billing?.prs.find((p) => p.pr.status === "completed" && p.threads.length > 0);
  if (!template) throw new Error("scenario lacks a completed PR");
  const author = template.pr.createdBy;
  const rui = { displayName: "Rui", uniqueName: "rui@acme.example" };
  const created = "2026-03-02T10:00:00Z";
  const published = "2026-03-03T10:00:00Z";
  const reviewed = "2026-03-03T12:00:00Z";

  /** The scenario's PR, rebuilt: created at `created`, with only the threads given. */
  const payload = (threads: AdoPayload["threads"], isDraft = false): AdoPayload => ({
    ...template,
    pr: { ...template.pr, creationDate: created, closedDate: "2026-03-05T10:00:00Z", isDraft },
    commits: template.commits.map((c) => ({ ...c, author: { date: "2026-03-01T10:00:00Z" } })),
    iterations: template.iterations.slice(0, 1),
    threads: [
      ...threads,
      {
        id: 90,
        publishedDate: reviewed,
        comments: [{ id: 1, author: rui, publishedDate: reviewed, commentType: "system" }],
        properties: {
          CodeReviewThreadType: { $value: "VoteUpdate" },
          CodeReviewVoteResult: { $value: 10 },
        },
      },
    ],
  });
  const systemThread = (
    id: number,
    at: string,
    content: string,
  ): AdoPayload["threads"][number] => ({
    id,
    publishedDate: at,
    comments: [{ id: 1, author, content, publishedDate: at, commentType: "system" }],
  });
  const read = (p: AdoPayload) => normalizeAdoPr(p, repo, versionOf(p));
  const fact = (p: AdoPayload) => derivePr(read(p), deriveRules());

  it("starts pickup when it was published, read from Azure DevOps's own system comment", () => {
    const p = payload([systemThread(10, published, "Ana published the pull request")]);
    expect(read(p).events).toContainEqual({ type: "ready_for_review", at: published });
    expect(fact(p)).toMatchObject({ readyAt: published, pickupHours: 2 });
  });

  it("reads the thread's property too, and counts one publish once", () => {
    const byProperty: AdoPayload["threads"][number] = {
      ...systemThread(11, published, "Ana published the pull request"),
      properties: {
        CodeReviewThreadType: { $value: "IsDraftUpdated" },
        CodeReviewIsDraft: { $value: "false" },
      },
    };
    const p = payload([byProperty, systemThread(12, published, "Ana published the pull request")]);
    expect(read(p).events.filter((e) => e.type === "ready_for_review")).toHaveLength(1);
    expect(fact(p).readyAt).toBe(published);
  });

  it("counts a PR that opened ready, then went back to draft, as ready at creation", () => {
    const p = payload([
      systemThread(13, "2026-03-02T12:00:00Z", "Ana marked the pull request as a draft"),
    ]);
    expect(fact(p).readyAt).toBe(created);
  });

  it("ignores a person's own comment that only says published", () => {
    const talk: AdoPayload["threads"][number] = {
      id: 14,
      publishedDate: published,
      comments: [
        {
          id: 1,
          author: rui,
          content: "I published the pull request docs",
          publishedDate: published,
          commentType: "text",
        },
      ],
    };
    expect(read(payload([talk])).events.some((e) => e.type === "ready_for_review")).toBe(false);
  });
});
