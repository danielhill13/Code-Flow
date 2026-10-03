import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadWorkspace } from "../config/workspace.ts";
import { Store } from "../store/store.ts";
import { ghPayload } from "../testing/factories.ts";
import { build } from "./build.ts";
import { init } from "./init.ts";

/** Stores one merged PR for the org's repo, as a finished sync would. */
function seed(dbPath: string, repo: string, title: string): void {
  const store = Store.open(dbPath);
  try {
    store.upsertRepo({
      id: `R_${repo}`,
      provider: "github",
      fullName: repo,
      defaultBranch: "main",
      archived: false,
      fork: false,
      private: false,
    });
    const run = store.startRun("sync");
    const payload = ghPayload({ title, url: `https://github.com/${repo}/pull/1` });
    store.savePage(
      `R_${repo}`,
      [{ id: payload.id, number: 1, state: "MERGED", updatedAt: payload.updatedAt, payload }],
      run,
      { coveredSince: "2026-01-01" },
    );
    store.finishRun(run, { status: "ok", calls: 1, points: 1, detail: {} });
  } finally {
    store.close();
  }
}

describe("build, in a workspace of two orgs", () => {
  it("keeps each org's data in its own database and report, naming no other org", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = await mkdtemp(join(tmpdir(), "codeflow-"));
    const config = join(root, "codeflow.yml");
    await init({ config, org: "acme", repo: ["acme-co/api"], since: "2026-01-01" });
    await init({ config, org: "beta", repo: ["beta-inc/web"], since: "2026-01-01" });
    const workspace = await loadWorkspace(config);
    const [acme, beta] = workspace.orgs;
    if (!acme || !beta) throw new Error("expected two orgs");
    expect(acme.dbPath).not.toBe(beta.dbPath);
    seed(acme.dbPath, "acme-co/api", "Acme confidential change");
    seed(beta.dbPath, "beta-inc/web", "Beta confidential change");

    for (const org of [acme, beta]) {
      const out = join(root, `${org.name}.json`);
      expect(await build({ config, org: org.name, out, dataOnly: true })).toBe(0);
    }
    const acmeData = readFileSync(join(root, "acme.json"), "utf8");
    const betaData = readFileSync(join(root, "beta.json"), "utf8");
    expect(JSON.parse(acmeData)).toMatchObject({ org: "acme", repos: ["acme-co/api"] });
    expect(acmeData).toContain("Acme confidential change");
    for (const other of ["beta", "Beta confidential change", "beta-inc"]) {
      expect(acmeData).not.toContain(other);
    }
    for (const other of ["acme", "Acme confidential change"]) expect(betaData).not.toContain(other);
  });
});
