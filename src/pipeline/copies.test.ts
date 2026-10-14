import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../config/load.ts";
import { AdoClient } from "../providers/ado/client.ts";
import { discoverAdo } from "../providers/ado/discover.ts";
import { syncAdoRepo } from "../providers/ado/sync.ts";
import type { AdoPayload } from "../providers/ado/types.ts";
import { updateCopy } from "../providers/git/git.ts";
import { Store } from "../store/store.ts";
import { AdoServer } from "../testing/ado-server.ts";
import { GitRepo } from "../testing/git-repo.ts";
import { ADO_ORG, contosoRepos } from "../testing/scenario.ts";
import { adoCloneUrl, githubCloneUrl, measureLineChurn, wantsCopy } from "./copies.ts";
import { deriveFacts } from "./derive.ts";

/** A repo whose PR merged on 03-05 with ten product lines; four were rewritten on 03-13. */
function history() {
  const repo = new GitRepo();
  repo.commit("2026-03-01T10:00:00Z", "Start", { "src/a.ts": GitRepo.lines(3, "base") });
  repo.run("checkout", "--quiet", "-b", "feat");
  const one = repo.commit("2026-03-02T10:00:00Z", "Add the thing", {
    "src/a.ts": GitRepo.lines(3, "base") + GitRepo.lines(10, "feat"),
  });
  const two = repo.commit("2026-03-03T10:00:00Z", "Test the thing", {
    "test/a.test.ts": GitRepo.lines(5, "test"),
  });
  repo.run("checkout", "--quiet", "main");
  repo.at("2026-03-05T10:00:00Z", "merge", "--quiet", "--no-ff", "-m", "Merge PR 1: thing", "feat");
  const merge = repo.run("rev-parse", "HEAD");
  repo.commit("2026-03-13T10:00:00Z", "Rework the thing", {
    "src/a.ts": `${GitRepo.lines(3, "base")}${GitRepo.lines(4, "again")}${GitRepo.lines(10, "feat").split("\n").slice(4).join("\n")}`,
  });
  return { repo, merge, one, two };
}

