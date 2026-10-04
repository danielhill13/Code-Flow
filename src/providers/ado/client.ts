// Azure DevOps's REST API, for one organization (decision D40). Every call goes through here: it
// signs requests, counts them, and paces them so a sync stays well inside Azure DevOps's rate
// limits (decision D41): one request at a time, at most two a second, slower when the server's
// rate-limit headers say so, and a full stop for as long as it asks when it throttles. It turns a
// refusal into a message that says what to do.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CodeflowError } from "../../errors.ts";
import { isLoopback } from "../github/auth.ts";

export const API_VERSION = "7.1";

/** Older Azure DevOps Servers don't know 7.1: these are tried in turn when one says so. */
const OLDER_VERSIONS = ["7.0", "6.0"];

/** Azure DevOps's own application id: the resource an Entra token for it is issued for. */
const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

export type AdoToken = {
  /** The Authorization header's value. */
  authorization: string;
  /** Where it came from: "$AZURE_DEVOPS_TOKEN", "az account get-access-token". */
  source: string;
  kind: "personal access token" | "Microsoft Entra token";
};

type Env = Record<string, string | undefined>;

/**
 * Finds a token without the user pasting one anywhere: the configured variable, then
 * AZURE_DEVOPS_EXT_PAT (what the Azure CLI's DevOps extension reads), then a sign-in with the
 * Azure CLI. A token in a variable is a personal access token; the Azure CLI's is an Entra one.
 */
export async function resolveAdoToken(options: {
  tokenEnv: string;
  env?: Env;
  azToken?: () => Promise<string | undefined>;
}): Promise<AdoToken> {
  const env = options.env ?? process.env;
  for (const name of new Set([options.tokenEnv, "AZURE_DEVOPS_EXT_PAT"])) {
    const value = env[name]?.trim();
    if (value) {
      return {
        authorization: `Basic ${Buffer.from(`:${value}`).toString("base64")}`,
        source: `$${name}`,
        kind: "personal access token",
      };
    }
  }
  const entra = await (options.azToken ?? readAzToken)();
  if (entra) {
    return {
      authorization: `Bearer ${entra}`,
      source: "az account get-access-token",
      kind: "Microsoft Entra token",
    };
  }
  throw new CodeflowError(
    `No Azure DevOps token found. Set ${options.tokenEnv} to a personal access token with ` +
      "Code (Read), or sign in with the Azure CLI: az login",
  );
}

async function readAzToken(): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)(
      "az",
      [
        "account",
        "get-access-token",
        "--resource",
        ADO_RESOURCE,
        "--query",
        "accessToken",
        "-o",
        "tsv",
      ],
      { timeout: 15_000 },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined; // the Azure CLI is not installed, or not signed in
  }
}

type Query = Record<string, string | number | undefined>;

/** A failed call, with the HTTP status. */
export class AdoError extends CodeflowError {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** How many times to wait out throttling on one call before giving up. */
const MAX_WAITS = 5;

/**
 * The least time between two requests: at most two a second. Azure DevOps meters each user's
 * use over a five-minute window; a sync this steady stays far below it, the way codeflow's
 * earlier tooling did for a year without a single throttle.
 */
export const PACE_MS = 500;

/**
 * When the server says how much of its budget is left (X-RateLimit-Remaining, in its own units),
 * below this share of the limit codeflow waits a little longer between requests.
 */
const LOW_BUDGET = 0.2;

export class AdoClient {
  readonly stats = { calls: 0 };
  /** https://dev.azure.com/<organization>, or a server's collection address. */
  readonly base: string;
  readonly organization: string;
  readonly #authorization: string;
  readonly #fetch: typeof fetch;
  readonly #onWait: ((message: string) => void) | undefined;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  /** The least time between requests; none for an organization on this machine (a test's). */
  readonly #pace: number;
  /** Requests wait their turn here: never two at once. */
  #queue: Promise<unknown> = Promise.resolve();
  /** The earliest time the next request may start. */
  #nextAt = 0;
  /** The API version this server accepts: 7.1, or older for an older Azure DevOps Server. */
  #version = API_VERSION;

  constructor(options: {
    url: string;
    organization: string;
    token: AdoToken;
    fetch?: typeof fetch;
    onWait?: (message: string) => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    /** Milliseconds between requests; default PACE_MS, or none for a server on this machine. */
    paceMs?: number;
  }) {
    this.organization = options.organization;
    this.base = `${options.url.replace(/\/+$/, "")}/${encodeURIComponent(options.organization)}`;
    this.#authorization = options.token.authorization;
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
    this.#onWait = options.onWait;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? Date.now;
    this.#pace = options.paceMs ?? (isLoopback(this.base) ? 0 : PACE_MS);
  }

  /** Whether this organization is on this machine: a test's fake, never Azure DevOps itself. */
  get local(): boolean {
    return isLoopback(this.base);
  }

