import { describe, expect, it } from "vitest";
import { GitHubClient, IncompleteResponseError } from "./client.ts";

const complete = JSON.stringify({
  data: { rateLimit: { cost: 2, remaining: 4000 }, viewer: { login: "octocat" } },
});
/** What GitHub sent in practice: a 200 with JSON content type and a body cut short. */
const cutOff = complete.slice(0, complete.length / 4);

/** A network that answers each request with the next body in line. */
function network(bodies: string[]) {
  let requests = 0;
  const fetch = async () => {
    requests += 1;
    return new Response(bodies.shift() ?? complete, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests: () => requests };
}

const client = (fetch: typeof globalThis.fetch, waits: string[] = []) =>
  new GitHubClient({
    token: "test",
    apiUrl: "https://api.github.com",
    userAgent: "codeflow-test",
    fetch,
    retryDelayMs: 0,
    pacing: false,
    onWait: (message) => waits.push(message),
  });

describe("GitHubClient.graphql", () => {
  it("retries a response that arrives cut off", async () => {
    const { fetch, requests } = network([cutOff]);
    const waits: string[] = [];
    const github = client(fetch, waits);

    await expect(github.graphql("query { viewer { login } }")).resolves.toMatchObject({
      viewer: { login: "octocat" },
    });
    expect(requests()).toBe(2);
    expect(waits).toEqual(["GitHub sent an incomplete response; retrying (1 of 2)"]);
    expect(github.stats).toEqual({ calls: 2, points: 2 });
    expect(github.remaining).toBe(4000);
  });

  it("gives up after two retries with an error that says what happened", async () => {
    const { fetch, requests } = network([cutOff, cutOff, cutOff]);

    await expect(client(fetch).graphql("query { viewer { login } }")).rejects.toBeInstanceOf(
      IncompleteResponseError,
    );
    expect(requests()).toBe(3);
  });
});