describe("an Azure DevOps repo with a local copy [rule 16]", () => {
  const { repo: git, merge, one, two } = history();
  const [billing] = contosoRepos(Date.parse("2026-06-01T00:00:00Z"));
  const template = billing?.prs.find((p) => p.pr.status === "completed");
  if (!billing || !template) throw new Error("scenario lacks a completed PR");
  const payload: AdoPayload = {
    ...template,
    pr: {
      ...template.pr,
      creationDate: "2026-03-02T09:00:00Z",
      closedDate: "2026-03-05T10:00:00Z",
      lastMergeCommit: { commitId: merge },
    },
    commits: [
      { commitId: two, comment: "Test the thing", author: { date: "2026-03-03T10:00:00Z" } },
      { commitId: one, comment: "Add the thing", author: { date: "2026-03-02T10:00:00Z" } },
    ],
    // What Azure DevOps would answer, if it were asked: deliberately wrong, so the test shows
    // the copy is what's read.
    files: [{ path: "src/a.ts", additions: 999, deletions: 999 }],
  };
  const server = new AdoServer([{ ...billing, prs: [payload] }]);
  let client: AdoClient;
  const copy = join(mkdtempSync(join(tmpdir(), "codeflow-copies-")), "billing.git");

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
    await updateCopy({ dir: copy, url: git.dir, access: {}, github: false });
  });
  afterAll(() => server.stop());

  it("reads a PR's size and its commits' lines from the copy, not the API, then line churn", async () => {
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
    if (!repo) throw new Error("billing not found");
    const calls = server.calls.length;
    await syncAdoRepo({
      client,
      store,
      runId: store.startRun("sync"),
      repo,
      since: "2026-01-01",
      startedAt: "2026-06-01T00:00:00Z",
      copy,
    });
    expect(server.calls.slice(calls).some((c) => /filediffs|\/changes$/.test(c))).toBe(false);
    const [stored] = [...store.latestPrs()];
    const saved = stored?.payload as AdoPayload;
    expect(saved.filesFrom).toBe("local copy");
    expect(saved.files).toEqual([
      { path: "src/a.ts", additions: 10, deletions: 0 },
      { path: "test/a.test.ts", additions: 5, deletions: 0 },
    ]);
    expect(saved.commits.map((c) => [c.additions, c.parents])).toEqual([
      [5, 1],
      [10, 1],
    ]);

    const config = parseConfig(
      `sources:\n  - ado: ${ADO_ORG}\n    project: Platform\nsince: 2026-01-01\nlocal_copies: ["*/*/billing"]\n`,
    );
    const [storedRepo] = store.repos();
    if (!storedRepo) throw new Error("no repo stored");
    const asOf = new Date("2026-06-01T00:00:00Z");
    expect(await measureLineChurn({ store, repo: storedRepo, config, dir: copy, asOf })).toBe(1);
    // Measured once per window: a second run has nothing left to do.
    expect(await measureLineChurn({ store, repo: storedRepo, config, dir: copy, asOf })).toBe(0);
    deriveFacts(store, config);
    const [fact] = store.facts();
    expect(fact).toMatchObject({ sizeLines: 10, churnAddedLines: 10, rewrittenLines: 4 });
  });

  /** Syncs the repo with the copy, with this PR on the server instead of the usual one. */
  async function readWith(replace: Partial<AdoPayload["pr"]>) {
    const put = { ...payload, pr: { ...payload.pr, ...replace } };
    server.put("billing", put);
    const store = Store.open(":memory:");
    const {
      repos: [adoRepo],
    } = await discoverAdo(client, {
      kind: "ado",
      organization: ADO_ORG,
      project: "Platform",
      include: ["billing"],
      exclude: [],
      forks: false,
    });
    if (!adoRepo) throw new Error("billing not found");
    const outcome = await syncAdoRepo({
      client,
      store,
      runId: store.startRun("sync"),
      repo: adoRepo,
      since: "2026-01-01",
      startedAt: "2026-06-01T00:00:00Z",
      copy,
    });
    server.put("billing", payload);
    const [stored] = [...store.latestPrs()];
    return { outcome, saved: stored?.payload as AdoPayload };
  }

  it("says nothing of the copy when it served the PR [rule 16]", async () => {
    const { outcome, saved } = await readWith({});
    expect(saved.filesFrom).toBe("local copy");
    expect(saved.copyNote).toBeUndefined();
    expect(outcome.walks.flatMap((w) => w.copyMisses ?? [])).toEqual([]);
  });

  it("says why a PR was read through Azure DevOps when the copy lacks its merge commit [rule 16]", async () => {
    const missing = "a".repeat(40);
    const { outcome, saved } = await readWith({ lastMergeCommit: { commitId: missing } });
    expect(saved.filesFrom).toBe("api");
    expect(saved.files?.length).toBeGreaterThan(0);
    expect(saved.copyNote).toMatch(/doesn't hold its merge commit aaaaaaaa/);
    expect(outcome.walks.flatMap((w) => w.copyMisses ?? [])).toEqual([
      { number: payload.pr.pullRequestId, why: saved.copyNote },
    ]);
  });

  it("says both reasons when neither the copy nor Azure DevOps could size a PR [rule 16]", async () => {
    server.refuseDiffs = true;
    try {
      const { saved } = await readWith({ lastMergeCommit: { commitId: "b".repeat(40) } });
      expect(saved.files).toBeNull();
      expect(saved.filesError).toMatch(/403/);
      expect(saved.filesError).toMatch(/and the local copy doesn't hold its merge commit bbbbbbbb/);
    } finally {
      server.refuseDiffs = false;
    }
  });

  it("says an abandoned PR has no commits in a copy, and a completed one with no merge commit [rule 16]", async () => {
    const abandoned = await readWith({ status: "abandoned" });
    expect(abandoned.saved.copyNote).toMatch(/abandoned PR/);
    const bare = await readWith({ lastMergeCommit: undefined });
    expect(bare.saved.copyNote).toMatch(/Azure DevOps names none/);
  });
});

