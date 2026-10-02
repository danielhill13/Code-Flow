import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CodeflowError } from "../../errors.ts";

export type TokenKind =
  | "classic"
  | "fine-grained"
  | "oauth"
  | "app-installation"
  | "app-user"
  | "unknown";

export type Token = { value: string; source: string; kind: TokenKind };

type Env = Record<string, string | undefined>;
type GhTokenReader = (host: string) => Promise<string | undefined>;

/** GitHub prefixes every token type; see "About authentication to GitHub". */
export function tokenKind(token: string): TokenKind {
  if (token.startsWith("github_pat_")) return "fine-grained";
  if (token.startsWith("ghp_")) return "classic";
  if (token.startsWith("gho_")) return "oauth";
  if (token.startsWith("ghs_")) return "app-installation";
  if (token.startsWith("ghu_")) return "app-user";
  return "unknown";
}

/** `https://api.github.com` → `github.com`; `https://ghe.acme.com/api/v3` → `ghe.acme.com`. */
export function hostFromApiUrl(apiUrl: string): string {
  const { hostname } = new URL(apiUrl);
  return hostname === "api.github.com" ? "github.com" : hostname;
}

/**
 * Finds a token without the user pasting one anywhere: the configured environment variable,
 * then GH_TOKEN, then the GitHub CLI's stored login.
 */
export async function resolveToken(options: {
  tokenEnv: string;
  host: string;
  env?: Env;
  readGhToken?: GhTokenReader;
}): Promise<Token> {
  const env = options.env ?? process.env;
  for (const name of new Set([options.tokenEnv, "GH_TOKEN"])) {
    const value = env[name]?.trim();
    if (value) return { value, source: `$${name}`, kind: tokenKind(value) };
  }
  const value = await (options.readGhToken ?? readGhToken)(options.host);
  if (value) return { value, source: "gh auth token", kind: tokenKind(value) };
  throw new CodeflowError(
    `No GitHub token found. Set ${options.tokenEnv}, or log in with the GitHub CLI: gh auth login`,
  );
}

async function readGhToken(host: string): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)("gh", ["auth", "token", "--hostname", host], {
      timeout: 10_000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined; // gh is not installed, or not logged in to this host
  }
}
