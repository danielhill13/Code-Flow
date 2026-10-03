import { styleText } from "node:util";

export type Mark = "ok" | "warn" | "fail" | "info";

const MARKS = {
  ok: () => styleText("green", "✓"),
  warn: () => styleText("yellow", "!"),
  fail: () => styleText("red", "✗"),
  info: () => " ",
} satisfies Record<Mark, () => string>;

/** `✓ Token       danielhill13 via gh auth token`: a mark, a fixed-width label, the detail. */
export function status(mark: Mark, label: string, detail: string): string {
  return marked(mark, `${label.padEnd(11)} ${detail}`);
}

/** `✓ usebruno/bruno: …`: a mark and free text. */
export function marked(mark: Mark, text: string): string {
  return `${MARKS[mark]()} ${text}`;
}

export const dim = (text: string) => styleText("dim", text);
export const bold = (text: string) => styleText("bold", text);

import { num } from "../core/format.ts";

export { num };

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${num(n)} ${n === 1 ? one : many}`;

/** A run time: "12 s", "3 min", "1.5 h". */
export function durationSeconds(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

/** Plain-text table. Cells must not contain colour codes: they would throw off the padding. */
export function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  options: { rightAlign?: readonly number[]; indent?: string } = {},
): string {
  const right = new Set(options.rightAlign);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]) =>
    (options.indent ?? "") +
    cells
      .map((cell, i) =>
        right.has(i) ? cell.padStart(widths[i] ?? 0) : cell.padEnd(widths[i] ?? 0),
      )
      .join("  ")
      .trimEnd();
  return [dim(line(header)), ...rows.map(line)].join("\n");
}
