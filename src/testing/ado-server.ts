// A fake Azure DevOps over HTTP, for tests that sync Azure DevOps repos without a network. It
// answers the REST calls codeflow makes (providers/ado) from repos and PR payloads held in
// memory, pages PR lists as Azure DevOps does ($top, $skip), and refuses any other token.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AdoPayload } from "../providers/ado/types.ts";

export type FakeAdoRepo = {
  organization: string;
  project: string;
  name: string;
  id: string;
  /** "refs/heads/main"; absent for an empty repo. */
  defaultBranch?: string;
  disabled?: boolean;
  fork?: boolean;
  prs: AdoPayload[];
};

export class AdoServer {
  readonly token: string;
  /** Every request, as METHOD /path. */
  readonly calls: string[] = [];
  readonly #repos: FakeAdoRepo[];
  /** A token without Project and Team (Read): listing projects is refused, as Azure DevOps does. */
  readonly #noProjectScope: boolean;
  #server: Server | null = null;

  constructor(
    repos: readonly FakeAdoRepo[],
    options: { token?: string; noProjectScope?: boolean } = {},
  ) {
    this.token = options.token ?? "codeflow-ado-test-token";
    this.#noProjectScope = options.noProjectScope ?? false;
    this.#repos = repos.map((repo) => ({ ...repo, prs: [...repo.prs] }));
  }

  /** Starts on a free port; returns the address to put in `azure_devops.url`. */
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
    return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Adds a PR, or replaces the one with its id. */
  put(repoName: string, payload: AdoPayload): void {
    const repo = this.#repos.find((r) => r.name === repoName);
    if (!repo) throw new Error(`No fake repo ${repoName}`);
    repo.prs = [
      ...repo.prs.filter((p) => p.pr.pullRequestId !== payload.pr.pullRequestId),
      payload,
    ];
  }

  async #handle(
    req: IncomingMessage,
  ): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
    const url = new URL(req.url ?? "/", "http://fake");
    this.calls.push(`${req.method} ${url.pathname}`);
    const expected = `Basic ${Buffer.from(`:${this.token}`).toString("base64")}`;
    if (req.headers.authorization !== expected) {
      return { status: 401, body: { message: "TF400813: not authorized" } };
    }
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const [organization, ...rest] = parts;
    const inOrg = this.#repos.filter(
      (r) => r.organization.toLowerCase() === organization?.toLowerCase(),
    );
    const q = url.searchParams;
    const path = rest.join("/");

    if (path === "_apis/connectionData") {
      if (inOrg.length === 0) return { status: 404, body: { message: "organization not found" } };
      return {
        status: 200,
        body: { authenticatedUser: { providerDisplayName: "Codeflow Tester" } },
      };
    }
    if (path === "_apis/projects") {
      if (this.#noProjectScope) {
        return { status: 401, body: { message: "TF400813: not authorized for this scope" } };
      }
      const projects = [...new Set(inOrg.map((r) => r.project))];
      return {
        status: 200,
        body: { value: projects.map((name) => ({ name, state: "wellFormed" })) },
      };
    }
    const [project, apis, git, repositories, repoId, kind, prId, sub, iteration, changes] = rest;
    if (apis !== "_apis" || git !== "git" || repositories !== "repositories") {
      return { status: 404, body: { message: `fake ADO doesn't answer ${path}` } };
    }
    const inProject = inOrg.filter((r) => r.project === project);
    if (inProject.length === 0) {
      return {
        status: 404,
        body: { message: `TF200016: The following project does not exist: ${project}.` },
      };
    }
    if (!repoId) {
      return {
        status: 200,
        body: {
          value: inProject.map((r) => ({
            id: r.id,
            name: r.name,
            defaultBranch: r.defaultBranch,
            isDisabled: r.disabled ?? false,
            isFork: r.fork ?? false,
            project: { name: r.project },
          })),
        },
      };
    }
    const repo = inProject.find((r) => r.id === repoId);
    if (!repo) return { status: 404, body: { message: "repo not found" } };

    if (kind === "pullrequests" && !prId) {
      const status = q.get("searchCriteria.status") ?? "active";
      const minTime = q.get("searchCriteria.minTime");
      const closedRange = q.get("searchCriteria.queryTimeRangeType") === "closed";
      const listed = repo.prs
        .map((p) => p.pr)
        .filter((pr) => status === "all" || pr.status === status)
        .filter((pr) => !minTime || !closedRange || (pr.closedDate ?? "") >= minTime)
        .sort((a, b) => b.creationDate.localeCompare(a.creationDate));
      const skip = Number(q.get("$skip") ?? 0);
      const top = Number(q.get("$top") ?? 100);
      return { status: 200, body: { value: listed.slice(skip, skip + top) } };
    }
    if (kind === "filediffs" && req.method === "POST") {
      const body = JSON.parse(await text(req)) as {
        targetVersionCommit: string;
        fileDiffParams: { path: string; originalPath: string }[];
      };
      const payload = repo.prs.find(
        (p) => p.iterations.at(-1)?.sourceRefCommit?.commitId === body.targetVersionCommit,
      );
      return {
        status: 200,
        // Azure DevOps wraps every list it returns as { count, value }.
        body: wrapped(
          body.fileDiffParams.map((param) => {
            const path = (param.path || param.originalPath).replace(/^\//, "");
            const file = payload?.files?.find((f) => f.path === path);
            return {
              path: param.path,
              originalPath: param.originalPath,
              // Changed lines come as "edit" blocks, as Azure DevOps sends them; "none" blocks
              // are unchanged context and count for nothing.
              lineDiffBlocks: file
                ? [
                    { changeType: "none", modifiedLinesCount: 40, originalLinesCount: 40 },
                    {
                      changeType: "edit",
                      modifiedLinesCount: file.additions,
                      originalLinesCount: file.deletions,
                    },
                  ]
                : [],
            };
          }),
        ),
      };
    }
    if (kind === "pullRequests" && prId) {
      const payload = repo.prs.find((p) => String(p.pr.pullRequestId) === prId);
      if (!payload) return { status: 404, body: { message: "PR not found" } };
      switch (sub) {
        case "threads":
          return { status: 200, body: { value: payload.threads } };
        case "commits":
          return { status: 200, body: { value: payload.commits } };
        case "iterations":
          if (iteration && changes === "changes") {
            return {
              status: 200,
              body: {
                changeEntries: (payload.files ?? []).map((f) => ({
                  item: { path: `/${f.path}` },
                  changeType: "edit",
                })),
              },
            };
          }
          return { status: 200, body: { value: payload.iterations } };
      }
    }
    return { status: 404, body: { message: `fake ADO doesn't answer ${path}` } };
  }
}

async function text(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** A list as Azure DevOps returns it: wrapped, with its count. */
function wrapped<T>(value: T[]): { count: number; value: T[] } {
  return { count: value.length, value };
}
