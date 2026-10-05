import { relative } from "node:path";
import type { Config } from "../config/schema.ts";
import { loadWorkspace, type Org, pickOrgs, type Workspace } from "../config/workspace.ts";
import { CodeflowError } from "../errors.ts";
import { AdoClient, type AdoToken, resolveAdoToken } from "../providers/ado/client.ts";
import {
  hostFromApiUrl,
  isLoopback,
  resolveToken,
  type TokenKind,
} from "../providers/github/auth.ts";
import { GitHubClient, type GraphqlBudget, httpStatus } from "../providers/github/client.ts";
import { VIEWER } from "../providers/github/queries.ts";
import { VERSION } from "../version.ts";
import { dim, num, plural, status } from "./format.ts";

export type Print = (line?: string) => void;

/** Options every command takes: the workspace (or single config) file, and which org. */
export type OrgOptions = { config: string; org?: string };

/**
 * The orgs a command works on, from the workspace file. Commands about one org at a time pass
 * `one`: a workspace of several orgs then needs --org.
 */
export async function orgsFor(
  options: OrgOptions,
  one = false,
): Promise<{ workspace: Workspace; orgs: Org[] }> {
  const workspace = await loadWorkspace(options.config);
  return { workspace, orgs: pickOrgs(workspace, options.org, one) };
}

/** "Org acme", printed above each org's output when a command covers several. */
export function orgHeading(workspace: Workspace, org: Org, print: Print): void {
  if (workspace.single || workspace.orgs.length === 1) return;
  print(status("info", "Org", org.name));
}

export type Session = {
  org: Org;
  config: Config;
  /** The SQLite database, inside the config's data_dir. */
  dbPath: string;
  client: GitHubClient;
  login: string;
  budget: GraphqlBudget;
  /** For git, to fetch local copies (D46): never written anywhere. */
  token: string;
};

const TOKEN_KINDS: Record<TokenKind, string> = {
  classic: "classic personal access token",
  "fine-grained": "fine-grained personal access token",
  oauth: "OAuth token",
  "app-installation": "GitHub App installation token",
  "app-user": "GitHub App user token",
  unknown: "token",
};

/**
 * Checks an org's token with GitHub, printing a line for each step. Returns null, after saying
 * why, if GitHub rejects the token.
 */
export async function connect(
  org: Org,
  print: Print,
  options: { explainScopes?: boolean } = {},
): Promise<Session | null> {
  const { config } = org;
  print(
    status(
      "ok",
      "Config",
      `${relative(process.cwd(), org.files.org) || org.files.org}: ` +
        `${plural(config.sources.length, "source")}, since ${config.since}`,
    ),
  );

  const token = await resolveToken({
    tokenEnv: config.github.token_env,
    host: hostFromApiUrl(config.github.api_url),
  });
  const client = new GitHubClient({
    token: token.value,
    apiUrl: config.github.api_url,
    pacing: !isLoopback(config.github.api_url),
    userAgent: `codeflow/${VERSION}`,
    onWait: (message) => print(status("warn", "Waiting", message)),
  });

  let viewer: ViewerData;
  try {
    viewer = await client.graphql<ViewerData>(VIEWER);
  } catch (err) {
    if (unreachable(err)) {
      throw new CodeflowError(
        `Couldn't reach GitHub at ${config.github.api_url} (${(err as Error).message}). ` +
          `Check the network, or github.api_url in ${relative(process.cwd(), org.files.org) || org.files.org}.`,
      );
    }
    if (httpStatus(err) !== 401) throw err;
    print(
      status(
        "fail",
        "Token",
        `GitHub rejected the token from ${token.source}: expired or revoked?`,
      ),
    );
    return null;
  }
  const login = viewer.viewer.login;
  const budget: GraphqlBudget = {
    limit: viewer.rateLimit.limit,
    remaining: viewer.rateLimit.remaining,
    resetAt: new Date(viewer.rateLimit.resetAt),
  };
  const scopes = await client.scopes();
  print(status("ok", "Token", `${login} via ${token.source} (${TOKEN_KINDS[token.kind]})`));
  const writeScopes = scopes?.filter((scope) => !scope.startsWith("read:")) ?? [];
  if (options.explainScopes && writeScopes.length > 0) {
    print(
      status(
        "info",
        "",
        dim(
          `it can also write (${writeScopes.join(", ")}); codeflow only reads, ` +
            "so a read-only fine-grained token is enough",
        ),
      ),
    );
  }
  print(
    status(
      budget.remaining > 0 ? "ok" : "warn",
      "Rate limit",
      `${num(budget.remaining)} of ${num(budget.limit)} GraphQL points left, resets ${clock(budget.resetAt)}`,
    ),
  );
  return { org, config, dbPath: org.dbPath, client, login, budget, token: token.value };
}

