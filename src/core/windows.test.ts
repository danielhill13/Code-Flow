import { describe, expect, it } from "vitest";
import { bucketsOf, covers, grainOf, shiftBack, windowOf } from "./windows.ts";

// A Saturday evening, with milliseconds, as a sync's start time looks.
const asOf = new Date("2026-10-03T00:12:08.928Z");

describe("windowOf", () => {
  it("ends a rolling window when the data does, to the second, and compares the same length", () => {
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

  it("compares year to date with the same span a year earlier", () => {
    const { current, previous } = windowOf("ytd", asOf);
    expect(current).toMatchObject({ start: "2026-01-01T00:00:00Z", end: "2026-10-03T00:12:08Z" });
    expect(previous).toEqual({
      start: "2025-01-01T00:00:00Z",
      end: "2025-10-03T00:12:08Z",
      label: "the same span of 2025",
    });
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

  it("reads year to date by month once 13 weeks have passed, and by week before", () => {
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
