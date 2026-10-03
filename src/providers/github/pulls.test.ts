import { describe, expect, it } from "vitest";
import { type GitHubClient, IncompleteResponseError } from "./client.ts";
import { completeConnections, fetchPrPage, type GhPullRequest } from "./pulls.ts";

type Vars = Record<string, unknown>;

/** A GitHub client whose every query is answered by `respond`. */
const fakeClient = (respond: (vars: Vars) => unknown): Pick<GitHubClient, "graphql"> => ({
  graphql: async <T>(_query: string, vars: Vars = {}) => (await respond(vars)) as T,
});

const connection = (nodes: unknown[], endCursor: string | null = null, total = nodes.length) => ({
  totalCount: total,
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
  nodes,
});

const files = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => ({ path: `f${from + i}` }));

const repo = { owner: "acme", name: "api" };
const firstPage = { after: null, states: null, direction: "DESC" } as const;

describe("completeConnections", () => {
  it("fetches the rest of a connection past its first 100 nodes", async () => {
    const pr: GhPullRequest = {
      id: "PR_1",
      number: 1,
      state: "MERGED",
      updatedAt: "2026-01-01T00:00:00Z",
      commits: connection([]),
      reviews: connection([]),
      comments: connection([]),
      timelineItems: connection([]),
      files: connection(files(0, 100), "f1", 250),
    };
    const requests: Vars[] = [];
    const client = fakeClient((vars) => {
      requests.push(vars);
      return vars.after === "f1"
        ? { node: { files: connection(files(100, 200), "f2", 250) } }
        : { node: { files: connection(files(200, 250), null, 250) } };
    });

    await completeConnections(client, pr);

    expect(pr.files.nodes).toEqual(files(0, 250));
    expect(pr.files.pageInfo.hasNextPage).toBe(false);
    expect(requests).toEqual([
      { id: "PR_1", after: "f1" },
      { id: "PR_1", after: "f2" },
    ]);
  });
});

describe("fetchPrPage", () => {
  it("halves the page size while GitHub times out", async () => {
    const sizes: unknown[] = [];
    const client = fakeClient((vars) => {
      sizes.push(vars.first);
      if (Number(vars.first) > 7) throw Object.assign(new Error("Bad Gateway"), { status: 502 });
      return { repository: { pullRequests: connection([], "c1") } };
    });

    const page = await fetchPrPage(client, repo, firstPage);

    expect(sizes).toEqual([25, 13, 7]);
    expect(page).toEqual({ prs: [], endCursor: "c1", hasNextPage: true });
  });

  it("treats GitHub's GraphQL timeout message like a gateway timeout", async () => {
    const sizes: unknown[] = [];
    const timeout = {
      errors: [{ message: "Something went wrong. This may be the result of a timeout." }],
    };
    const client = fakeClient((vars) => {
      sizes.push(vars.first);
      if (vars.first === 25) throw Object.assign(new Error("timeout"), timeout);
      return { repository: { pullRequests: connection([]) } };
    });

    await fetchPrPage(client, repo, firstPage);
    expect(sizes).toEqual([25, 13]);
  });

  it("shrinks a page whose responses keep arriving cut off", async () => {
    const sizes: unknown[] = [];
    const client = fakeClient((vars) => {
      sizes.push(vars.first);
      if (vars.first === 25) throw new IncompleteResponseError();
      return { repository: { pullRequests: connection([]) } };
    });

    await fetchPrPage(client, repo, firstPage);
    expect(sizes).toEqual([25, 13]);
  });

  it("does not retry other errors", async () => {
    let calls = 0;
    const client = fakeClient(() => {
      calls += 1;
      throw Object.assign(new Error("forbidden"), {
        errors: [{ type: "FORBIDDEN", message: "Resource not accessible" }],
      });
    });

    await expect(fetchPrPage(client, repo, firstPage)).rejects.toThrow("forbidden");
    expect(calls).toBe(1);
  });
});
