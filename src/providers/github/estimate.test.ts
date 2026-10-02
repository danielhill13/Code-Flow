import { describe, expect, it } from "vitest";
import { repo } from "../../testing/factories.ts";
import { estimateBackfill, searchQueries } from "./estimate.ts";

describe("searchQueries", () => {
  it("ORs up to 20 repos into each search", () => {
    const repos = Array.from({ length: 45 }, (_, i) => repo(`r${i}`));
    const queries = searchQueries(repos, "2025-10-01");

    expect(queries).toHaveLength(3);
    expect(queries[0]).toMatch(/^repo:acme\/r0 repo:acme\/r1 .* repo:acme\/r19 is:pr/);
    expect(queries[2]).toBe(
      "repo:acme/r40 repo:acme/r41 repo:acme/r42 repo:acme/r43 repo:acme/r44 " +
        "is:pr updated:>=2025-10-01",
    );
  });
});

describe("estimateBackfill", () => {
  it("needs a page per 25 PRs, plus one per repo", () => {
    expect(estimateBackfill({ prs: 2552, repos: 1, pageCost: 2, hourlyLimit: 5000 })).toEqual({
      pages: 104,
      points: 208,
      shareOfHour: 208 / 5000,
    });
  });

  it("is bounded by latency while the hourly budget lasts", () => {
    const estimate = estimateBackfill({
      prs: 2552,
      repos: 1,
      pageCost: 2,
      hourlyLimit: 5000,
      secondsPerPage: 5,
    });
    expect(estimate.seconds).toBe(520);
  });

  it("is bounded by the rate limit once points exceed the hourly budget", () => {
    // 10,001 pages × 2 points = 20,002 points: four full hours, then one page.
    const estimate = estimateBackfill({
      prs: 250_000,
      repos: 1,
      pageCost: 2,
      hourlyLimit: 5000,
      secondsPerPage: 0.1,
    });
    expect(estimate.points).toBe(20_002);
    expect(estimate.seconds).toBeCloseTo(4 * 3600 + 0.1);
  });
});