describe("an Azure DevOps PR with hundreds of files, in a repo with a branch name too long to store [rule 16]", () => {
  const FILES = 320; // past the 300 files Azure DevOps's own API is asked about
  const long = `story/develop/${"x".repeat(300)}`;
  const repo = new GitRepo();
  repo.commit("2026-03-01T10:00:00Z", "Start", { "src/a.ts": "a\n" });
  repo.run("checkout", "--quiet", "-b", "wide");
  const wide = repo.commit(
    "2026-03-02T10:00:00Z",
    "Touch a lot",
    Object.fromEntries(
      Array.from({ length: FILES }, (_, i) => [`src/gen/f${i}.ts`, `${i}\n${i}\n`]),
    ),
  );
  repo.run("checkout", "--quiet", "main");
  repo.at("2026-03-05T10:00:00Z", "merge", "--quiet", "--no-ff", "-m", "Merge PR 1: wide", "wide");
  const merge = repo.run("rev-parse", "HEAD");
  repo.run("checkout", "--quiet", "-b", "scratch");
  const stranded = repo.commit("2026-03-06T10:00:00Z", "Only on the long branch", {
    "src/s.ts": "s\n",
  });
  repo.run("checkout", "--quiet", "main");
  repo.run("branch", "-D", "scratch");
  repo.packedBranch(long, stranded);

  const [billing] = contosoRepos(Date.parse("2026-06-01T00:00:00Z"));
  const template = billing?.prs.find((p) => p.pr.status === "completed");
  if (!billing || !template) throw new Error("scenario lacks a completed PR");
  const payload: AdoPayload = {
    ...template,
    pr: {
      ...template.pr,
      creationDate: "2026-03-02T09:00:00Z",
      closedDate: "2026-03-05T10:00:00Z",
      lastMergeCommit: { commitId: merge },
    },
    commits: [{ commitId: wide, comment: "Touch a lot", author: { date: "2026-03-02T10:00:00Z" } }],
    files: [{ path: "src/gen/f0.ts", additions: 1, deletions: 1 }],
  };
  const server = new AdoServer([{ ...billing, prs: [payload] }]);
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

  it("is sized in full from the copy, which a branch name no longer stops from updating", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "codeflow-wide-")), "billing.git");
    await updateCopy({ dir, url: repo.dir, access: {}, github: false });

    const store = Store.open(":memory:");
    const {
      repos: [adoRepo],
    } = await discoverAdo(client, {
      kind: "ado",
      organization: ADO_ORG,
      project: "Platform",
      include: ["billing"],
      exclude: [],
      forks: false,
    });
    if (!adoRepo) throw new Error("billing not found");
    const calls = server.calls.length;
    await syncAdoRepo({
      client,
      store,
      runId: store.startRun("sync"),
      repo: adoRepo,
      since: "2026-01-01",
      startedAt: "2026-06-01T00:00:00Z",
      copy: dir,
    });
    // Azure DevOps was never asked for the files or their lines.
    expect(server.calls.slice(calls).some((c) => /filediffs|\/changes$/.test(c))).toBe(false);
    const [stored] = [...store.latestPrs()];
    const saved = stored?.payload as AdoPayload;
    expect(saved.filesFrom).toBe("local copy");
    expect(saved.files).toHaveLength(FILES);
    expect(saved.files?.reduce((n, f) => n + f.additions, 0)).toBe(FILES * 2);
  });
});

describe("which repos have a local copy, and where git fetches them", () => {
  it("follows local_copies patterns, ignoring case", () => {
    const config = { local_copies: ["acme/api", "contoso/*/billing*"] };
    expect(wantsCopy(config, "ACME/api")).toBe(true);
    expect(wantsCopy(config, "contoso/Platform/billing-v2")).toBe(true);
    expect(wantsCopy(config, "acme/web")).toBe(false);
    expect(wantsCopy({ local_copies: [] }, "acme/api")).toBe(false);
  });

  it("knows GitHub's, an Enterprise Server's and Azure DevOps's addresses", () => {
    expect(githubCloneUrl("https://api.github.com", "acme/api")).toBe(
      "https://github.com/acme/api.git",
    );
    expect(githubCloneUrl("https://git.acme.test/api/v3", "acme/api")).toBe(
      "https://git.acme.test/acme/api.git",
    );
    expect(adoCloneUrl("https://dev.azure.com/contoso", "My Project", "billing")).toBe(
      "https://dev.azure.com/contoso/My%20Project/_git/billing",
    );
  });
});
