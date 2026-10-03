import { describe, expect, it } from "vitest";
import {
  inPeriod,
  isComplete,
  lastCompletePeriod,
  parsePeriod,
  periodContaining,
} from "./periods.ts";
import { minObservations, percentile, percentileStat } from "./stats.ts";

describe("minObservations", () => {
  it("asks for five observations beyond the percentile, on whichever side is thinner", () => {
    expect([0.05, 0.25, 0.5, 0.75, 0.85, 0.9, 0.95].map(minObservations)).toEqual([
      100, 20, 10, 20, 34, 50, 100,
    ]);
  });
});

describe("percentile", () => {
  it("interpolates between ranks", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 0.75)).toBe(40);
    expect(percentile([7], 0.9)).toBe(7);
  });
});

describe("percentileStat", () => {
  it("hides a percentile with too few observations, counting values rather than PRs", () => {
    const tooFew = [1, 2, 3, 4, 5, 6, 7, 8, 9, null, null, null];
    expect(percentileStat(tooFew, 0.5)).toEqual({
      value: null,
      n: 9,
      hidden: "too few PRs for a median (9, needs 10)",
    });
    expect(percentileStat([...tooFew, 10], 0.5)).toEqual({ value: 5.5, n: 10 });
  });
});

describe("periods", () => {
  it("parses months, quarters and years", () => {
    expect(parsePeriod("2026-09")).toEqual({
      kind: "month",
      label: "September 2026",
      start: "2026-09-01",
      end: "2026-10-01",
    });
    expect(parsePeriod("2026-Q4")).toEqual({
      kind: "quarter",
      label: "Q4 2026",
      start: "2026-10-01",
      end: "2027-01-01",
    });
    expect(parsePeriod("2026")).toMatchObject({ start: "2026-01-01", end: "2027-01-01" });
    expect(parsePeriod("2026-13")).toBeNull();
    expect(parsePeriod("last month")).toBeNull();
  });

  it("finds the last complete period before a date", () => {
    const asOf = new Date("2026-10-02T18:39:00Z");
    expect(lastCompletePeriod("month", asOf).label).toBe("September 2026");
    expect(lastCompletePeriod("quarter", asOf).label).toBe("Q3 2026");
    expect(lastCompletePeriod("year", asOf).label).toBe("2025");
    expect(periodContaining("quarter", asOf).label).toBe("Q4 2026");
  });

  it("includes a timestamp from the first instant to before the next period", () => {
    const september = parsePeriod("2026-09");
    if (!september) throw new Error("unreachable");
    expect(inPeriod(september, "2026-09-01T00:00:00Z")).toBe(true);
    expect(inPeriod(september, "2026-09-30T23:59:59Z")).toBe(true);
    expect(inPeriod(september, "2026-10-01T00:00:00Z")).toBe(false);
    expect(inPeriod(september, null)).toBe(false);
    expect(isComplete(september, new Date("2026-10-01T00:00:00Z"))).toBe(true);
    expect(isComplete(september, new Date("2026-09-30T12:00:00Z"))).toBe(false);
  });
});
