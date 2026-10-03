import { setTimeout as sleep } from "node:timers/promises";
import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";

const PluggedOctokit = Octokit.plugin(throttling, retry);

/** Retries per request after GitHub says to back off. */
const MAX_RATE_LIMIT_RETRIES = 3;

/** Retries of a query whose response arrived incomplete. */
const MAX_INCOMPLETE_RETRIES = 2;

export type GraphqlBudget = { limit: number; remaining: number; resetAt: Date };
export type GraphqlError = { type?: string; message: string };

/**
 * GitHub answered 200 OK, but the body was not a complete GraphQL response. Seen in practice
 * on pages of very large PRs: a 1.2 MB response cut off at a quarter of its length, with nothing
 * at the HTTP level to say so. Octokit then returns undefined instead of throwing.
 */
export class IncompleteResponseError extends Error {
  constructor() {
    super("GitHub sent an incomplete response");
    this.name = "IncompleteResponseError";
  }
}

/**
 * Every GitHub call goes through here, so calls and GraphQL points are counted in one place.
 * Rate limits are handled by Octokit's throttling plugin: it waits out primary and secondary
 * limits instead of failing. Server errors are retried by Octokit's retry plugin; incomplete
 * responses are retried here.
 */
export class GitHubClient {
  readonly stats = { calls: 0, points: 0 };
  /** GraphQL points left, as of the latest response that said. */
  remaining: number | null = null;
  readonly #octokit: InstanceType<typeof PluggedOctokit>;
  readonly #onWait: ((message: string) => void) | undefined;
  readonly #retryDelayMs: number;

  constructor(options: {
    token: string;
    apiUrl: string;
    userAgent: string;
    onWait?: (message: string) => void;
    /** Replaces the network, for tests. */
    fetch?: typeof globalThis.fetch;
    /** Delay before retrying an incomplete response, per attempt. Tests set it to 0. */
    retryDelayMs?: number;
    /**
     * Octokit's pacing, on by default. It sends GraphQL requests at most one per second, the
     * spacing GitHub asks for between writes. codeflow only reads, so this is conservative; it
     * costs little because a page of PRs takes longer than that anyway. Tests turn it off.
     */
    pacing?: boolean;
  }) {
    this.#onWait = options.onWait;
    this.#retryDelayMs = options.retryDelayMs ?? 1000;
    const onLimit =
      (kind: string) =>
      (
        retryAfter: number,
        request: { method: string; url: string },
        _: unknown,
        retries: number,
      ) => {
        options.onWait?.(
          `GitHub ${kind} on ${request.method} ${request.url}; waiting ${retryAfter}s`,
        );
        return retries < MAX_RATE_LIMIT_RETRIES;
      };
    this.#octokit = new PluggedOctokit({
      auth: options.token,
      baseUrl: options.apiUrl.replace(/\/+$/, ""),
      userAgent: options.userAgent,
      throttle:
        options.pacing === false
          ? { enabled: false }
          : {
              onRateLimit: onLimit("rate limit"),
              onSecondaryRateLimit: onLimit("secondary rate limit"),
            },
      ...(options.fetch && { request: { fetch: options.fetch } }),
    });
  }

  /**
   * Runs a query. Include `rateLimit { cost }` in it and its points are counted. Throws
   * IncompleteResponseError if every attempt came back incomplete.
   */
  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      this.stats.calls += 1;
      const data: unknown = await this.#octokit.graphql<T>(query, variables);
      if (data !== null && typeof data === "object") {
        const { rateLimit } = data as { rateLimit?: { cost?: unknown; remaining?: unknown } };
        if (typeof rateLimit?.cost === "number") this.stats.points += rateLimit.cost;
        if (typeof rateLimit?.remaining === "number") this.remaining = rateLimit.remaining;
        return data as T;
      }
      if (attempt > MAX_INCOMPLETE_RETRIES) throw new IncompleteResponseError();
      this.#onWait?.(
        `GitHub sent an incomplete response; retrying (${attempt} of ${MAX_INCOMPLETE_RETRIES})`,
      );
      await sleep(this.#retryDelayMs * attempt);
    }
  }

  /**
   * What `query` would cost, without running it or spending points. The query must declare
   * `$dryRun: Boolean!` and select `rateLimit(dryRun: $dryRun) { cost }`.
   */
  async cost(query: string, variables: Record<string, unknown>): Promise<number> {
    this.stats.calls += 1;
    const data: unknown = await this.#octokit.graphql(query, { ...variables, dryRun: true });
    const cost = (data as { rateLimit?: { cost?: unknown } } | undefined)?.rateLimit?.cost;
    if (typeof cost !== "number") throw new IncompleteResponseError();
    return cost;
  }

  /**
   * The token's OAuth scopes; null for fine-grained and app tokens, which have none. Read from
   * the headers of `GET /rate_limit`, which costs nothing. Its body's `graphql` bucket is
   * ignored: for some tokens (the GitHub CLI's, for one) it shows a fresh, unused budget while
   * GraphQL's own `rateLimit` field shows points being spent. The latter is the real one.
   */
  async scopes(): Promise<string[] | null> {
    this.stats.calls += 1;
    const { headers } = await this.#octokit.request("GET /rate_limit");
    const scopes = headers["x-oauth-scopes"];
    if (typeof scopes !== "string") return null;
    return scopes
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
  }
}

/** The GraphQL errors attached to a failed query, or undefined for any other failure. */
export function graphqlErrors(err: unknown): GraphqlError[] | undefined {
  if (err instanceof Error && "errors" in err && Array.isArray(err.errors)) {
    return err.errors as GraphqlError[];
  }
  return undefined;
}

/** The HTTP status of a failed request, if it got that far. */
export function httpStatus(err: unknown): number | undefined {
  if (err instanceof Error && "status" in err && typeof err.status === "number") return err.status;
  return undefined;
}
