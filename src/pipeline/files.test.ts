import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../config/load.ts";
import type { GhPayload } from "../providers/github/normalize.ts";
import { Store } from "../store/store.ts";
import { ghPayload } from "../testing/factories.ts";
import { extensionOf, fileUsage, foldersOf } from "./files.ts";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const config = (extra = "") =>
  parseConfig(`sources:\n  - owner: acme\nsince: 2026-01-01\n${extra}`);

const files = (...paths: string[]): NonNullable<GhPayload["files"]> => ({
  totalCount: paths.length,
  pageInfo: { hasNextPage: false, endCursor: null },
  nodes: paths.map((path) => ({ path, additions: 3, deletions: 1 })),
});

/** Two repos, each with the PRs given: [number, the paths it changes]. */
function setup(api: [number, string[]][], web: [number, string[]][] = [], truncated = false) {
  const store = Store.open(":memory:");
  stores.push(store);
  const run = store.startRun("sync");
  for (const [id, name, prs] of [
    ["R_1", "acme/api", api],
    ["R_2", "acme/web", web],
  ] as const) {
    store.upsertRepo({
      id,
      provider: "github",
      fullName: name,
      defaultBranch: "main",
      archived: false,
      fork: false,
      private: false,
    });
    store.savePage(
      id,
      prs.map(([number, paths]) => {
        const p = ghPayload({ id: `${id}_${number}`, number, files: files(...paths) });
        return { id: p.id, number, state: p.state, updatedAt: p.updatedAt, payload: p };
      }),
      run,
      {},
    );
  }
  if (truncated) {
    const p = ghPayload({
      id: "R_1_cut",
      number: 99,
      // GitHub says there are more files than it listed.
      files: { ...files("src/cut.ts"), totalCount: 5000 },
    });
    store.savePage(
      "R_1",
      [{ id: p.id, number: 99, state: p.state, updatedAt: p.updatedAt, payload: p }],
      run,
      {},
    );
  }
  return store;
}

const tree = (folder: string, n: number, ext = ".txt") =>
  Array.from({ length: n }, (_, i) => `${folder}/n${i}${ext}`);

describe("what an org's PRs change [rule 3]", () => {
  it("names the kind of a file and its folders", () => {
    expect(extensionOf("src/App.TSX")).toBe(".tsx");
    expect(extensionOf("archive.tar.gz")).toBe(".gz");
    expect(extensionOf("infra/Dockerfile")).toBe("Dockerfile");
    expect(extensionOf(".gitignore")).toBe(".gitignore");
    expect(foldersOf("thoughts/shared/x.md")).toEqual(["thoughts", "thoughts/shared"]);
    expect(foldersOf("src/a.ts")).toEqual(["src"]);
    expect(foldersOf("a.ts")).toEqual(["(repo root)"]);
  });

  it("tells a whole file name from an extension, to write the rule for it", async () => {
    const store = setup([[1, ["svc/Dockerfile", "web/.env.local", "src/a.ts", "src/b.ts"]]]);
    const rows = (await fileUsage(store, config())).extensions;
    const by = (name: string) => rows.find((row) => row.name === name);
    expect(by("Dockerfile")?.whole).toBe(true);
    expect(by(".local")?.whole).toBe(false);
    expect(by(".ts")?.whole).toBe(false);
  });

  it("shows a tree of many files per PR, flagged, until a rule says it isn't code", async () => {
    const store = setup([
      [1, ["src/a.ts", "src/b.ts", "test/a.test.ts", ...tree("research/data", 120)]],
      [2, ["src/c.ts", ...tree("research/data", 130)]],
      [3, ["src/d.ts", ...tree("research/more", 100)]],
    ]);
    const usage = await fileUsage(store, config());
    expect(usage.prs).toBe(3);
    const research = usage.folders.find((row) => row.name === "research");
    expect(research).toMatchObject({ changes: 350, prs: 3, perPr: 117, bulk: true });
    expect(research?.extensions).toEqual([".txt"]);
    expect(research?.examples).toHaveLength(2);
    // Real code is in the same list, and isn't flagged.
    expect(usage.folders.find((row) => row.name === "src")).toMatchObject({
      changes: 4,
      prs: 3,
      bulk: false,
    });
    expect(usage.extensions[0]).toMatchObject({ name: ".txt", changes: 350, bulk: true });
    expect(usage.codeChanges).toBe(usage.extensions.reduce((n, row) => n + row.changes, 0));

    // The org says it isn't code: it leaves the list, and shows under docs.
    const ruled = await fileUsage(
      store,
      config('paths:\n  - { match: "research/**", bucket: docs }\n'),
    );
    expect(ruled.folders.some((row) => row.name === "research")).toBe(false);
    expect(ruled.byBucket.find((b) => b.bucket === "docs")?.changes).toBe(350);
  });

  it("counts a thoughts tree as notes already, and each bucket's changes", async () => {
    const store = setup([
      [1, ["src/a.ts", "logo.png", "README.md", ...tree("thoughts/plans", 40, ".md")]],
    ]);
    const usage = await fileUsage(store, config());
    expect(usage.folders.some((row) => row.name.startsWith("thoughts"))).toBe(false);
    const by = Object.fromEntries(usage.byBucket.map((b) => [b.bucket, b.changes]));
    expect(by).toMatchObject({ product: 1, docs: 41, assets: 1, test: 0 });
    expect(usage.changes).toBe(43);
  });

  it("can look at one repo, and skips a PR whose file list was cut short", async () => {
    const store = setup([[1, ["src/a.ts"]]], [[2, ["web/b.ts", "web/c.ts"]]], true);
    const all = await fileUsage(store, config());
    expect(all.prs).toBe(2);
    expect(all.folders.some((row) => row.name === "src")).toBe(true);
    const web = await fileUsage(store, config(), { repo: "acme/web" });
    expect(web.prs).toBe(1);
    expect(web.folders.map((row) => row.name)).toEqual(["web"]);
    expect(web.extensions.map((row) => row.name)).toEqual([".ts"]);
  });
});