type ViewerData = {
  viewer: { login: string };
  rateLimit: { remaining: number; limit: number; resetAt: string };
};

export const clock = (date: Date) =>
  date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** A request that never got an answer: no network, a wrong address, a refused connection. */
function unreachable(err: unknown): boolean {
  return (
    err instanceof Error &&
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|fetch failed|bad port/i.test(
      `${err.message} ${String((err as { cause?: unknown }).cause ?? "")}`,
    )
  );
}

/** What the web app shows about the connection to GitHub, before or after an org exists. */
export type GitHubCheck =
  | {
      ok: true;
      login: string;
      /** Where the token came from: "$GITHUB_TOKEN", "gh auth token". */
      source: string;
      kind: string;
      /** Scopes that could write; codeflow never uses them. Empty for fine-grained tokens. */
      writeScopes: string[];
      remaining: number;
      limit: number;
    }
  | { ok: false; error: string };

/**
 * Connects to GitHub as `github` says, quietly: a client to use and who it is, or a CodeflowError
 * saying what to do. For `serve`, where nothing prints to a terminal.
 */
export async function openGitHub(github: { api_url: string; token_env: string }): Promise<{
  client: GitHubClient;
  check: Extract<GitHubCheck, { ok: true }>;
}> {
  const token = await resolveToken({
    tokenEnv: github.token_env,
    host: hostFromApiUrl(github.api_url),
  });
  const client = new GitHubClient({
    token: token.value,
    apiUrl: github.api_url,
    pacing: !isLoopback(github.api_url),
    userAgent: `codeflow/${VERSION}`,
  });
  let viewer: ViewerData;
  try {
    viewer = await client.graphql<ViewerData>(VIEWER);
  } catch (err) {
    if (unreachable(err)) {
      throw new CodeflowError(
        `Couldn't reach GitHub at ${github.api_url} (${(err as Error).message}). Check the network, or the API address.`,
      );
    }
    if (httpStatus(err) === 401) {
      throw new CodeflowError(
        `GitHub rejected the token from ${token.source}: expired or revoked? Make a new one, or run: gh auth login`,
      );
    }
    throw err;
  }
  const scopes = await client.scopes();
  return {
    client,
    check: {
      ok: true,
      login: viewer.viewer.login,
      source: token.source,
      kind: TOKEN_KINDS[token.kind],
      writeScopes: scopes?.filter((scope) => !scope.startsWith("read:")) ?? [],
      remaining: viewer.rateLimit.remaining,
      limit: viewer.rateLimit.limit,
    },
  };
}

/** A client for each Azure DevOps organization an org's sources name, sharing one token. */
export type AdoConnection = {
  token: AdoToken;
  client(organization: string): AdoClient;
};

/**
 * Finds the Azure DevOps token, as the config says or the Azure CLI's sign-in, and prints where
 * it came from. Clients pace their own requests (decision D41).
 */
export async function connectAdo(
  config: Config,
  print: Print,
  options: { quiet?: boolean } = {},
): Promise<AdoConnection> {
  const token = await resolveAdoToken({ tokenEnv: config.azure_devops.token_env });
  if (!options.quiet) {
    print(status("ok", "ADO token", `token from ${token.source} (${token.kind})`));
  }
  const clients = new Map<string, AdoClient>();
  return {
    token,
    client(organization) {
      let client = clients.get(organization.toLowerCase());
      if (!client) {
        client = new AdoClient({
          url: config.azure_devops.url,
          organization,
          token,
          onWait: (message) => print(status("warn", "Waiting", message)),
        });
        clients.set(organization.toLowerCase(), client);
      }
      return client;
    },
  };
}

/** Who Azure DevOps says the token belongs to, in one organization: a cheap check that it works. */
export async function adoWhoAmI(client: AdoClient): Promise<string> {
  const data = await client.get<{ authenticatedUser?: { providerDisplayName?: string } }>(
    "/_apis/connectionData",
  );
  return data.authenticatedUser?.providerDisplayName ?? "someone";
}
