import { describe, expect, it } from "vitest";
import {
  bucketsOf,
  calendarChoices,
  covers,
  grainOf,
  isWindowKey,
  shiftBack,
  windowOf,
} from "./windows.ts";

// A Saturday evening, with milliseconds, as a sync's start time looks.
const asOf = new Date("2026-10-03T00:12:08.928Z");

describe("windowOf", () => {
  it("ends a rolling window when the data does, to the second, and compares the same length [rule 7]", () => {
    expect(windowOf("30d", asOf)).toEqual({
      key: "30d",
      current: {
        start: "2026-09-03T00:12:08Z",
        end: "2026-10-03T00:12:08Z",
        label: "last 30 days",
      },
      previous: {
        start: "2026-08-04T00:12:08Z",
        end: "2026-09-03T00:12:08Z",
        label: "the previous 30 days",
      },
    });
  });

  it("compares year to date with the same span a year earlier [rule 7]", () => {
    const { current, previous } = windowOf("ytd", asOf);
    expect(current).toMatchObject({ start: "2026-01-01T00:00:00Z", end: "2026-10-03T00:12:08Z" });
    expect(previous).toEqual({
      start: "2025-01-01T00:00:00Z",
      end: "2025-10-03T00:12:08Z",
      label: "the same days of 2025",
    });
  });
});

describe("periods to date, and calendar periods [rule 7]", () => {
  it("compares month and quarter to date with the same days of the one before", () => {
    expect(windowOf("mtd", asOf)).toMatchObject({
      current: {
        start: "2026-10-01T00:00:00Z",
        end: "2026-10-03T00:12:08Z",
        label: "month to date",
      },
      previous: {
        start: "2026-09-01T00:00:00Z",
        end: "2026-09-03T00:12:08Z",
        label: "the same days of September 2026",
      },
    });
    expect(windowOf("qtd", asOf)).toMatchObject({
      current: { start: "2026-10-01T00:00:00Z", label: "quarter to date" },
      previous: { start: "2026-07-01T00:00:00Z", end: "2026-07-03T00:12:08Z" },
    });
    // March 31 to date: all of February, no further.
    expect(windowOf("mtd", new Date("2026-03-31T12:00:00Z")).previous).toMatchObject({
      start: "2026-02-01T00:00:00Z",
      end: "2026-03-01T00:00:00Z",
    });
    // A quarter to date in January compares with the previous year's last quarter.
    expect(windowOf("qtd", new Date("2026-01-10T00:00:00Z")).previous).toMatchObject({
      start: "2025-10-01T00:00:00Z",
      label: "the same days of Q4 2025",
    });
  });

  it("takes a whole month, quarter or year, against the one before", () => {
    expect(windowOf("2026-09", asOf)).toMatchObject({
      current: {
        start: "2026-09-01T00:00:00Z",
        end: "2026-10-01T00:00:00Z",
        label: "September 2026",
      },
      previous: {
        start: "2026-08-01T00:00:00Z",
        end: "2026-09-01T00:00:00Z",
        label: "August 2026",
      },
    });
    expect(windowOf("2026-Q1", asOf)).toMatchObject({
      current: { start: "2026-01-01T00:00:00Z", end: "2026-04-01T00:00:00Z", label: "Q1 2026" },
      previous: { start: "2025-10-01T00:00:00Z", label: "Q4 2025" },
    });
    expect(windowOf("2025", asOf)).toMatchObject({
      current: { start: "2025-01-01T00:00:00Z", end: "2026-01-01T00:00:00Z", label: "2025" },
      previous: { label: "2024" },
    });
  });

  it("runs a period not over yet to the data, against the same days of the one before", () => {
    expect(windowOf("2026-10", asOf)).toMatchObject({
      current: { end: "2026-10-03T00:12:08Z", label: "October 2026 so far" },
      previous: { start: "2026-09-01T00:00:00Z", end: "2026-09-03T00:12:08Z" },
    });
  });

  it("reads quarters by week and years by month", () => {
    expect(grainOf(windowOf("2026-Q3", asOf))).toBe("week");
    expect(grainOf(windowOf("2026-Q1", asOf))).toBe("week");
    expect(grainOf(windowOf("2025", asOf))).toBe("month");
    expect(bucketsOf(windowOf("2025", asOf))).toHaveLength(12);
  });

  it("knows a window's key, and offers each period the data reaches", () => {
    for (const key of ["30d", "mtd", "qtd", "ytd", "2026-09", "2026-Q3", "2025"]) {
      expect(isWindowKey(key)).toBe(true);
    }
    for (const key of ["2026-13", "2026-Q5", "7d", "26", "2026-9"])
      expect(isWindowKey(key)).toBe(false);
    const { months, quarters, years } = calendarChoices("2025-11-15", asOf);
    expect(months.map((m) => m.key)).toEqual([
      "2026-10",
      "2026-09",
      "2026-08",
      "2026-07",
      "2026-06",
      "2026-05",
      "2026-04",
      "2026-03",
      "2026-02",
      "2026-01",
      "2025-12",
      "2025-11",
    ]);
    expect(quarters.map((q) => q.label)).toEqual([
      "Q4 2026",
      "Q3 2026",
      "Q2 2026",
      "Q1 2026",
      "Q4 2025",
    ]);
    expect(years.map((y) => y.key)).toEqual(["2026", "2025"]);
  });
});

