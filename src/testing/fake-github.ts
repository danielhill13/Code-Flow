import type { GhPullRequest, Page, PageRequest, PrState } from "../providers/github/pulls.ts";

const empty = () => ({
  totalCount: 0,
  pageInfo: { hasNextPage: false, endCursor: null },
  nodes: [],
});

/**
 * One repo's pull requests, listed the way GitHub lists them: ordered by updatedAt, paged with
 * keyset cursors. A PR that changes moves to the top of the order, and a cursor stays valid
 * after changes, as on GitHub.
 */
export class FakeGitHub {
  readonly requests: PageRequest[] = [];
  readonly pageSize: number;
  readonly #idPrefix: string;
  readonly #prs = new Map<number, GhPullRequest>();

  /** `idPrefix` keeps PR ids unique across fake repos, as GitHub's node ids are. */
  constructor(pageSize = 2, idPrefix = "PR") {
    this.pageSize = pageSize;
    this.#idPrefix = idPrefix;
  }

  /** Adds a PR, or changes one: its new updatedAt moves it in the order. */
  set(number: number, updatedAt: string, state: PrState = "MERGED"): void {
    this.#prs.set(number, {
      id: `${this.#idPrefix}_${number}`,
      number,
      state,
      updatedAt,
      commits: empty(),
      reviews: empty(),
      comments: empty(),
      files: empty(),
      timelineItems: empty(),
    });
  }

  /** Adds a whole PR as GitHub would return it, or replaces one with the same number. */
  put(pr: GhPullRequest): void {
    this.#prs.set(pr.number, structuredClone(pr));
  }

  /** Every PR, as stored. */
  all(): GhPullRequest[] {
    return [...this.#prs.values()];
  }

  /** What discovery would report as the repo's last PR activity. */
  get lastPrActivity(): string | null {
    const times = [...this.#prs.values()].map((pr) => pr.updatedAt).sort();
    return times.at(-1) ?? null;
  }

  /** Every PR's current version, as `number@updatedAt`, in number order. */
  current(filter: (pr: GhPullRequest) => boolean = () => true): string[] {
    return [...this.#prs.values()]
      .filter(filter)
      .sort((a, b) => a.number - b.number)
      .map((pr) => `${pr.number}@${pr.updatedAt}`);
  }

  readonly fetchPage = async (request: PageRequest, size = this.pageSize): Promise<Page> => {
    this.requests.push(request);
    const sign = request.direction === "DESC" ? -1 : 1;
    const compare = (a: Key, b: Key) =>
      sign * (a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
    const listed = [...this.#prs.values()]
      .filter((pr) => request.states === null || request.states.includes(pr.state))
      .sort(compare);
    const cursor = request.after ? (JSON.parse(request.after) as [string, string]) : null;
    const remaining = cursor
      ? listed.filter((pr) => compare(pr, { updatedAt: cursor[0], id: cursor[1] }) > 0)
      : listed;
    const prs = remaining.slice(0, size);
    const last = prs.at(-1);
    return {
      prs: structuredClone(prs),
      endCursor: last ? JSON.stringify([last.updatedAt, last.id]) : null,
      hasNextPage: remaining.length > prs.length,
    };
  };
}

type Key = { updatedAt: string; id: string };
