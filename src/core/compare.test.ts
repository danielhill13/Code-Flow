import { describe, expect, it } from "vitest";
import type { MetricValue } from "./aggregate.ts";
import { change, changeArrow, changeShort, changeText } from "./compare.ts";

const v = (key: string, value: number | null): MetricValue => ({
  key,
  value,
  n: 20,
  notApplicable: 0,
});
const text = (key: string, now: number | null, before: number | null, complete = true) => {
  const previous = before === null ? null : v(key, before);
  return changeText(change(v(key, now), previous, complete), previous);
};

describe("change", () => {
  it("writes a relative move with its direction and baseline", () => {
    expect(text("cycle", 70, 31)).toBe("↑ 126% from 31.0 h");
    expect(text("merged", 343, 319)).toBe("↑ 8% from 319");
    expect(text("pickup", 8.3, 8.9)).toBe("↓ 7% from 8.9 h");
  });

  it("moves shares in percentage points, with a decimal under ten", () => {
    expect(text("repushed", 0.46, 0.5)).toBe("↓ 4.0 pts from 50%");
    expect(text("abandoned", 0.32, 0.22)).toBe("↑ 10 pts from 22%");
  });

  it("calls a move too small to mean anything the same", () => {
    expect(text("reviewsPerPr", 2, 2)).toBe("same as before (2)");
    expect(text("cycle", 14.9, 15.3)).toBe("same as before (15.3 h)");
    expect(text("reviewed", 0.981, 0.978)).toBe("same as before (98%)");
  });

  it("says why there is no change rather than inventing one", () => {
    expect(text("merged", 40, 120, false)).toBe("period not over");
    expect(text("cycle", 30, null)).toBe("no earlier data");
    expect(text("cycle", null, 30)).toBe("");
    expect(text("merged", 3, 0)).toBe("↑ from 0");
  });

  it("shortens for a table column, or to just the arrow", () => {
    expect(changeShort(change(v("cycle", 2.9), v("cycle", 4.1)))).toBe("↓ 29%");
    expect(changeShort(change(v("repushed", 0.56), v("repushed", 0.46)))).toBe("↑ 10 pts");
    expect(changeShort(change(v("cycle", 2.9), v("cycle", 2.9)))).toBe("same");
    expect(changeArrow(change(v("merged", 64), v("merged", 50)))).toBe("↑");
    expect(changeArrow(change(v("merged", 50), v("merged", 50)))).toBe("");
  });
});