  /** GET a path under the organization, such as `/_apis/projects`. */
  async get<T>(path: string, query: Query = {}): Promise<T> {
    return (await this.#call<T>("GET", path, query)).body;
  }

  async post<T>(path: string, body: unknown, query: Query = {}): Promise<T> {
    return (await this.#call<T>("POST", path, query, body)).body;
  }

  /** Every item of a list the API pages with continuation tokens. */
  async list<T>(path: string, query: Query = {}): Promise<T[]> {
    const items: T[] = [];
    let token: string | undefined;
    do {
      const { body, continuation } = await this.#call<{ value: T[] }>("GET", path, {
        ...query,
        continuationToken: token,
      });
      items.push(...(body.value ?? []));
      token = continuation ?? undefined;
    } while (token);
    return items;
  }

  /** Runs requests one at a time, in the order they were asked for. */
  #call<T>(
    method: string,
    path: string,
    query: Query,
    body?: unknown,
  ): Promise<{ body: T; continuation: string | null }> {
    const run = this.#queue.then(() => this.#send<T>(method, path, query, body));
    this.#queue = run.catch(() => {});
    return run;
  }

  /** Waits until the pace allows another request. */
  async #turn(): Promise<void> {
    const wait = this.#nextAt - this.#now();
    if (wait > 0) await this.#sleep(wait);
    this.#nextAt = this.#now() + this.#pace;
  }

  /**
   * Reads Azure DevOps's advice from a response: X-RateLimit-Delay asks for a pause outright, and
   * a nearly spent budget (X-RateLimit-Remaining of X-RateLimit-Limit) earns a longer gap.
   */
  #heed(response: Response): void {
    const delay = Number(response.headers.get("x-ratelimit-delay") ?? "");
    const remaining = Number(response.headers.get("x-ratelimit-remaining") ?? "");
    const limit = Number(response.headers.get("x-ratelimit-limit") ?? "");
    let pause = 0;
    if (delay > 0) pause = delay * 1000;
    if (limit > 0 && remaining >= 0 && remaining < limit * LOW_BUDGET) {
      pause = Math.max(pause, 5 * Math.max(this.#pace, PACE_MS));
    }
    if (pause > 0) {
      this.#nextAt = Math.max(this.#nextAt, this.#now() + pause);
      if (pause >= 2000) {
        this.#onWait?.(
          `Azure DevOps's rate limit is getting close; pausing ${Math.round(pause / 1000)}s`,
        );
      }
    }
  }

  async #send<T>(
    method: string,
    path: string,
    query: Query,
    body?: unknown,
  ): Promise<{ body: T; continuation: string | null }> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    for (let waits = 0; ; waits++) {
      params.set("api-version", this.#version);
      const url = `${this.base}${path}?${params}`;
      await this.#turn();
      this.stats.calls += 1;
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers: {
            authorization: this.#authorization,
            accept: "application/json",
            ...(body !== undefined && { "content-type": "application/json" }),
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
          redirect: "manual",
        });
      } catch (err) {
        throw new CodeflowError(
          `Couldn't reach Azure DevOps at ${this.base} (${(err as Error).message}). Check the network, or the server address.`,
        );
      }
      this.#heed(response);
      if ((response.status === 429 || response.status === 503) && waits < MAX_WAITS) {
        const seconds = Number(response.headers.get("retry-after") ?? "") || 2 ** waits * 5;
        this.#onWait?.(`Azure DevOps asked to slow down; waiting ${seconds}s`);
        this.#nextAt = Math.max(this.#nextAt, this.#now() + seconds * 1000);
        continue;
      }
      // An expired or wrong token gets a sign-in page (a redirect), or 401 / 203 with HTML.
      const type = response.headers.get("content-type") ?? "";
      if (
        response.status === 401 ||
        response.status === 203 ||
        (response.status >= 300 && response.status < 400) ||
        (response.ok && !type.includes("json"))
      ) {
        throw new AdoError(
          401,
          `Azure DevOps (${this.organization}) refused the token: expired, revoked, or without Code (Read)?`,
        );
      }
      if (!response.ok) {
        const text = await response.text();
        let message = text.slice(0, 300);
        try {
          message = (JSON.parse(text) as { message?: string }).message ?? message;
        } catch {
          // not JSON: keep the text
        }
        // An older server says it doesn't know this version: step down and ask again.
        const next =
          this.#version === API_VERSION
            ? OLDER_VERSIONS[0]
            : OLDER_VERSIONS[OLDER_VERSIONS.indexOf(this.#version) + 1];
        if (response.status === 400 && /api.?version|out of range/i.test(message) && next) {
          this.#version = next;
          continue;
        }
        throw new AdoError(response.status, `Azure DevOps said ${response.status}: ${message}`);
      }
      return {
        body: (await response.json()) as T,
        continuation: response.headers.get("x-ms-continuationtoken"),
      };
    }
  }
}
