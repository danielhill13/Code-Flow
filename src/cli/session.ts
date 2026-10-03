import { dirname, resolve } from "node:path";
import { loadConfig } from "../config/load.ts";
import type { Config } from "../config/schema.ts";
import { hostFromApiUrl, resolveToken, type TokenKind } from "../providers/github/auth.ts";
import { GitHubClient, type GraphqlBudget, httpStatus } from "../providers/github/client.ts";
import { VIEWER } from "../providers/github/queries.ts";
import { VERSION } from "../version.ts";
import { dim, num, plural, status } from "./format.ts";

export type Print = (line?: string) => void;

export type Session = {
  config: Config;
  /** The SQLite database, inside the config's data_dir. */
  dbPath: string;
  client: GitHubClient;
  login: string;
  budget: GraphqlBudget;
};

const TOKEN_KINDS: Record<TokenKind, string> = {
  classic: "classic personal access token",
  "fine-grained": "fine-grained personal access token",
  oauth: "OAuth token",
  "app-installation": "GitHub App installation token",
  "app-user": "GitHub App user token",
  unknown: "token",
};

/** data_dir is relative to the config file, so commands work from any directory. */
export function databasePath(configPath: string, config: Config): string {
  return resolve(dirname(resolve(configPath)), config.data_dir, "codeflow.db");
}

/**
 * Loads the config and checks the token with GitHub, printing a line for each. Returns null,
 * after saying why, if GitHub rejects the token.
 */
export async function connect(
  configPath: string,
  print: Print,
  options: { explainScopes?: boolean } = {},
): Promise<Session | null> {
  const config = await loadConfig(configPath);
  print(
    status(
      "ok",
      "Config",
      `${configPath}: ${plural(config.sources.length, "source")}, since ${config.since}`,
    ),
  );

  const token = await resolveToken({
    tokenEnv: config.github.token_env,
    host: hostFromApiUrl(config.github.api_url),
  });
  const client = new GitHubClient({
    token: token.value,
    apiUrl: config.github.api_url,
    userAgent: `codeflow/${VERSION}`,
    onWait: (message) => print(status("warn", "Waiting", message)),
  });

  let viewer: ViewerData;
  try {
    viewer = await client.graphql<ViewerData>(VIEWER);
  } catch (err) {
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
  return { config, dbPath: databasePath(configPath, config), client, login, budget };
}

type ViewerData = {
  viewer: { login: string };
  rateLimit: { remaining: number; limit: number; resetAt: string };
};

export const clock = (date: Date) =>
  date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