describe("bucketsOf", () => {
  it("cuts a window into whole Monday weeks, the last one still running", () => {
    const buckets = bucketsOf(windowOf("30d", asOf));
    expect(buckets.map((b) => b.short)).toEqual(["Aug 31", "Sep 7", "Sep 14", "Sep 21", "Sep 28"]);
    expect(buckets[0]).toEqual({
      start: "2026-08-31T00:00:00Z",
      end: "2026-09-07T00:00:00Z",
      label: "week of Aug 31",
      short: "Aug 31",
      partial: false,
    });
    expect(buckets.at(-1)).toMatchObject({
      start: "2026-09-28T00:00:00Z",
      end: "2026-10-03T00:12:08Z",
      partial: true,
    });
  });

  it("reads year to date by month once 14 weeks have passed, and by week before", () => {
    const october = windowOf("ytd", asOf);
    expect(grainOf(october)).toBe("month");
    const months = bucketsOf(october);
    expect(months.map((b) => b.short)).toEqual([
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
    ]);
    expect(months[8]).toMatchObject({ label: "September 2026", partial: false });
    expect(months[9]).toMatchObject({ end: "2026-10-03T00:12:08Z", partial: true });

    const february = windowOf("ytd", new Date("2026-02-20T12:00:00Z"));
    expect(grainOf(february)).toBe("week");
    // 2026 began on a Thursday: the first week starts in December 2025.
    expect(bucketsOf(february)[0]).toMatchObject({ start: "2025-12-29T00:00:00Z" });
  });

  it("ends a window that closes on a Monday at midnight with a whole week, not an empty one", () => {
    const buckets = bucketsOf(windowOf("30d", new Date("2026-09-28T00:00:00Z")));
    expect(buckets.at(-1)).toMatchObject({ short: "Sep 21", partial: false });
  });
});

describe("shiftBack", () => {
  it("moves a span back by whole days, saying which days it now covers", () => {
    expect(shiftBack(windowOf("30d", asOf).current, 30)).toEqual({
      start: "2026-08-04T00:12:08Z",
      end: "2026-09-03T00:12:08Z",
      label: "Aug 4 – Sep 3",
    });
  });
});

describe("covers", () => {
  it("covers a span only from the first covered day on", () => {
    expect(covers("2025-10-01", { start: "2025-10-01T00:00:00Z" })).toBe(true);
    expect(covers("2025-10-01", { start: "2025-09-30T23:59:59Z" })).toBe(false);
  });
});
