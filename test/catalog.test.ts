// Keeps the promises about tests true. Every measurement rule in docs/architecture.md has a test
// tagged with it, and the test-case catalog in docs/testing.md lists exactly the tests there are.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./scenarios/support.ts";

/** Every test file, with its text. */
const tests = ["src", "test"].flatMap((dir) =>
  (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
    .filter((file) => /\.(test\.tsx?|spec\.ts)$/.test(file))
    .map((file) => ({ file: join(dir, file), text: readFileSync(join(ROOT, dir, file), "utf8") })),
);

describe("the measurement rules", () => {
  const architecture = readFileSync(join(ROOT, "docs/architecture.md"), "utf8");
  const section = architecture.split("## Measurement rules")[1]?.split("\n## ")[0] ?? "";
  const rules = [...section.matchAll(/^(\d+)\. \*\*(.+?)\*\*/gm)].map((m) => ({
    n: Number(m[1]),
    name: m[2] ?? "",
  }));

  it("are read from docs/architecture.md", () => {
    expect(rules.length).toBeGreaterThanOrEqual(12);
  });

  it("each have a test tagged [rule N]", () => {
    const untested = rules.filter(({ n }) => !tests.some((t) => t.text.includes(`[rule ${n}]`)));
    expect(
      untested.map(({ n, name }) => `rule ${n}: ${name}`),
      "Tag a test that proves the rule, by ending its title with [rule N]",
    ).toEqual([]);
  });
});

describe("the test-case catalog", () => {
  const catalog = readFileSync(join(ROOT, "docs/testing.md"), "utf8");
  const documented = [...catalog.matchAll(/^\| (TC-\d{3}) \|/gm)].map((m) => m[1]);
  const titled = tests.flatMap(({ file, text }) =>
    [...text.matchAll(/(?:it|test)\(\s*["'`](TC-\d{3}) /g)].map((m) => ({ id: m[1], file })),
  );

  it("names each test case once", () => {
    const ids = titled.map((t) => t.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    expect(documented.filter((id, i) => documented.indexOf(id) !== i)).toEqual([]);
  });

  it("lists every test case there is, and none that isn't", () => {
    const ids = new Set(titled.map((t) => t.id));
    expect(
      titled.filter((t) => !documented.includes(t.id)).map((t) => `${t.id} (${t.file})`),
      "Add these to the catalog in docs/testing.md",
    ).toEqual([]);
    expect(
      documented.filter((id) => !ids.has(id)),
      "These are in docs/testing.md but no test has them",
    ).toEqual([]);
  });
});
