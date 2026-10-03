import { afterEach, describe, expect, it, vi } from "vitest";
import { Progress } from "./progress.ts";

/** A stream that records what is written to it. */
function fakeStream(options: { isTTY: boolean; columns?: number }) {
  const written: string[] = [];
  const stream = { ...options, write: (text: string) => written.push(text) > 0 };
  return { stream: stream as unknown as NodeJS.WriteStream, written };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Progress", () => {
  it("rewrites one line in place on a terminal, cut to the terminal's width", () => {
    const { stream, written } = fakeStream({ isTTY: true, columns: 12 });
    const progress = new Progress(stream);

    progress.update("acme/api: backfill, 25 PRs");
    progress.update("acme/api: done");
    progress.clear();
    progress.clear(); // nothing left to clear

    expect(written).toEqual(["\r\x1b[2Kacme/api: b", "\r\x1b[2Kacme/api: d", "\r\x1b[2K"]);
  });

  it("prints at most every 30 seconds elsewhere, so logs show it is alive without flooding", () => {
    vi.useFakeTimers({ now: 0 });
    const { stream, written } = fakeStream({ isTTY: false });
    const progress = new Progress(stream);

    progress.update("page 1");
    vi.setSystemTime(10_000);
    progress.update("page 2");
    vi.setSystemTime(40_000);
    progress.update("page 3");
    progress.clear(); // nothing to clear in a log

    expect(written).toEqual(["page 1\n", "page 3\n"]);
  });
});
