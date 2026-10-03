import { describe, expect, it } from "vitest";
import { repo } from "../../testing/factories.ts";
import { estimateBackfill, repoQualifiers } from "./estimate.ts";

describe("repoQualifiers", () => {
  it("ORs up to 20 repos into each search", () => {
    const repos = Array.from({ length: 45 }, (_, i) => repo(`r${i}`));
    const chunks = repoQualifiers(repos);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatch(/^repo:acme\/r0 repo:acme\/r1 .* repo:acme\/r19$/);
    expect(chunks[2]).toBe("repo:acme/r40 repo:acme/r41 repo:acme/r42 repo:acme/r43 repo:acme/r44");
  });
});

describe("estimateBackfill", () => {
  const base = { olderOpen: 0, repos: 1, pageCost: 2, hourlyLimit: 5000 };

  it("needs a page per 25 PRs, plus two per repo for partial pages", () => {
    expect(estimateBackfill({ ...base, updated: 2552, olderOpen: 30 })).toEqual({
      pages: 107,
      points: 214,
      shareOfHour: 214 / 5000,
    });
  });

  it("is bounded by latency while the hourly budget lasts", () => {
    expect(estimateBackfill({ ...base, updated: 2552, secondsPerPage: 5 }).seconds).toBe(525);
  });

  it("is bounded by the rate limit once points exceed the hourly budget", () => {
    // 10,002 pages × 2 points = 20,004 points: four full hours, then two pages.
    const estimate = estimateBackfill({ ...base, updated: 250_000, secondsPerPage: 0.1 });
    expect(estimate.points).toBe(20_004);
    expect(estimate.seconds).toBeCloseTo(4 * 3600 + 0.2);
  });
});
