import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../../store/store.ts";
import { AdoServer } from "../../testing/ado-server.ts";
import { ADO_ORG, adoLogin, contosoRepos } from "../../testing/scenario.ts";
import { AdoClient, type AdoToken, PACE_MS, resolveAdoToken } from "./client.ts";
import { discoverAdo, selectAdoRepos } from "./discover.ts";
import { normalizeAdoPr } from "./normalize.ts";
import { versionOf } from "./pulls.ts";
import { adoRepoId, syncAdoRepo } from "./sync.ts";
import type { AdoPayload } from "./types.ts";

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
    ).rejects.toThrow(/Set ADO_PAT .* Code \(Read\), or sign in with the Azure CLI/);
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
