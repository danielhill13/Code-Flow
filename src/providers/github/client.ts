import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";

const PluggedOctokit = Octokit.plugin(throttling, retry);

/** Retries per request after GitHub says to back off. */
const MAX_RATE_LIMIT_RETRIES = 3;

export type GraphqlBudget = { limit: number; remaining: number; resetAt: Date };
export type GraphqlError = { type?: string; message: string };

/**
 * Every GitHub call goes through here, so calls and GraphQL points are counted in one place.
 * Rate limits are handled by Octokit's throttling plugin: it waits out primary and secondary
 * limits instead of failing.
 */
export class GitHubClient {
  readonly stats = { calls: 0, points: 0 };
  readonly #octokit: InstanceType<typeof PluggedOctokit>;

  constructor(options: {
    token: string;
    apiUrl: string;
    userAgent: string;
    onWait?: (message: string) => void;
  }) {
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
      throttle: {
        onRateLimit: onLimit("rate limit"),
        onSecondaryRateLimit: onLimit("secondary rate limit"),
      },
    });
  }

  /** Runs a query. Include `rateLimit { cost }` in it and its points are counted. */
  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    this.stats.calls += 1;
    const data = await this.#octokit.graphql<T>(query, variables);
    const cost = (data as { rateLimit?: { cost?: unknown } }).rateLimit?.cost;
    if (typeof cost === "number") this.stats.points += cost;
    return data;
  }

  /**
   * What `query` would cost, without running it or spending points. The query must declare
   * `$dryRun: Boolean!` and select `rateLimit(dryRun: $dryRun) { cost }`.
   */
  async cost(query: string, variables: Record<string, unknown>): Promise<number> {
    this.stats.calls += 1;
    const data = await this.#octokit.graphql<{ rateLimit: { cost: number } }>(query, {
      ...variables,
      dryRun: true,
    });
    return data.rateLimit.cost;
  }

  /**
   * The token's OAuth scopes (null for fine-grained and app tokens, which have none) and the
   * GraphQL budget. `GET /rate_limit` is free: it does not count against any limit.
   */
  async budget(): Promise<{ scopes: string[] | null; graphql: GraphqlBudget | null }> {
    this.stats.calls += 1;
    const { data, headers } = await this.#octokit.request("GET /rate_limit");
    const scopes = headers["x-oauth-scopes"];
    const graphql = data.resources.graphql;
    return {
      scopes:
        typeof scopes === "string"
          ? scopes
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : null,
      graphql: graphql
        ? {
            limit: graphql.limit,
            remaining: graphql.remaining,
            resetAt: new Date(graphql.reset * 1000),
          }
        : null,
    };
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
