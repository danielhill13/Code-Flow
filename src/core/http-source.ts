// The report's DataSource over HTTP, for `codeflow serve`: the same calls EmbeddedSource answers
// in the page, answered by the server running the same view builders (decisions D5, D18).
import type { PrFact } from "./facts.ts";
import type { DataSource, Meta } from "./source.ts";
import type { CompareModel, CompareQuery } from "./views/compare.ts";
import type { ViewQuery } from "./views/context.ts";
import type { FlowModel } from "./views/flow.ts";
import type { OverviewModel } from "./views/overview.ts";
import type { PrListModel, PrQuery } from "./views/prs.ts";
import type { ReviewModel } from "./views/review.ts";
import type { SpeedModel } from "./views/speed.ts";

/** A failed call, with the server's own explanation. */
export class ServerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Calls the API of one org: `base` is like "/api/orgs/acme". */
export async function call<T>(
  base: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const response = await fetchImpl(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.method && init.method !== "GET" && { "x-codeflow": "1" }),
      ...(init.body !== undefined && { "content-type": "application/json" }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  const value = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const message = (value as { error?: string } | null)?.error ?? response.statusText;
    throw new ServerError(response.status, message);
  }
  return value as T;
}

export class HttpSource implements DataSource {
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(base: string, fetchImpl: typeof fetch = (...args) => fetch(...args)) {
    this.#base = base;
    this.#fetch = fetchImpl;
  }

  async meta(): Promise<Meta> {
    const { meta } = await call<{ meta: Meta | null }>(this.#base, "/meta", {}, this.#fetch);
    if (!meta) throw new ServerError(404, "Nothing synced yet for this org.");
    return meta;
  }

  overview(q: ViewQuery): Promise<OverviewModel> {
    return this.#view("overview", q);
  }

  speed(q: ViewQuery): Promise<SpeedModel> {
    return this.#view("speed", q);
  }

  review(q: ViewQuery): Promise<ReviewModel> {
    return this.#view("review", q);
  }

  flow(q: ViewQuery): Promise<FlowModel> {
    return this.#view("flow", q);
  }

  compare(q: CompareQuery): Promise<CompareModel> {
    return this.#view("compare", q);
  }

  prs(q: PrQuery): Promise<PrListModel> {
    return this.#view("prs", q);
  }

  pr(id: string): Promise<PrFact | null> {
    return call(this.#base, `/prs/${encodeURIComponent(id)}`, {}, this.#fetch);
  }

  #view<T>(name: string, query: unknown): Promise<T> {
    return call(this.#base, `/views/${name}`, { method: "POST", body: query }, this.#fetch);
  }
}
