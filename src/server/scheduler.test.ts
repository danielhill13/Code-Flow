import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { init } from "../cli/init.ts";
import type { Org } from "../config/workspace.ts";
import { Store } from "../store/store.ts";
import { Registry } from "./registry.ts";
import { RETRY_MS, Scheduler } from "./scheduler.ts";

const HOUR = 3_600_000;

/** A workspace of two orgs, one synced cleanly at `syncedAt`, one never synced. */
async function workspace(syncedAt: string) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = await mkdtemp(join(tmpdir(), "codeflow-schedule-"));
  const config = join(root, "codeflow.yml");
  await init({ config, org: "acme", repo: ["acme-co/api"], since: "2026-01-01" });
  await init({ config, org: "beta", repo: ["beta-inc/web"], since: "2026-01-01" });
  await writeFile(
    join(root, "orgs/beta/org.yml"),
    `sources:\n  - repo: beta-inc/web\nsince: 2026-01-01\nsync_every: 6h\n`,
  );
  const registry = new Registry(config);
  const [acme] = (await registry.workspace()).orgs;
  if (!acme) throw new Error("no org");
  recordSync(acme, syncedAt);
  return registry;
}

function recordSync(org: Org, at: string): void {
  const store = Store.open(org.dbPath);
  const run = store.startRun("sync", new Date(at));
  store.finishRun(run, { status: "ok", calls: 1, points: 1, detail: {} });
  store.close();
}

describe("Scheduler", () => {
  it("syncs an org that has never synced at once, and each org when its interval has passed", async () => {
    const registry = await workspace("2026-10-01T00:00:00Z");
    let now = Date.parse("2026-10-01T12:00:00Z");
    const synced: string[] = [];
    const scheduler = new Scheduler(registry, {
      now: () => now,
      log: () => {},
      sync: async (org) => {
        synced.push(org.name);
        recordSync(org, new Date(now).toISOString());
        return 0;
      },
    });
    await scheduler.tick();
    expect(synced).toEqual(["beta"]); // acme synced 12 h ago, daily by default
    expect(await scheduler.status("acme")).toMatchObject({
      every: "24h",
      lastSync: "2026-10-01T00:00:00.000Z",
      nextSync: "2026-10-02T00:00:00.000Z",
      running: false,
    });
    now += 12 * HOUR + 1;
    await scheduler.tick();
    expect(synced).toEqual(["beta", "acme", "beta"]); // a day for acme, 6 h for beta
  });

  it("waits before trying a failed sync again, and says what went wrong", async () => {
    const registry = await workspace("2026-09-01T00:00:00Z");
    let now = Date.parse("2026-10-01T12:00:00Z");
    let calls = 0;
    const scheduler = new Scheduler(registry, {
      now: () => now,
      log: () => {},
      sync: async (org) => {
        if (org.name !== "acme") return 0;
        calls += 1;
        throw new Error("GitHub is down");
      },
    });
    await scheduler.tick();
    await scheduler.tick();
    expect(calls).toBe(1);
    expect((await scheduler.status("acme")).lastError).toBe("GitHub is down");
    now += RETRY_MS + 1;
    await scheduler.tick();
    expect(calls).toBe(2);
  });

  it("leaves an org whose schedule is off alone", async () => {
    const registry = await workspace("2026-01-01T00:00:00Z");
    const [acme] = (await registry.workspace()).orgs;
    if (!acme) throw new Error("no org");
    await writeFile(
      acme.files.org,
      `sources:\n  - repo: acme-co/api\nsince: 2026-01-01\nsync_every: off\n`,
    );
    const synced: string[] = [];
    const scheduler = new Scheduler(registry, {
      log: () => {},
      sync: async (org) => {
        synced.push(org.name);
        return 0;
      },
    });
    await scheduler.tick();
    expect(synced).toEqual(["beta"]);
    expect((await scheduler.status("acme")).nextSync).toBeNull();
  });
});
