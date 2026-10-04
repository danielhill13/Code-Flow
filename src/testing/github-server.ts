// A fake GitHub API over HTTP, for tests that run the real CLI end to end without a network.
// It answers the GraphQL queries codeflow sends (queries.ts) from repos and PRs held in memory,
// pages them as GitHub does (FakeGitHub's keyset paging), and refuses any other token.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { GhPayload } from "../providers/github/normalize.ts";
import type { GhPullRequest, PrState } from "../providers/github/pulls.ts";
import { FakeGitHub } from "./fake-github.ts";

export type FakeRepo = {
  owner: string;
  name: string;
  defaultBranch: string;
  archived?: boolean;
  fork?: boolean;
  private?: boolean;
  prs: GhPayload[];
};

/** What the server was asked, by operation name: "Viewer", "PrPage"… */
export type Call = { operation: string; variables: Record<string, unknown> };

export class GitHubServer {
  readonly token: string;
  readonly calls: Call[] = [];
  readonly #repos = new Map<string, { repo: FakeRepo; prs: FakeGitHub }>();
  #server: Server | null = null;

  constructor(repos: readonly FakeRepo[], options: { token?: string } = {}) {
    this.token = options.token ?? "codeflow-test-token";
    for (const repo of repos) {
      const prs = new FakeGitHub(25, `${repo.owner}_${repo.name}`);
      for (const pr of repo.prs) prs.put(pr as unknown as GhPullRequest);
      this.#repos.set(`${repo.owner}/${repo.name}`.toLowerCase(), { repo, prs });
    }
  }

  /** Starts listening on a free port; returns the API URL to put in config's `github.api_url`. */
  async start(): Promise<string> {
    const server = createServer((req, res) => {
      this.#handle(req).then(
        ({ status, body, headers }) => {
          res.writeHead(status, { "content-type": "application/json", ...headers });
          res.end(JSON.stringify(body));
        },
        (err: unknown) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: String(err) }));
        },
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.#server = server;
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Adds a PR, or changes one: a new `updatedAt` moves it to the top, as on GitHub. */
  put(fullName: string, pr: GhPayload): void {
    const entry = this.#repos.get(fullName.toLowerCase());
    if (!entry) throw new Error(`No fake repo ${fullName}`);
    entry.prs.put(pr as unknown as GhPullRequest);
  }

  /** How many calls of one operation were made, since the start or since `from`. */
  count(operation: string, from = 0): number {
    return this.calls.slice(from).filter((c) => c.operation === operation).length;
  }

  async #handle(
    req: IncomingMessage,
  ): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
    const auth = req.headers.authorization ?? "";
    if (auth !== `token ${this.token}` && auth !== `bearer ${this.token}`) {
      return { status: 401, body: { message: "Bad credentials" } };
    }
    if (req.method === "GET" && req.url === "/rate_limit") {
      // A fine-grained token: no OAuth scopes header.
      return { status: 200, body: { resources: {} } };
    }
    if (req.method !== "POST" || req.url !== "/graphql") {
      return { status: 404, body: { message: "Not Found" } };
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const { query, variables = {} } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      query: string;
      variables?: Record<string, unknown>;
    };
    const operation = /query\s+(\w+)/.exec(query)?.[1] ?? "unknown";
    this.calls.push({ operation, variables });
    const data = await this.#answer(operation, variables);
    return { status: 200, body: { data: { rateLimit: RATE_LIMIT, ...data } } };
  }

  async #answer(operation: string, v: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (operation) {
      case "Viewer":
        return { viewer: { login: "codeflow-tester" } };
      case "OwnerRepos": {
        const owner = String(v.login).toLowerCase();
        const repos = [...this.#repos.values()].filter((e) => e.repo.owner.toLowerCase() === owner);
        if (repos.length === 0) return { repositoryOwner: null };
        return {
          repositoryOwner: {
            __typename: "Organization",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: repos
                .sort((a, b) => a.repo.name.localeCompare(b.repo.name))
                .map((e) => repoNode(e.repo, e.prs)),
            },
          },
        };
      }
      case "Repo": {
        const entry = this.#repos.get(`${v.owner}/${v.name}`.toLowerCase());
        return { repository: entry ? repoNode(entry.repo, entry.prs) : null };
      }
      case "SyncSearchCounts":
        return {
          updated: { issueCount: this.#search(String(v.updated)) },
          olderOpen: { issueCount: this.#search(String(v.olderOpen)) },
        };
      case "PrPage": {
        if (v.dryRun) return { repository: null };
        const entry = this.#repos.get(`${v.owner}/${v.name}`.toLowerCase());
        if (!entry) return { repository: null };
        const page = await entry.prs.fetchPage(
          {
            after: (v.after as string | null) ?? null,
            states: (v.states as PrState[] | null) ?? null,
            direction: v.direction === "ASC" ? "ASC" : "DESC",
          },
          Number(v.first),
        );
        return {
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
              nodes: page.prs,
            },
          },
        };
      }
      default:
        throw new Error(`The fake GitHub doesn't answer ${operation}`);
    }
  }

  /** Counts PRs for a search such as "repo:a/b repo:a/c is:pr is:open updated:<2026-01-01". */
  #search(text: string): number {
    const repos = [...text.matchAll(/repo:(\S+)/g)].map((m) => (m[1] ?? "").toLowerCase());
    const open = text.includes("is:open");
    const since = /updated:>=(\S+)/.exec(text)?.[1];
    const before = /updated:<(\S+)/.exec(text)?.[1];
    let count = 0;
    for (const name of repos) {
      for (const pr of this.#repos.get(name)?.prs.all() ?? []) {
        const updated = pr.updatedAt.slice(0, 10);
        if (open && pr.state !== "OPEN") continue;
        if (since && updated < since) continue;
        if (before && updated >= before) continue;
        count++;
      }
    }
    return count;
  }
}

const RATE_LIMIT = { cost: 1, remaining: 4999, limit: 5000, resetAt: "2099-01-01T00:00:00Z" };

function repoNode(repo: FakeRepo, prs: FakeGitHub) {
  const all = prs.all();
  const count = (state: string) => ({ totalCount: all.filter((p) => p.state === state).length });
  const latest = all
    .map((p) => p.updatedAt)
    .sort()
    .at(-1);
  return {
    id: `R_${repo.owner}_${repo.name}`,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    isArchived: repo.archived ?? false,
    isFork: repo.fork ?? false,
    isEmpty: false,
    isPrivate: repo.private ?? false,
    defaultBranchRef: { name: repo.defaultBranch },
    open: count("OPEN"),
    merged: count("MERGED"),
    closed: count("CLOSED"),
    latest: { nodes: latest ? [{ updatedAt: latest }] : [] },
  };
}
