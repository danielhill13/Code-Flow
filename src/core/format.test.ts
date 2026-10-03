import { describe, expect, it } from "vitest";
import { duration, names, waitingOnText } from "./format.ts";

describe("duration", () => {
  it("reads in minutes, hours, days, then whole days", () => {
    expect([0.25, 4.5, 50.4, 2399, 25_540].map(duration)).toEqual([
      "15 min",
      "4.5 h",
      "2.1 d",
      "100.0 d",
      "1,064 d",
    ]);
  });
});

describe("waitingOnText", () => {
  const asOf = new Date("2026-10-03T00:00:00Z");
  it("says whose move it is, and since when", () => {
    expect(
      waitingOnText(
        {
          waitingOn: {
            on: "reviewers",
            why: "requested",
            people: ["ana", "bo", "cy"],
            teams: ["core"],
          },
          waitingSince: "2026-09-21T00:00:00Z",
        },
        asOf,
      ),
    ).toBe("ana, bo +2 · asked 12.0 d ago");
    expect(
      waitingOnText({ waitingOn: { on: "author", why: "draft" }, waitingSince: null }, asOf),
    ).toBe("author · draft");
    expect(names(["ana"], ["core"])).toBe("ana, @core");
  });
});
